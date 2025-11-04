# Техническое Задание (ТЗ): 7.0 Сервис Гарантированного Исполнения (GuaranteedOrderExecutionService)

**Эпик:** 7. 👷 "Исполнитель" (Worker Service) **Задача:** 7.0 Сервис Гарантированного Исполнения (DRY) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать `GuaranteedOrderExecutionService` (Singleton) — отказоустойчивую обертку над `IExchangeService`. Этот сервис инкапсулирует сложную, но критически важную логику обработки сетевых ошибок (`NetworkError`, `RequestTimeout`) и гарантирует **идемпотентность** (предотвращение дублирования) ордеров с помощью `clientOrderId`.

Этот сервис будет использоваться `WorkerService` (Задача 7.1) и `TSLHandlerService` (Задача 5.4).

## 2\. Зависимости Задачи

- **`crypto` (Node.js):** (Зависимость) Для генерации `crypto.randomUUID()`.
- **`IExchangeService` (Интерфейс из 3.1):** (Зависимость) Целевой сервис (Mock или Production).
- **`LoggingService` (1.4):** (Зависимость) Для логирования.
- **`ExchangeErrors` (src/errors/ExchangeErrors.ts):** (Зависимость) Для импорта типов ошибок (`ExchangeNetworkError`, `OrderNotFoundError`).

## 3\. Описание и Нюансы Реализации

### 3.1. Создание `src/services/GuaranteedOrderExecutionService.ts`

