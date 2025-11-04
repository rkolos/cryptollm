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
              this.logger.debug(`[${pair}] (SyncEngine) Задача на сверку [${pair}] добавлена в очередь...`);

              // (Критично - Задача 9.2) Оборачиваем всю логику в execute
              await this.pairActorManager.execute(pair, async () => {
                  this.logger.info(`[${pair}] (SyncEngine) Сверка [${pair}] ЗАПУЩЕНА.`);

                  // Получаем "сырые" данные о состоянии параллельно через Promise.allSettled
                  const results = await Promise.allSettled([
                      this.exchangeService.fetchOpenOrders(pair),
                      this.databaseService.query('SELECT * FROM ActiveOrders WHERE pair = $1', [pair]),
                      this.databaseService.query('SELECT * FROM ActivePositions WHERE pair = $1', [pair]),
                      this.exchangeService.fetchBalance(),
                  ]);

                  // ... (Вся логика сверки из Задач 5.1, 5.1.1, 5.1.2)
                  // Обработка ошибок и сверка ордеров/позиций
              });
          }

          /**
           * (Публичный метод) Выполняет сверку для *всех* пар в watchlist.
           * Вызывается из SlowCycleService.
           */
          public async reconcileStateAll(): Promise<void> {
              const watchlist = this.configService.getWatchlist();
              this.logger.info(`Запуск плановой сверки для ${watchlist.length} пар...`);

              // Используем for...of для последовательного выполнения,
              // чтобы распределить нагрузку на API биржи во времени.
              // Добавляем таймаут для каждой пары, чтобы зависание одной пары не блокировало остальные
              for (const pair of watchlist) {
                  // Добавляем задержку между парами, чтобы не перегружать API (500ms между парами)
                  if (watchlist.indexOf(pair) > 0) {
                      await new Promise((resolve) => setTimeout(resolve, 500));
                  }
                  try {
                      // Таймаут 60 секунд на пару - если сверка зависла или ждет слишком долго, пропускаем
                      const reconcilePromise = this.reconcileStateForPair(pair);
                      const timeoutPromise = new Promise<void>((_, reject) => {
                          setTimeout(() => {
                              reject(new Error(`Таймаут сверки для пары ${pair} (60 секунд)`));
                          }, 60000); // 60 секунд на пару
                      });

                      await Promise.race([reconcilePromise, timeoutPromise]);
                  } catch (error) {
                      const errorMessage = error instanceof Error ? error.message : String(error);
                      if (errorMessage.includes('Таймаут')) {
                          this.logger.warn(`[${pair}] Сверка превысила таймаут (60s). Пропускаем эту пару.`);
                      } else {
                          this.logger.error(`[${pair}] Ошибка при сверке:`, error);
                      }
                      // Продолжаем со следующей парой
                  }
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

              const accountState = this.accountStateService.getAccountState();
              const activePositions = accountState.open_positions || [];

              for (const position of activePositions) {
                  const pair = position.pair;
                  const slPrice = new DecimalConstructor(position.stop_loss_price.toString());

                  // (Критично) Получаем *реальную* текущую цену из MarketDataService
                  const ticker = await this.exchangeService.fetchTicker(pair);
                  if (!ticker) continue;

                  const currentPrice = new DecimalConstructor(ticker.last.toString());

                  let isSlBreached = false;
                  if (position.side === 'long' && currentPrice.lessThan(slPrice)) {
                      isSlBreached = true;
                  } else if (position.side === 'short' && currentPrice.greaterThan(slPrice)) {
                      isSlBreached = true;
                  }

                  // Проверяем наличие открытого SL ордера
                  const openOrders = await this.exchangeService.fetchOpenOrders(pair);
                  const hasOpenSlOrder = openOrders.some((order) => {
                      // Проверка на stop_loss_limit ордер
                      return order.type === 'stop_loss_limit' || order.info?.type === 'STOP_LOSS_LIMIT';
                  });

                  if (isSlBreached && !hasOpenSlOrder) {
                      this.logger.error(
                          `(StopLossJanitor) [${pair}] ФАТАЛЬНАЯ ОШИБКА: Цена ${currentPrice.toString()} ПРОБИЛА SL ${slPrice.toString()}, но позиция НЕ ЗАКРЫТА! Запуск принудительного закрытия.`,
                      );

                      // (Критично) Вызываем pairActorManager.execute БЕЗ await (fire-and-forget)
                      this.pairActorManager
                          .execute(pair, async () => {
                              await this.notificationService.sendAlert(
                                  `[${pair}] ФАТАЛЬНАЯ ОШИБКА Stop-Loss Janitor: Цена ${currentPrice.toString()} пробила SL ${slPrice.toString()}, но позиция не закрыта! Принудительное закрытие.`,
                                  true,
                              );

                              // Создаем решение для принудительного закрытия
                              const closeDecision = {
                                  action: 'CLOSE_POSITION' as const,
                                  pair: pair,
                                  parameters: {
                                      type: 'market' as const,
                                      amount_percent: 100,
                                  },
                                  justification: 'Принудительное закрытие из-за пробития Stop-Loss (Stop-Loss Janitor)',
                              };

                              // Подготовка данных для WorkerService
                              const accountStateForWorker = this.accountStateService.getAccountState();
                              const riskRules = this.configService.getRiskRules();
                              const strategyContext = {
                                  risk_rules: {
                                      default_risk_per_trade_percent: riskRules.defaultRiskPercent,
                                      max_allowed_risk_per_trade_percent: riskRules.maxAllowedRiskPercent,
                                      max_total_portfolio_risk_percent: riskRules.maxTotalPortfolioRiskPercent,
                                      desired_risk_reward_ratio: riskRules.desiredRiskRewardRatio,
                                  },
                              };
                              const tickerForWorker = await this.exchangeService.fetchTicker(pair);
                              const marketData = {
                                  pair: pair,
                                  current_price: tickerForWorker.last,
                              };

                              // Вызываем workerService.execute (llmLogId пустой для Stop-Loss Janitor)
                              await this.workerService.execute(closeDecision, '', accountStateForWorker, strategyContext, marketData);
                          })
                          .catch((actorError) => {
                              this.logger.error(
                                  `(StopLossJanitor) [${pair}] Ошибка в акторе при принудительном закрытии:`,
                                  actorError,
                              );
                              // (Критично) Паузим бота при ошибке
                              this.globalStateService.pause();
                              this.notificationService.sendAlert(`FATAL [${pair}]: StopLossJanitor FAILED. PAUSING BOT.`, true);
                          });
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

1.  **\[SyncEngine\]** `SyncEngineService` внедряет `PairActorManagerService` через DI (конструктор принимает `pairActorManager: PairActorManagerService`).
2.  **\[SyncEngine (Критично)\]** Публичный метод `reconcileStateForPair(pair)` **обертывает** всю свою внутреннюю логику (5.1, 5.1.1, 5.1.2) в `await pairActorManager.execute(pair, async () => { ... })`. Логика получает данные параллельно через `Promise.allSettled` для `fetchOpenOrders`, `query ActiveOrders`, `query ActivePositions`, `fetchBalance`.
3.  **\[SyncEngine\]** Метод `reconcileStateAll()` получает watchlist через `configService.getWatchlist()`, вызывает `reconcileStateForPair()` _в цикле_ с задержкой 500ms между парами и использует `Promise.race` с таймаутом 60 секунд на пару для предотвращения зависания.
4.  **\[StopLossJanitor\]** `SlowCycleService` внедряет `PairActorManagerService` через DI (конструктор принимает `pairActorManager: PairActorManagerService`).
5.  **\[StopLossJanitor (Критично)\]** Логика аварийного закрытия позиции (вызов `WorkerService.execute` и `NotificationService.sendAlert`) **обернута** в `pairActorManager.execute(position.pair, async () => { ... })` **БЕЗ** `await` (fire-and-forget) с обработкой ошибок через `.catch()`.
6.  **\[StopLossJanitor\]** Логика проверяет наличие открытого SL ордера через `fetchOpenOrders` перед принудительным закрытием.
7.  **\[StopLossJanitor\]** При ошибке в акторе `SlowCycleService` вызывает `globalStateService.pause()` и отправляет уведомление.
