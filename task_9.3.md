# Техническое Задание (ТЗ): 9.3 Внедрение в "Быстрый Цикл" (FastCycle Integration)

**Эпик:** 9. 🚦 Контроль Конкурентности и Блокировок **Задача:** 9.3 Внедрение в "Быстрый Цикл" (FastCycle Integration) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Модифицировать сервисы "Быстрого Цикла" (WebSocket) — `TSLHandlerService` (Задача 5.4) и `PriceTriggerHandler` (Задача 5.5) — для использования `PairActorManagerService`.

Это гарантирует, что операции, инициированные WebSocket (обновление TSL, вызов LLM), будут безопасно "становиться в очередь" за операциями "Медленного Цикла" (Сверка) или другими операциями "Быстрого Цикла", предотвращая "гонки состояний".

**Критическое Требование:** Вызовы `pairActorManager.execute` **не должны** блокировать (через `await`) родительский обработчик WebSocket (`onTickerData`).

## 2\. Зависимости Задачи

- **`PairActorManagerService` (9.1):** (Зависимость) Предоставляет метод `execute`.
- **`TSLHandlerService` (5.4):** (Потребитель) Сервис, логика которого будет обернута.
- **`PriceTriggerHandler` (5.5):** (Потребитель) Сервис, логика которого будет обернута.
- **`FastCycleService` (5.3):** (Инициатор) Сервис, который вызывает `TSLHandler` и `PriceTriggerHandler`.

## 3\. Описание и Нюансы Реализации

### 3.1. Модификация `TSLHandlerService` (Задача 5.4)

`TSLHandlerService` отвечает за перемещение Trailing Stop Loss при новом пике цены.

1.  **Внедрение (DI):** `TSLHandlerService` должен получить `PairActorManagerService` (через `getInstance()` или DI).
2.  **Модификация `handleTicker(ticker)` (псевдокод):**

        // src/services/TSLHandlerService.ts

        // ... (импорты)
        import { PairActorManagerService } from './PairActorManagerService';

        export class TSLHandlerService {
            private readonly pairActorManager = PairActorManagerService.getInstance();
            private readonly logger = LoggingService.getInstance().getLogger('[TSLHandler]');
            // ... (другие зависимости: DatabaseService, ExchangeService)

            /**
             * (Приватный метод) Внутренняя логика обновления TSL.
             * Выполняется *внутри* "актора".
             */
            private async _internalUpdateTSL(pair: string, newStopPrice: Decimal, tslState: TSL_State): Promise<void> {
                this.logger.info(`[${pair}] [TSL] Обновление SL. Старая цена: ${tslState.currentStopPrice}, Новая цена: ${newStopPrice}`);

                // ... (Вся логика из Задачи 5.4)
                // 1. await this.exchangeService.cancelOrderWithRetry(tslState.currentStopOrderId)
                // 2. const newOrder = await this.exchangeService.createOrderWithRetry(...)
                // 3. await this.db.executeInTransaction(async (client) => {
                //      ... (UPDATE TSL_State, UPDATE ActiveOrders)
                //    })

                this.logger.info(`[${pair}] [TSL] Обновление SL завершено.`);
            }

            /**
             * (Публичный метод) Обрабатывает тик от FastCycleService.
             */
            public handleTicker(ticker: Ticker, tslState: TSL_State): void {
                if (GlobalStateService.getInstance().isPaused()) return;

                // ... (Логика расчета newStopPrice из Задачи 5.4)
                // const needsUpdate = (newStopPrice > tslState.currentStopPrice);

                if (needsUpdate) {
                    const pair = ticker.symbol;

                    // (Критично) ВЫЗЫВАЕМ БЕЗ AWAIT
                    // Мы не блокируем WebSocket-цикл.
                    this.pairActorManager.execute(pair, () =>
                        this._internalUpdateTSL(pair, newStopPrice, tslState)
                    )
                    .catch((error) => {
                        // (Критично) Ловим ошибку из "отсоединенного" Promise,
                        // чтобы предотвратить UnhandledPromiseRejection.
                        this.logger.error(`[${pair}] [TSL] КРИТИЧЕСКАЯ ОШИБКА в 'execute': ${error.message}`);
                        // (Рекомендуется) Отправить PUSH-уведомление
                        // NotificationService.getInstance().sendAlert(...)
                    });
                }
            }
        }