Этот сервис будет управлять `IExchangeService` и логикой retry.

    // src/services/GuaranteedOrderExecutionService.ts (Новый Файл)

    import crypto from 'crypto';
    import { LoggingService } from './LoggingService.js';
    import type { IExchangeService, IDecimalOrder, DecimalValue } from '../interfaces/IExchangeService.js';
    import { ExchangeNetworkError, OrderNotFoundError } from '../errors/ExchangeErrors.js';
    import type winston from 'winston';

    // (Константы для логики Retry)
    const RETRY_ATTEMPTS = 3;
    const RETRY_DELAY_MS = 2000; // (2 секунды)

    export class GuaranteedOrderExecutionService {
        private static instance: GuaranteedOrderExecutionService | undefined;
        private readonly logger: winston.Logger;
        private exchangeService: IExchangeService | null = null;

        private constructor() {
            this.logger = LoggingService.getInstance().getLogger('GuaranteedExecution');
            this.logger.info('GuaranteedOrderExecutionService initialized.');
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
            type: string,
            side: 'buy' | 'sell',
            amount: DecimalValue,
            price?: DecimalValue,
            params?: Record<string, unknown>
        ): Promise<IDecimalOrder> {
            if (!this.exchangeService) {
                throw new Error('GuaranteedOrderExecutionService не инициализирован.');
            }

            // Генерация clientOrderId для идемпотентности
            // UUID без дефисов (32 символа) - соответствует требованиям Binance (максимум 36 символов)
            const clientOrderId = crypto.randomUUID().replace(/-/g, '');
            const clientOrderIdShort = clientOrderId.substring(0, 8);

            try {
                // Попытка 1: Создание ордера
                this.logger.debug(`[${pair}] Попытка создания ${side} ${type} ордера (Client ID: ${clientOrderIdShort})...`);

                const orderParams = {
                    ...params,
                    newClientOrderId: clientOrderId, // Передаем clientOrderId через params
                };

                return await this.exchangeService.createOrder(pair, type, side, amount, price, orderParams);
            } catch (error) {
                // Проверяем, является ли это сетевой ошибкой
                const isNetworkError =
                    error instanceof ExchangeNetworkError ||
                    (error instanceof Error && (error.message.includes('Network') || error.message.includes('timeout')));

                // Критично: Ошибка НЕ связана с сетью - немедленно пробрасываем
                if (!isNetworkError) {
                    this.logger.error(`[${pair}] НЕ-сетевая ошибка при создании ордера:`, error);
                    throw error; // Пробрасываем ошибку выше, e.g., в WorkerService
                }

                // Попытка 2: Логика Retry (только для NetworkError)
                this.logger.warn(
                    `[${pair}] NetworkError/Timeout при создании ордера (ID: ${clientOrderIdShort}). Запуск проверки статуса (Retry-Logic)...`,
                );

                for (let i = 1; i <= RETRY_ATTEMPTS; i++) {
                    await this.sleep(RETRY_DELAY_MS * i); // Exponential backoff
                    this.logger.warn(`[${pair}] Попытка ${i}/${RETRY_ATTEMPTS}: Проверка статуса ордера (поиск по Client ID)...`);

                    try {
                        // Ищем ордер по clientOrderId среди открытых ордеров
                        const openOrders = await this.exchangeService.fetchOpenOrders(pair);
                        const foundOrder = openOrders.find((order) => order.clientOrderId === clientOrderId);

                        if (foundOrder) {
                            // УСПЕХ: Ордер был создан, биржа вернула его
                            this.logger.info(
                                `[${pair}] (Успех Retry) Ордер ${foundOrder.id} подтвержден по Client ID ${clientOrderIdShort}.`,
                            );
                            return foundOrder;
                        }

                        // Ордер не найден среди открытых - возможно, он уже исполнен
                        // В этом случае считаем, что ордер не был создан из-за сетевой ошибки
                        this.logger.warn(
                            `[${pair}] (Провал Retry ${i}) Ордер с Client ID ${clientOrderIdShort} не найден среди открытых ордеров.`,
                        );
                    } catch (fetchError) {
                        // Провал: Ошибка при получении списка ордеров
                        this.logger.error(`[${pair}] (Провал Retry ${i}) Ошибка при поиске ордера:`, fetchError);
                    }
                }

                // Критично: Мы не смогли ни создать, ни найти ордер
                const fatalError = new Error(
                    `[FATAL] Не удалось подтвердить статус ордера ${clientOrderId} для ${pair} после ${RETRY_ATTEMPTS} попыток.`,
                );
                this.logger.error(fatalError.message);
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

            } catch (error) {
                // Хорошие новости: Ордер уже "исчез" (исполнен или отменен) - это НЕ ошибка
                if (error instanceof OrderNotFoundError) {
                    this.logger.info(`[${pair}] Ордер ${orderId} не найден при отмене (уже исполнен/отменен).`);
                    return; // Успешное завершение
                }

                // Проверяем, является ли это сетевой ошибкой
                const isNetworkError =
                    error instanceof ExchangeNetworkError ||
                    (error instanceof Error && (error.message.includes('Network') || error.message.includes('timeout')));

                // Плохие новости: Ошибка НЕ связана с сетью - пробрасываем
                if (!isNetworkError) {
                    this.logger.error(`[${pair}] НЕ-сетевая ошибка при отмене ордера ${orderId}:`, error);
                    throw error; // Пробрасываем выше
                }

                // Попытка 2: Логика Retry (только для NetworkError)
                this.logger.warn(
                    `[${pair}] NetworkError/Timeout при отмене ордера ${orderId}. Запуск проверки статуса (Retry-Logic)...`,
                );

                for (let i = 1; i <= RETRY_ATTEMPTS; i++) {
                    await this.sleep(RETRY_DELAY_MS * i);
                    this.logger.warn(`[${pair}] Попытка ${i}/${RETRY_ATTEMPTS}: Проверка статуса ордера (fetchOrder by ID)...`);

                    try {
                        const order = await this.exchangeService.fetchOrder(orderId, pair);
                        if (order.status === 'canceled' || order.status === 'closed') {
                            // УСПЕХ: Ордер отменен или исполнен
                            this.logger.info(`[${pair}] (Успех Retry) Статус ордера ${order.id} подтвержден: ${order.status}.`);
                            return;
                        }
                        // Провал: Ордер все еще 'open'
                        this.logger.error(`[${pair}] (Провал Retry ${i}) Ордер ${orderId} все еще 'open'.`);
                    } catch (fetchError) {
                        if (fetchError instanceof OrderNotFoundError) {
                            // УСПЕХ: Ордер исчез
                            this.logger.info(`[${pair}] (Успех Retry) Ордер ${orderId} не найден (OrderNotFound).`);
                            return;
                        }
                        this.logger.error(`[${pair}] (Провал Retry ${i}):`, fetchError);
                    }
                }

                // Критично: Мы не смогли отменить ордер
                const fatalError = new Error(
                    `[FATAL] Не удалось подтвердить отмену ордера ${orderId} для ${pair} после ${RETRY_ATTEMPTS} попыток.`,
                );
                this.logger.error(fatalError.message);
                throw fatalError;
            }
        }
    }

