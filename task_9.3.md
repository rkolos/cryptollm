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
            public handleTicker(ticker: Ticker, tslRule: TSLRule): void {
                try {
                    // ... (Логика расчета newStopPrice из Задачи 5.4 через _calculateTSL)
                    const currentPrice = new DecimalConstructor(ticker.last.toString());
                    const requiredUpdate = this._calculateTSL(tslRule, currentPrice);

                    if (requiredUpdate) {
                        const pair = ticker.symbol;
                        this.logger.info(
                            `(TSLHandler) [${pair}] TSL UPDATE: Цена ${currentPrice.toString()}. Двигаем SL с ${tslRule.state.currentStopPrice.toString()} на ${requiredUpdate.newStopPrice.toString()}`,
                        );

                        // (Задача 9.3) Вызов "Актора" (Fire-and-Forget)
                        this.pairActorManager
                            .execute(pair, async () => {
                                await this._updateStopLossOrder(pair, tslRule, requiredUpdate.newStopPrice, currentPrice);
                            })
                            .catch((e) => {
                                // (Критично) Ловим ошибку из "отсоединенного" Promise,
                                // чтобы предотвратить UnhandledPromiseRejection.
                                this.logger.error(`(TSLHandler) [${pair}] КРИТИЧЕСКАЯ ОШИБКА в акторе: ${String(e)}`, e);
                            });
                    }
                } catch (error) {
                    this.logger.error(`(TSLHandler) [${ticker.symbol}] КРИТИЧЕСКИЙ СБОЙ: ${String(error)}`, error);
                    // Не бросаем ошибку, чтобы не "убить" WS-цикл
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
            public handleTicker(ticker: Ticker, triggers: LLMTriggerCondition[]): void {
                try {
                    const pair = ticker.symbol;
                    const currentPrice = new DecimalConstructor(ticker.last.toString());

                    // ... (Логика поиска сработавшего `priceTrigger` из Задачи 5.5 через _findPriceTrigger)
                    const triggeredCondition = this._findPriceTrigger(triggers, currentPrice);

                    if (triggeredCondition) {
                        // (Логика из 5.5) Проверка на наличие `OPEN_LIMIT`
                        const accountState = this.accountStateService.getAccountState();
                        const hasOpenLimit = accountState.open_orders.find(
                            (o) => o.pair === pair && (o.type === 'limit_open' || o.type === 'limit'),
                        );

                        if (hasOpenLimit) {
                            this.logger.debug(
                                `(PriceHandler) [${pair}] Price trigger ${triggeredCondition.value} проигнорирован из-за активного LIMIT ордера. SyncEngine обработает его.`,
                            );
                            return;
                        }

                        // "Предохранитель" не сработал, передаем управление Оркестратору
                        this.logger.info(
                            `(PriceHandler) [${pair}] Price trigger hit: ${currentPrice.toString()} ${triggeredCondition.condition} ${triggeredCondition.value}. Calling Orchestrator.`,
                        );

                        // (Задача 9.3) Вызов "Актора" (Fire-and-Forget)
                        this.pairActorManager
                            .execute(pair, async () => {
                                await this.orchestrator.executeOrchestration(pair, 'Price Trigger Hit');
                            })
                            .catch((e) => {
                                // (Критично) Ловим ошибку из "отсоединенного" Promise.
                                this.logger.error(`(PriceHandler) [${pair}] КРИТИЧЕСКАЯ ОШИБКА в акторе: ${String(e)}`, e);
                            });
                    }
                } catch (error) {
                    this.logger.error(`(PriceHandler) [${ticker.symbol}] КРИТИЧЕСКИЙ СБОЙ: ${String(error)}`, error);
                    // Не бросаем ошибку, чтобы не "убить" WS-цикл
                }
            }
        }

## 4\. Критерии Приемки (Acceptance Criteria)

1.  **\[TSLHandler\]** `TSLHandlerService` внедряет `PairActorManagerService` через DI (конструктор принимает `pairActorManager: PairActorManagerService`).
2.  **\[TSLHandler (Критично)\]** Вызов `pairActorManager.execute` для обновления TSL (через `_updateStopLossOrder`) выполняется **БЕЗ** `await`, чтобы не блокировать цикл WS (fire-and-forget).
3.  **\[TSLHandler\]** "Отсоединенный" `Promise` от `execute` имеет обработчик `.catch()` для логирования ошибок (`logger.error`). Весь метод `handleTicker` обернут в `try/catch` для предотвращения "убийства" WS-цикла.
4.  **\[PriceTriggerHandler\]** `PriceTriggerHandler` внедряет `PairActorManagerService` через DI (конструктор принимает `pairActorManager: PairActorManagerService`).
5.  **\[PriceTriggerHandler (Критично)\]** Вызов `pairActorManager.execute` для запуска `orchestrator.executeOrchestration(pair, 'Price Trigger Hit')` выполняется **БЕЗ** `await` (fire-and-forget).
6.  **\[PriceTriggerHandler\]** "Отсоединенный" `Promise` от `execute` имеет обработчик `.catch()` для логирования ошибок (`logger.error`). Весь метод `handleTicker` обернут в `try/catch` для предотвращения "убийства" WS-цикла.
7.  **\[PriceTriggerHandler\]** Логика проверяет наличие открытого LIMIT ордера (`limit_open` или `limit`) через `accountState.open_orders` перед вызовом оркестратора.
