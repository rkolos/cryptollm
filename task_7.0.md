# Техническое Задание (ТЗ): 7.0 Сервис Гарантированного Исполнения (GuaranteedOrderExecutionService)

**Эпик:** 7. 👷 "Исполнитель" (Worker Service) **Задача:** 7.0 Сервис Гарантированного Исполнения (DRY) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать `GuaranteedOrderExecutionService` (Singleton) — отказоустойчивую обертку над `IExchangeService`. Этот сервис инкапсулирует сложную, но критически важную логику обработки сетевых ошибок (`NetworkError`, `RequestTimeout`) и гарантирует **идемпотентность** (предотвращение дублирования) ордеров с помощью `clientOrderId`.

Этот сервис будет использоваться `WorkerService` (Задача 7.1) и `TSLHandlerService` (Задача 5.4).

## 2\. Зависимости Задачи

- **`crypto` (Node.js):** (Зависимость) Для генерации `crypto.randomUUID()`.
- **`IExchangeService` (Интерфейс из 3.1):** (Зависимость) Целевой сервис (Mock или Production).
- **`LoggingService` (1.4):** (Зависимость) Для логирования.
- **`ccxt` (1.2):** (Зависимость) Для импорта типов ошибок (e.g., `ccxt.NetworkError`, `ccxt.RequestTimeout`, `ccxt.OrderNotFound`).

## 3\. Описание и Нюансы Реализации

### 3.1. Создание `src/services/GuaranteedOrderExecutionService.ts`