## 4\. Критерии Приемки (Acceptance Criteria)

1.  **\[Service\]** Создан `GuaranteedOrderExecutionService.ts` (Singleton) с методом `getInstance()` и `initialize(exchangeService: IExchangeService)`.

2.  **\[createOrder (Шаг 1)\]** `createOrderWithRetry` генерирует `clientOrderId` (используя `crypto.randomUUID().replace(/-/g, '')` для удаления дефисов) и передает его в `exchangeService.createOrder()` через параметр `newClientOrderId` в объекте `params`.

3.  **\[createOrder (Шаг 1.1 - Robustness)\]** Если `createOrder` возвращает НЕ-сетевую ошибку (проверка через `error instanceof ExchangeNetworkError` или проверка сообщения на "Network"/"timeout"), метод **немедленно** бросает (`throw`) эту ошибку.

4.  **\[createOrder (Шаг 2 - Retry)\]** Если `createOrder` бросает сетевую ошибку (`ExchangeNetworkError` или сообщение содержит "Network"/"timeout"), сервис **не "падает"**, а запускает цикл `Retry` (`RETRY_ATTEMPTS` раз).

5.  **\[createOrder (Шаг 2.1 - Retry)\]** В цикле `Retry` используется `fetchOpenOrders(pair)` и поиск ордера по `clientOrderId` через `openOrders.find((order) => order.clientOrderId === clientOrderId)`.

6.  **\[createOrder (Шаг 2.2 - Retry)\]** Если ордер найден среди открытых (`foundOrder`), `createOrderWithRetry` успешно **возвращает** этот ордер и логирует `info` с подтверждением.

7.  **\[createOrder (Шаг 2.3 - Retry)\]** Если ордер не найден среди открытых, логируется `warn` и цикл продолжается.

8.  **\[createOrder (Шаг 2.4 - Fatal)\]** Если все `RETRY_ATTEMPTS` завершились неудачей, метод бросает `Error` (FATAL) и логирует `error`.

9.  **\[cancelOrder (Шаг 1)\]** `cancelOrderWithRetry` вызывает `exchangeService.cancelOrder(orderId, pair)`.

10. **\[cancelOrder (Шаг 1.1 - Robustness)\]** Если `cancelOrder` бросает `OrderNotFoundError`, метод **успешно завершается** (`return`) и логирует `info`.

11. **\[cancelOrder (Шаг 1.2 - Robustness)\]** Если `cancelOrder` бросает НЕ-сетевую ошибку (проверка через `error instanceof ExchangeNetworkError` или проверка сообщения), метод немедленно бросает (`throw`) эту ошибку.

12. **\[cancelOrder (Шаг 2 - Retry)\]** Если `cancelOrder` бросает сетевую ошибку (`ExchangeNetworkError` или сообщение содержит "Network"/"timeout"), сервис запускает цикл `Retry`.

13. **\[cancelOrder (Шаг 2.1 - Retry)\]** В цикле `Retry` используется `fetchOrder(orderId, pair)`.

14. **\[cancelOrder (Шаг 2.2 - Retry)\]** Если `fetchOrder` (внутри `Retry`) возвращает ордер со статусом `'canceled'` или `'closed'`, метод **успешно завершается** (`return`) и логирует `info`.

15. **\[cancelOrder (Шаг 2.3 - Retry)\]** Если `fetchOrder` (внутри `Retry`) бросает `OrderNotFoundError`, метод **успешно завершается** (`return`) и логирует `info`.

16. **\[cancelOrder (Шаг 2.4 - Fatal)\]** Если все `RETRY_ATTEMPTS` не смогли подтвердить отмену, метод бросает `Error` (FATAL) и логирует `error`.

17. **\[ClientOrderId\]** `clientOrderId` генерируется без дефисов через `crypto.randomUUID().replace(/-/g, '')` для соответствия требованиям Binance (максимум 36 символов).

18. **\[ClientOrderIdShort\]** Для логирования используется короткая версия `clientOrderId.substring(0, 8)`.

19. **\[Sleep\]** Реализован приватный метод `sleep(ms)` для паузы между попытками retry.
