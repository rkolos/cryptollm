# Техническое Задание (ТЗ): 9.2 Внедрение в "Медленный Цикл" (SlowCycle Integration)

**Эпик:** 9. 🚦 Контроль Конкурентности и Блокировок **Задача:** 9.2 Внедрение в "Медленный Цикл" (SlowCycle Integration) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Модифицировать сервисы "Медленного Цикла" (`SyncEngineService` и `StopLossJanitor` / `SlowCycleService`) для использования `PairActorManagerService`.

Все операции, которые читают/пишут состояние _конкретной пары_ (сверка ордеров, аварийное закрытие SL), должны быть обернуты в `pairActorManager.execute(pair, ...)` для предотвращения "гонок состояний".

## 2\. Зависимости Задачи

- **`PairActorManagerService` (9.1):** (Зависимость) Предоставляет метод `execute`.
- **`SyncEngineService` (5.0, 5.1.x):** (Потребитель) Сервис, логика которого будет обернута.
- **`SlowCycleService` / `StopLossJanitor` (5.2.1):** (Потребитель) Сервис, логика которого будет обернута.

## 3\. Описание и Нюансы Реализации

### 3.1. Модификация `SyncEngineService` (Задачи 5.0, 5.1, 5.1.1, 5.1.2)

`SyncEngineService` отвечает за сверку состояния (ордера, позиции) между БД и биржей.

1.  **Внедрение (DI):** `SyncEngineService` должен получить `PairActorManagerService` (через `getInstance()` или DI-контейнер).
2.  **Модификация `reconcileStateForPair(pair)`:**
    - Этот метод (определенный в Задаче 5.0) **не должен** больше содержать `try...catch` верхнего уровня. Вся его логика (сверка ордеров (5.1), "судебная" сверка (5.1.1), обработка `OPEN_LIMIT` (5.1.2)) должна быть **внутренней**.
    - **Вместо этого** `reconcileStateForPair(pair)` становится "оберткой", которая вызывает `PairActorManager`:

      // src/services/SyncEngineService.ts

      // ... (импорты)
      import { PairActorManagerService } from './PairActorManagerService';
      import { LoggingService } from './LoggingService';

      export class SyncEngineService {
      private readonly pairActorManager = PairActorManagerService.getInstance();
      private readonly logger = LoggingService.getInstance().getLogger('[SyncEngine]');
      // ... (другие зависимости)

          /**
           * (Приватный метод) Внутренняя логика сверки.
           * Выполняется *внутри* "актора".
           */
          private async _internalReconcile(pair: string): Promise<void> {
              this.logger.debug(`[${pair}] Запуск сверки...`);

              // ... (Вся логика из Задач 5.1, 5.1.1, 5.1.2)
              // 1. Сверка "Зомби / Офлайн" ордеров (5.1)
              // 2. "Судебная" сверка позиций (5.1.1)
              // 3. Обработка исполненных OPEN_LIMIT (5.1.2)

              this.logger.debug(`[${pair}] Сверка завершена.`);
          }

          /**
           * (Публичный метод) Вызывает сверку состояния для пары
           * *внутри* защищенной очереди (актора).
           */
          public async reconcileStateForPair(pair: string): Promise<void> {
              try {
                  // (Критично) Оборачиваем вызов в execute
                  await this.pairActorManager.execute(pair, () => this._internalReconcile(pair));
              } catch (error) {
                  // Ошибка уже в _internalReconcile
                  this.logger.error(`[${pair}] КРИТИЧЕСКАЯ ОШИБКА во время сверки: ${error.message}`);
                  // Ошибка не пробрасывается дальше,
                  // чтобы не остановить `reconcileStateAll`
              }
          }

          /**
           * (Публичный метод) Выполняет сверку для *всех* пар в watchlist.
           * Вызывается из SlowCycleService.
           */
          public async reconcileStateAll(watchlist: string[]): Promise<void> {
              this.logger.info(`Запуск плановой сверки для ${watchlist.length} пар...`);

              // (Критично) Мы `await` каждую сверку.
              // Это гарантирует, что `SlowCycle` не запустит
              // следующую итерацию `reconcileStateAll`, пока
              // текущая не завершена.
              for (const pair of watchlist) {
                  await this.reconcileStateForPair(pair);
              }

              this.logger.info("Плановая сверка завершена.");
          }

      }

### 3.2. Модификация `SlowCycleService` (Логика `StopLossJanitor` - Задача 5.2.1)

`StopLossJanitor` — это "аварийный" механизм, который проверяет, не "завис" ли SL-ордер, если цена уже упала ниже него.