Этот сервис будет управлять `IExchangeService` и логикой retry.

    // src/services/GuaranteedOrderExecutionService.ts (Новый Файл)

    import crypto from 'crypto';
    import ccxt, { Order } from 'ccxt';
    import { LoggingService } from './LoggingService';
    import { IExchangeService } from '../interfaces/IExchangeService';
    import { OrderSide, OrderType } from '../interfaces';
    import { Decimal } from 'decimal.js';

    // (Константы для логики Retry)
    const RETRY_ATTEMPTS = 3;
    const RETRY_DELAY_MS = 2000; // (2 секунды)

    export class GuaranteedOrderExecutionService {
        private static instance: GuaranteedOrderExecutionService;
        private logger: LoggingService;
        private exchangeService: IExchangeService | null = null;

        private constructor() {
            this.logger = LoggingService.getInstance();
            this.logger.registerContext("GuaranteedExecution");
        }

        public static getInstance(): GuaranteedOrderExecutionService {
            if (!GuaranteedOrderExecutionService.instance) {
                GuaranteedOrderExecutionService.instance = new GuaranteedOrderExecutionService();
            }
            return GuaranteedOrderExecutionService.instance;
        }

        /**
         * (Вызывается 1 раз при старте - см. Задачу 8.1)
         * Внедряет "боевой" или "mock" IExchangeService.
         */
        public initialize(exchangeService: IExchangeService): void {
            this.logger.info("Инициализация...");
            this.exchangeService = exchangeService;
        }

        /**
         * (Вспомогательный) Обеспечивает паузу
         */
        private async sleep(ms: number): Promise<void> {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        /**
         * Создает ордер с гарантией идемпотентности и проверкой NetworkError.
         */
        public async createOrderWithRetry(
            pair: string,
            type: OrderType,
            side: OrderSide,
            amount: Decimal,
            price?: Decimal
        ): Promise<Order> {
            if (!this.exchangeService) {
                throw new Error("GuaranteedOrderExecutionService не инициализирован.");
            }

            // (Задача 7.0 - Идемпотентность)
            const clientOrderId = `llm-trader-${crypto.randomUUID()}`;

            try {
                // --- Попытка 1: Создание ордера ---
                this.logger.debug(`[${pair}] Попытка создания ${side} ${type} ордера (Client ID: ${clientOrderId.substring(11, 19)})...`);

                return await this.exchangeService.createOrder(
                    pair,
                    type,
                    side,
                    amount,
                    price,
                    clientOrderId // (Передаем clientOrderId)
                );

            } catch (error: any) {
                // (Критично) Ошибка НЕ связана с сетью.
                // (e.g., InsufficientFunds, InvalidOrder, ExchangeError)
                // Мы должны НЕМЕДЛЕННО "провалить" операцию.
                if (!(error instanceof ccxt.NetworkError || error instanceof ccxt.RequestTimeout)) {
                    this.logger.error(`[${pair}] НЕ-сетевая ошибка при создании ордера: ${error.message}`);
                    throw error; // (Пробрасываем ошибку выше, e.g., в WorkerService)
                }

                // --- Попытка 2: Логика Retry (только для NetworkError) ---
                this.logger.warn(`[${pair}] NetworkError/Timeout при создании ордера (ID: ${clientOrderId.substring(11, 19)}). Запуск проверки статуса (Retry-Logic)...`);

                for (let i = 1; i <= RETRY_ATTEMPTS; i++) {
                    await this.sleep(RETRY_DELAY_MS * i); // (Exponential backoff)
                    this.logger.warn(`[${pair}] Попытка ${i}/${RETRY_ATTEMPTS}: Проверка статуса ордера (fetchOrder by Client ID)...`);

                    try {
                        const order = await this.exchangeService.fetchOrder(clientOrderId, pair);
                        // (УСПЕХ) Ордер был создан, биржа вернула его.
                        this.logger.warn(`[${pair}] (Успех Retry) Ордер ${order.id} подтвержден.`);
                        return order;
                    } catch (fetchError: any) {
                        // (Провал) Ордер не найден (OrderNotFound) или снова NetworkError.
                        this.logger.error(`[${pair}] (Провал Retry ${i}) ${fetchError.message}`);
                    }
                }

                // (Критично) Мы не смогли ни создать, ни найти ордер.
                const fatalError = new Error(`[FATAL] Не удалось подтвердить статус ордера ${clientOrderId} для ${pair} после ${RETRY_ATTEMPTS} попыток.`);
                this.logger.fatal(fatalError.message);
                throw fatalError;
            }
        }

        /**
         * Отменяет ордер с проверкой NetworkError.
         */
        public async cancelOrderWithRetry(orderId: string, pair: string): Promise<void> {
            if (!this.exchangeService) {
                throw new Error("GuaranteedOrderExecutionService не инициализирован.");
            }

            try {
                // --- Попытка 1: Отмена ордера ---
                this.logger.debug(`[${pair}] Попытка отмены ордера ${orderId}...`);
                await this.exchangeService.cancelOrder(orderId, pair);
                this.logger.info(`[${pair}] Ордер ${orderId} успешно отменен (попытка 1).`);
                return;

            } catch (error: any) {
                // (Хорошие новости) Ордер уже "исчез" (исполнен или отменен).
                // Это НЕ ошибка.
                if (error instanceof ccxt.OrderNotFound) {
                    this.logger.info(`[${pair}] Ордер ${orderId} не найден при отмене (уже исполнен/отменен).`);
                    return; // (Успешное завершение)
                }

                // (Плохие новости) Ошибка НЕ связана с сетью.
                if (!(error instanceof ccxt.NetworkError || error instanceof ccxt.RequestTimeout)) {
                    this.logger.error(`[${pair}] НЕ-сетевая ошибка при отмене ордера ${orderId}: ${error.message}`);
                    throw error; // (Пробрасываем выше)
                }

                // --- Попытка 2: Логика Retry (только для NetworkError) ---
                this.logger.warn(`[${pair}] NetworkError/Timeout при отмене ордера ${orderId}. Запуск проверки статуса (Retry-Logic)...`);

                for (let i = 1; i <= RETRY_ATTEMPTS; i++) {
                    await this.sleep(RETRY_DELAY_MS * i);
                    this.logger.warn(`[${pair}] Попытка ${i}/${RETRY_ATTEMPTS}: Проверка статуса ордера (fetchOrder by ID)...`);

                    try {
                        const order = await this.exchangeService.fetchOrder(orderId, pair);
                        if (order.status === 'canceled' || order.status === 'closed') {
                            // (УСПЕХ) Ордер отменен или исполнен.
                            this.logger.warn(`[${pair}] (Успех Retry) Статус ордера ${order.id} подтвержден: ${order.status}.`);
                            return;
                        }
                        // (Провал) Ордер все еще 'open'.
                        this.logger.error(`[${pair}] (Провал Retry ${i}) Ордер ${orderId} все еще 'open'.`);

                    } catch (fetchError: any) {
                        if (fetchError instanceof ccxt.OrderNotFound) {
                            // (УСПЕХ) Ордер исчез.
                            this.logger.warn(`[${pair}] (Успех Retry) Ордер ${orderId} не найден (OrderNotFound).`);
                            return;
                        }
                        this.logger.error(`[${pair}] (Провал Retry ${i}) ${fetchError.message}`);
                    }
                }

                // (Критично) Мы не смогли отменить ордер.
                const fatalError = new Error(`[FATAL] Не удалось подтвердить отмену ордера ${orderId} для ${pair} после ${RETRY_ATTEMPTS} попыток.`);
                this.logger.fatal(fatalError.message);
                throw fatalError;
            }
        }
    }

## 4\. Критерии Приемки (Acceptance Criteria)

1.  **\[Service\]** Создан `GuaranteedOrderExecutionService.ts` (Singleton) с `getInstance()` и `initialize(exchangeService: IExchangeService)`.
2.  **\[createOrder (Шаг 1)\]** `createOrderWithRetry` генерирует `clientOrderId` (используя `crypto.randomUUID()`) и передает его в `exchangeService.createOrder()`.
3.  **\[createOrder (Шаг 1.1 - Robustness)\]** Если `createOrder` возвращает НЕ-сетевую ошибку (e.g., `InsufficientFundsError`), метод **немедленно** бросает (`throw`) эту ошибку.
4.  **\[createOrder (Шаг 2 - Retry)\]** Если `createOrder` бросает `ccxt.NetworkError` или `ccxt.RequestTimeout`, сервис **не "падает"**, а запускает цикл `Retry` (`RETRY_ATTEMPTS` раз).
5.  **\[createOrder (Шаг 2.1 - Retry)\]** В цикле `Retry` используется `fetchOrder(clientOrderId, ...)` (именно `clientOrderId`).
6.  **\[createOrder (Шаг 2.2 - Retry)\]** Если `fetchOrder` (внутри `Retry`) возвращает ордер, `createOrderWithRetry` успешно **возвращает** этот ордер.
7.  **\[createOrder (Шаг 2.3 - Fatal)\]** Если все `RETRY_ATTEMPTS` (включая `fetchOrder`) завершились неудачей, метод бросает `Error` (FATAL).
8.  **\[cancelOrder (Шаг 1)\]** `cancelOrderWithRetry` вызывает `exchangeService.cancelOrder()`.
9.  **\[cancelOrder (Шаг 1.1 - Robustness)\]** Если `cancelOrder` бросает `ccxt.OrderNotFound`, метод **успешно завершается** (`return`).
10. **\[cancelOrder (Шаг 1.2 - Robustness)\]** Если `cancelOrder` бросает НЕ-сетевую ошибку, метод немедленно бросает (`throw`) эту ошибку.

11. **\[cancelOrder (Шаг 2 - Retry)\]** Если `cancelOrder` бросает `ccxt.NetworkError`, сервис запускает цикл `Retry`.

12. **\[cancelOrder (Шаг 2.1 - Retry)\]** В цикле `Retry` используется `fetchOrder(orderId, ...)`.

13. **\[cancelOrder (Шаг 2.2 - Retry)\]** Если `fetchOrder` (внутри `Retry`) возвращает `status: 'canceled'` или `status: 'closed'`, метод **успешно завершается** (`return`).

14. **\[cancelOrder (Шаг 2.3 - Retry)\]** Если `fetchOrder` (внутри `Retry`) бросает `ccxt.OrderNotFound`, метод **успешно завершается** (`return`).

15. **\[cancelOrder (Шаг 2.4 - Fatal)\]** Если все `RETRY_ATTEMPTS` не смогли подтвердить отмену, метод бросает `Error` (FATAL).