### 3.2. Модификация `PriceTriggerHandler` (Задача 5.5)

`PriceTriggerHandler` отвечает за запуск вызова LLM при срабатывании ценового триггера.

1.  **Внедрение (DI):** `PriceTriggerHandler` должен получить `PairActorManagerService`.
2.  **Модификация `handleTicker(ticker)` (псевдокод):**

        // src/services/PriceTriggerHandler.ts

        // ... (импорты)
        import { PairActorManagerService } from './PairActorManagerService';

        export class PriceTriggerHandler {
            private readonly pairActorManager = PairActorManagerService.getInstance();
            private readonly logger = LoggingService.getInstance().getLogger('[PriceTrigger]');
            private readonly watcherOrchestrator = WatcherOrchestrator.getInstance(); // (будет создан)
            private readonly accountState = AccountStateService.getInstance();
            // ...

            /**
             * (Публичный метод) Обрабатывает тик от FastCycleService.
             */
            public handleTicker(ticker: Ticker, triggers: PriceTrigger[]): void {
                if (GlobalStateService.getInstance().isPaused()) return;

                const pair = ticker.symbol;

                // ... (Логика поиска сработавшего `priceTrigger` из Задачи 5.5)
                const triggerHit = ...;

                if (triggerHit) {
                    // (Логика из 5.5) Проверка на наличие `OPEN_LIMIT`
                    const accountState = this.accountState.getAccountState();
                    const hasOpenLimit = accountState.open_orders.find(o => o.pair === pair && o.type === 'limit_open');

                    if (hasOpenLimit) {
                        this.logger.debug(`[${pair}] [PriceTrigger] Триггер цены ${triggerHit.value} проигнорирован из-за активного OPEN_LIMIT ордера. SyncEngine обработает его.`);
                        return;
                    }

                    this.logger.info(`[${pair}] [PriceTrigger] Сработал триггер цены: ${triggerHit.value}. Запускаем вызов LLM...`);

                    // (Критично) ВЫЗЫВАЕМ БЕЗ AWAIT
                    this.pairActorManager.execute(pair, () =>
                        // (Задача 5.5) Вызов WatcherOrchestrator
                        this.watcherOrchestrator.executeLLMCall(pair, `Price Trigger Hit: ${triggerHit.value}`)
                    )
                    .catch((error) => {
                        // (Критично) Ловим ошибку из "отсоединенного" Promise.
                        this.logger.error(`[${pair}] [PriceTrigger] КРИТИЧЕСКАЯ ОШИБКА в 'execute' (LLM Call): ${error.message}`);
                        // (Рекомендуется) Отправить PUSH-уведомление
                    });
                }
            }
        }

## 4\. Критерии Приемки (Acceptance Criteria)

1.  **\[TSLHandler\]** `TSLHandlerService` внедряет `PairActorManagerService`.
2.  **\[TSLHandler (Критично)\]** Вызов `pairActorManager.execute` для обновления TSL (Задача 5.4) выполняется **БЕЗ** `await`, чтобы не блокировать цикл WS.
3.  **\[TSLHandler\]** "Отсоединенный" `Promise` от `execute` имеет обработчик `.catch()` для логирования ошибок.
4.  **\[PriceTriggerHandler\]** `PriceTriggerHandler` внедряет `PairActorManagerService`.
5.  **\[PriceTriggerHandler (Критично)\]** Вызов `pairActorManager.execute` для запуска `WatcherOrchestrator.executeLLMCall` (Задача 5.5) выполняется **БЕЗ** `await`.
6.  **\[PriceTriggerHandler\]** "Отсоединенный" `Promise` от `execute` имеет обработчик `.catch()` для логирования ошибок.