1.  **Внедрение (DI):** `SlowCycleService` должен получить `PairActorManagerService`.
2.  **Модификация `runSlowCycle()` (псевдокод):**
    - Логика `StopLossJanitor` (5.2.1) находится внутри `SlowCycleService` и выполняется _после_ `reconcileStateAll()`.

      // src/services/SlowCycleService.ts

      // ... (импорты)
      import { PairActorManagerService } from './PairActorManagerService';
      // ...

      export class SlowCycleService {
      private readonly pairActorManager = PairActorManagerService.getInstance();
      private readonly globalState = GlobalStateService.getInstance();
      private readonly accountState = AccountStateService.getInstance();
      private readonly workerService = WorkerService.getInstance(); // (будет создан)
      private readonly notificationService = NotificationService.getInstance(); // (будет создан)
      // ...

          private async runStopLossJanitor(): Promise<void> {
              this.logger.info("Запуск [StopLossJanitor]...");

              const state = this.accountState.getAccountState(); // (из 4.5)
              const activePositions = state.open_positions || [];

              for (const position of activePositions) {
                  const pair = position.pair;
                  const slPrice = new Decimal(position.stop_loss_price);

                  // (Критично) Получаем *реальную* текущую цену
                  const ticker = this.fastCycleService.getTicker(pair);
                  if (!ticker) continue;

                  const currentPrice = new Decimal(ticker.last);

                  let isSlBreached = false;
                  if (position.side === 'long' && currentPrice.lessThan(slPrice)) {
                      isSlBreached = true;
                  }
                  // ... (логика для 'short')

                  if (isSlBreached) {
                      this.logger.fatal(`[${pair}] [StopLossJanitor] ОБНАРУЖЕНО ПРОБИТИЕ SL! Цена: ${currentPrice}, SL: ${slPrice}. Запускаем аварийное закрытие...`);

                      try {
                          // (Критично) Оборачиваем вызов Worker'a в execute
                          // Мы `await`, чтобы заблокировать `SlowCycle`
                          // до завершения аварийного закрытия.
                          await this.pairActorManager.execute(pair, async () => {
                              // (Задача 5.2.1)
                              // 1. Отправляем PUSH
                              await this.notificationService.sendAlert(`FATAL [${pair}]: StopLossJanitor! Breach detected! Closing position.`, true);

                              // 2. Вызываем Worker'a напрямую
                              // (Мы не можем ждать LLM)
                              const decision: CloseDecision = {
                                  action: 'CLOSE_POSITION',
                                  pair: pair,
                                  parameters: {
                                      type: 'market',
                                      amount_percent: 100
                                  }
                              };

                              // Вызываем Worker (без LLM Log ID)
                              await this.workerService.execute(decision, null);
                          });

                          this.logger.info(`[${pair}] [StopLossJanitor] Аварийное закрытие завершено.`);

                      } catch (error) {
                          this.logger.error(`[${pair}] [StopLossJanitor] Ошибка аварийного закрытия: ${error.message}`);
                          // (Критично) Паузим бота
                          await this.globalState.pause();
                          await this.notificationService.sendAlert(`FATAL [${pair}]: StopLossJanitor FAILED. PAUSING BOT.`, true);
                      }
                  }
              }
          }

          // ... (логика `start()` и `runSlowCycle()`)
          // public async runSlowCycle() {
          //   ...
          //   await this.syncEngine.reconcileStateAll(...);
          //   await this.runStopLossJanitor();
          //   ...
          // }

      }

## 4\. Критерии Приемки (Acceptance Criteria)

1.  **\[SyncEngine\]** `SyncEngineService` внедряет `PairActorManagerService`.
2.  **\[SyncEngine (Критично)\]** Публичный метод `reconcileStateForPair(pair)` **обертывает** всю свою внутреннюю логику (5.1, 5.1.1, 5.1.2) в `pairActorManager.execute()`.
3.  **\[SyncEngine\]** Метод `reconcileStateAll()` вызывает `await reconcileStateForPair()` _в цикле_ (сериализованно по парам).
4.  **\[StopLossJanitor\]** `SlowCycleService` (или где реализован "Janitor") внедряет `PairActorManagerService`.
5.  **\[StopLossJanitor (Критично)\]** Логика аварийного закрытия позиции (вызов `WorkerService.execute` и `NotificationService.sendAlert`) **обернута** в `pairActorManager.execute(position.pair, ...)`.
6.  **\[await\]** Все вызовы `pairActorManager.execute` в "Медленном Цикле" используются с `await`, чтобы блокировать цикл до завершения задачи.
