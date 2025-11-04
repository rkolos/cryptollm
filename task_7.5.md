# Техническое Задание (ТЗ): 7.1 Диспетчер "Исполнителя" (WorkerService Dispatcher)

**Эпик:** 7. 👷 "Исполнитель" (Worker Service) **Задача:** 7.1, 7.1.3, 7.2, 7.3, 7.3.1, 7.4, и **7.5 (Реализация `CANCEL_ORDERS`)** **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать `WorkerService` (Singleton) — главный сервис-диспетчер, отвечающий за _полный цикл исполнения_ решения LLM. Этот сервис связывает воедино `Validator` (проверка), `GuaranteedOrderExecutionService` (исполнение), `DatabaseService` (логирование) и `NotificationService` (уведомление).

## 2\. Архитектурное Решение (Уточнение Задачи 5.6)

План (Задача 5.6) указывает, что `WatcherOrchestrator` передает в `Worker` только `(decision, log.id)`. Этого **недостаточно** для вызова `Validator`.

Поэтому, как архитектор, я уточняю: `WatcherOrchestrator` (Задача 5.6) _обязан_ передавать в `WorkerService.execute` _все_ данные, необходимые `Validator`\-у (Эпик 6).

## 3\. Зависимости Задачи

- **`ValidatorService` (Эпик 6):** (Зависимость) Для `validateDecision()`.
- **`GuaranteedOrderExecutionService` (7.0):** (Зависимость) Для `createOrderWithRetry()` / `cancelOrderWithRetry()`.
- **`DatabaseService` (2.3):** (Зависимость) Для `executeInTransaction()` и обновления `LLM_Decision_Log`.
- **`EventBusService` (4.5.1):** (Зависимость) Для `emit('trade_executed')`.
- **`NotificationService` (1.5/3.6):** (Зависимость) Для `sendAlert()`.
- **`GlobalStateService` (1.6):** (Зависимость) Для `pause()` при `InsufficientFunds`.
- **`AccountStateService` (4.5):** (Зависимость) Для `refreshNow()` при `InsufficientFunds`.
- **`ExchangeRulesService` (3.2):** (Зависимость) Для `getRules()`.
- **`ConfigService` (1.3):** (Зависимость) Для `getStrategyContext()`.
- **`LoggingService` (1.4):** (Зависимость) Для логирования.
- **`ccxt` (1.2):** (Зависимость) Для импорта типов ошибок (`InsufficientFundsError`).
- **`pg-protocol/dist/messages`:** (Зависимость) Для `DatabaseError`.

## 4\. Описание и Нюансы Реализации

### 4.1. Обновление Интерфейсов (`src/interfaces/types.ts`)

Нам нужны типы для решений LLM (из Задачи 10.5) и для результата `Validator`.

    // src/interfaces/types.ts (Дополнения)

    import { Decimal } from 'decimal.js';
    import { Order } from 'ccxt';
    // ... (другие типы)

    // --- Типы Решений (из Задачи 10.5) ---

    export type LLMAction =
        | 'OPEN_LONG'
        | 'OPEN_SHORT'
        | 'CLOSE_POSITION'
        | 'MODIFY_POSITION'
        | 'CANCEL_ORDERS'
        | 'HOLD'; // (HOLD означает пустой массив `decisions`)

    export interface LLMDecisionParameters {
        type: 'market' | 'limit';
        price?: Decimal | null;
        risk_percent?: Decimal | null;
        stop_loss_price?: Decimal | null;
        take_profit_price?: Decimal | null;
        trailing_stop_config?: any | null; // (todo: define TSL config type)

        // (Для CLOSE_POSITION)
        amount_percent?: Decimal | null;

        // (Для CANCEL_ORDERS)
        order_id_to_cancel?: string | null; // (null = отменить все по паре)

        // (Для MODIFY_POSITION)
        new_stop_loss_price?: Decimal | null;
        new_take_profit_price?: Decimal | null;
        new_trailing_stop_config?: any | null;
    }

    export interface LLMDecision {
        action: LLMAction;
        pair: string;
        parameters: LLMDecisionParameters;
        justification: string;
    }

    // --- Типы для Worker/Validator ---

    /**
     * (Результат Валидации, возвращаемый ValidatorService)
     * (Расширяет CalculatedAmounts из Задачи 6.2)
     */
    export interface ValidationResult {
        // (Из Уровня 2 - 6.2)
        rawAmountCoin: Decimal;
        rawAmountUsd: Decimal;
        usdAtRisk: Decimal;
        // (Из Уровня 4 - 6.6)
        roundedAmountCoin: Decimal;
        roundedAmountUsd: Decimal;
        roundedPrice: Decimal | null; // (null для market)
    }

### 4.2. Создание `src/services/WorkerService.ts`

Этот сервис будет содержать "скелет" диспетчера и заглушки для обработчиков (7.2-7.5).

    // src/services/WorkerService.ts (Изменения 7.5)

    import ccxt, { Order } from 'ccxt';
    import {
        LLMDecision, LLMRequestData, ValidationResult,
        AccountState, StrategyContext, MarketData, OrderSide, OrderType
    } from '../interfaces';
    import { LoggingService } from './LoggingService';
    import { ValidatorService } from './ValidatorService';
    import { GuaranteedOrderExecutionService } from './GuaranteedOrderExecutionService';
    import { DatabaseService, TransactionClient } from './DatabaseService';
    import { EventBusService } from './EventBusService';
    import { NotificationService } from './NotificationService';
    import { GlobalStateService } from './GlobalStateService';
    import { AccountStateService } from './AccountStateService';
    import { ExchangeRulesService } from './ExchangeRulesService';
    import { ConfigService } from './ConfigService';
    import { Decimal } from 'decimal.js';
    import { DatabaseError } from 'pg-protocol/dist/messages';

    export class WorkerService {
        private static instance: WorkerService;
        private logger: LoggingService;

        // (Все зависимости)
        private validatorService: ValidatorService;
        private executionService: GuaranteedOrderExecutionService;
        private dbService: DatabaseService;
        private eventBus: EventBusService;
        private notificationService: NotificationService;
        private globalStateService: GlobalStateService;
        private accountStateService: AccountStateService;
        private exchangeRulesService: ExchangeRulesService;
        private configService: ConfigService;

        private constructor(
            /* ... (инъекция всех 9 зависимостей) ... */
        ) {
            this.logger = LoggingService.getInstance();
            this.logger.registerContext("WorkerService");
            // (Присвоение всех зависимостей)
            this.validatorService = ValidatorService.getInstance(/*...*/);
            this.executionService = GuaranteedOrderExecutionService.getInstance();
            this.dbService = DatabaseService.getInstance(/*...*/);
            this.eventBus = EventBusService.getInstance();
            this.notificationService = NotificationService.getInstance(/*...*/);
            this.globalStateService = GlobalStateService.getInstance();
            this.accountStateService = AccountStateService.getInstance(/*...*/);
            this.exchangeRulesService = ExchangeRulesService.getInstance(/*...*/);
            this.configService = ConfigService.getInstance();
        }

        public static getInstance(
            /* ... (все 9 зависимостей) ... */
        ): WorkerService {
            if (!WorkerService.instance) {
                WorkerService.instance = new WorkerService(/*...*/);
            }
            return WorkerService.instance;
        }

        /**
         * Главный метод-диспетчер.
         * (Вызывается из WatcherOrchestrator (5.6) ВНУТРИ PairActorManager (9.4))
         */
        public async execute(
            decision: LLMDecision,
            llm_decision_log_id: string,
            // (Данные, необходимые для Validator, см. Раздел 2)
            accountState: AccountState,
            strategyContext: StrategyContext,
            marketData: MarketData
        ): Promise<void> {

            const pair = decision.pair;
            this.logger.info(`[${pair}] Worker принял задачу (Log ID: ${llm_decision_log_id.substring(0, 8)}). Action: ${decision.action}`);

            let validationResult: ValidationResult | null = null;

            // --- Шаг 1: ВАЛИДАЦИЯ ---
            try {
                // (Критично) 'HOLD' (пустой `decisions: []`) не требует валидации
                if (decision.action === 'HOLD') {
                    this.logger.debug(`[${pair}] Action: HOLD. Валидация не требуется.`);
                } else {
                    const exchangeRules = this.exchangeRulesService.getRules(pair);

                    // (Критично) Вызов Валидатора (Эпик 6)
                    validationResult = this.validatorService.validateDecision(
                        decision,
                        accountState,
                        strategyContext,
                        marketData,
                        exchangeRules
                    );
                    this.logger.debug(`[${pair}] Валидация Успешна. Rounded Amount: ${validationResult.roundedAmountCoin}`);
                }

            } catch (validationError: any) {
                // (Провал Валидации)
                this.logger.error(`[${pair}] ПРОВАЛ ВАЛИДАЦИИ: ${validationError.message}`);
                // (Обновляем лог в БД)
                await this._updateDecisionLog(
                    llm_decision_log_id,
                    'rejected_by_validator',
                    validationError.message,
                    null
                );
                // (Отправляем PUSH)
                this.notificationService.sendAlert(
                    `[${pair}] РЕШЕНИЕ ОТКЛОНЕНО: ${validationError.message}`
                );
                return; // (Остановка)
            }

            // --- Шаг 2: ИСПОЛНЕНИЕ ---
            try {
                // (Передаем validationResult, т.к. там уже рассчитаны все суммы)
                switch (decision.action) {
                    case 'OPEN_LONG':
                    case 'OPEN_SHORT':
                        // (validationResult не может быть null здесь из-за логики в Шаге 1)
                        await this.handleOpenPosition(decision, validationResult!);
                        break;

                    case 'CLOSE_POSITION':
                        await this.handleClosePosition(decision, validationResult!);
                        break;

                    case 'MODIFY_POSITION':
                        await this.handleModifyPosition(decision, validationResult!);
                        break;

                    case 'CANCEL_ORDERS':
                        await this.handleCancelOrders(decision, validationResult!);
                        break;

                    case 'HOLD':
                        // (Ничего не делаем)
                        break;
                }

                // (Успех)
                this.logger.info(`[${pair}] Исполнение УСПЕШНО: ${decision.action}`);

                // (Задача 7.1.3: Публикация События)
                // (Публикуем, только если было реальное действие)
                if (decision.action !== 'HOLD') {
                    this.eventBus.emit('trade_executed', pair);
                }

                // (Обновляем лог в БД)
                await this._updateDecisionLog(llm_decision_log_id, 'accepted', null, null);

                // (Отправляем PUSH, только если было действие)
                if (decision.action !== 'HOLD') {
                    this.notificationService.sendAlert(
                        `[${pair}] ИСПОЛНЕНО: ${decision.action} (Justification: ${decision.justification})`,
                        true // (Включить AccountState)
                    );
                }

            } catch (executionError: any) {
                // (Провал Исполнения)
                this.logger.fatal(`[${pair}] КРИТИЧЕСКАЯ ОШИБКА ИСПОЛНЕНИЯ: ${executionError.message}`);

                // (Обработка уникальности - если позиция уже существует)
                if (executionError instanceof DatabaseError && executionError.code === '23505') { // (unique_violation)
                    this.logger.fatal(`[${pair}] Ошибка Уникальности БД (23505)! Позиция, вероятно, уже существует. Запуск принудительной синхронизации...`);
                    // (Отправляем PUSH)
                    this.notificationService.sendAlert(
                        `[${pair}] КРИТИЧЕСКАЯ ОШИБКА СИНХРОНИЗАЦИИ (23505)! Попытка открыть уже открытую позицию. Требуется проверка.`
                    );
                    // (Принудительно обновляем кэш, т.к. он явно не совпадает с БД)
                    await this.accountStateService.refreshNow();
                }

                // (Обновляем лог в БД)
                 await this._updateDecisionLog(
                    llm_decision_log_id,
                    'failed_by_worker',
                    null,
                    executionError.message
                );

                // (Отправляем PUSH)
                this.notificationService.sendAlert(
                    `[${pair}] ОШИБКА ИСПОЛНЕНИЯ: ${executionError.message}`,
                    true // (Включить AccountState)
                );

                // (Специальная обработка InsufficientFunds - План 7.1)
                if (executionError instanceof ccxt.InsufficientFundsError) {
                    this.logger.fatal(`[${pair}] InsufficientFundsError! Активация Глобальной Паузы.`);
                    this.notificationService.sendAlert(
                        `[FATAL] НЕДОСТАТОЧНО СРЕДСТВ! Бот ПРИОСТАНОВЛЕН. Требуется ручное вмешательство.`,
                        true
                    );
                    // (Ставим на паузу)
                    this.globalStateService.pause();
                    // (Принудительно обновляем кэш баланса)
                    await this.accountStateService.refreshNow();
                }

                // (Пробрасываем ошибку выше, чтобы PairActorManager ее "увидел")
                throw executionError;
            }
        }

        /**
         * (Вспомогательный) Обновляет LLM_Decision_Log в БД
         */
        private async _updateDecisionLog(
            logId: string,
            status: 'rejected_by_validator' | 'accepted' | 'failed_by_worker',
            validatorError: string | null,
            workerError: string | null
        ): Promise<void> {
            try {
                await this.dbService.query(
                    `UPDATE LLM_Decision_Log
                     SET
                        decision_result = $2,
                        validator_error_message = $3,
                        worker_error_message = $4
                     WHERE id = $1`,
                    [logId, status, validatorError, workerError]
                );
            } catch (dbError: any) {
                this.logger.error(`[FATAL] Не удалось обновить LLM_Decision_Log (ID: ${logId}): ${dbError.message}`);
            }
        }

        // --- (ЗАГЛУШКИ: Будут реализованы в 7.2 - 7.5) ---

        // (ИЗМЕНЕНО в 7.2) - Реализация `handleOpenPosition`
        private async handleOpenPosition(decision: LLMDecision, validationResult: ValidationResult): Promise<Order | null> {
            const { type } = decision.parameters;

            if (type === 'market') {
                // (Логика этой Задачи 7.2)
                return this._handleOpenMarketPosition(decision, validationResult);
            } else if (type === 'limit') {
                // (Логика Задачи 7.2.1)
                return this._handleOpenLimitPosition(decision, validationResult);
            }

            throw new Error(`[${decision.pair}] Неизвестный тип ордера в handleOpenPosition: ${type}`);
        }

        // (НОВОЕ в 7.2) - Реализация `OPEN (Market)`
        private async _handleOpenMarketPosition(decision: LLMDecision, validationResult: ValidationResult): Promise<Order> {
            const { pair, parameters, action } = decision;
            const { stop_loss_price, take_profit_price, trailing_stop_config } = parameters;
            const { roundedAmountCoin } = validationResult;

            const side: OrderSide = (action === 'OPEN_LONG') ? 'buy' : 'sell';
            const oppositeSide: OrderSide = (side === 'buy') ? 'sell' : 'buy';

            this.logger.debug(`[${pair}] Запуск _handleOpenMarketPosition. Side: ${side}, Amount: ${roundedAmountCoin}`);

            // (Критично) Вся операция выполняется в ОДНОЙ транзакции
            return this.dbService.executeInTransaction(async (client: TransactionClient): Promise<Order> => {

                // --- Шаг 1: Создание Market ордера ---
                // (executionService (7.0) гарантирует, что он дождется исполнения и вернет `fetchMyTrades`)
                const marketBuyOrder = await this.executionService.createOrderWithRetry(
                    pair,
                    'market',
                    side,
                    roundedAmountCoin
                );

                // (Извлекаем РЕАЛЬНЫЕ данные исполнения)
                // (Важно: `average` может быть null/0, если ccxt не вернул. Используем `price`)
                const realEntryPrice = marketBuyOrder.average || marketBuyOrder.price;
                // (Важно: `filled` может быть null/0. Используем `amount`)
                const realAmount = marketBuyOrder.filled || marketBuyOrder.amount;
                const realFeeCost = marketBuyOrder.fee?.cost ?? 0;
                const realTimestamp = marketBuyOrder.timestamp ?? Date.now();

                if (!realEntryPrice || !realAmount) {
                    throw new Error(`[${pair}] КРИТИЧЕСКАЯ ОШИБКА: Market ордер ${marketBuyOrder.id} вернул 'null' price или 'null' amount.`);
                }

                this.logger.debug(`[${pair}] Market ордер ${marketBuyOrder.id} исполнен. Price: ${realEntryPrice}, Amount: ${realAmount}`);

                // --- Шаг 2: Создание SL/TP ордеров ---
                let slOrder: Order | null = null;
                let tpOrder: Order | null = null;

                // (Создаем SL)
                if (stop_loss_price) {
                    // (Используем STOP_LOSS_LIMIT для защиты от проскальзывания)
                    // (stopPrice = триггер, price = лимит (чуть ниже/выше))
                    // (Для V1 мы упрощаем: stopPrice == price)
                    const slPriceParams = { 'stopPrice': stop_loss_price.toNumber() };

                    slOrder = await this.executionService.createOrderWithRetry(
                        pair,
                        'stop_loss_limit', // (Тип ордера)
                        oppositeSide,
                        new Decimal(realAmount),
                        stop_loss_price,
                        slPriceParams
                    );
                    this.logger.debug(`[${pair}] SL ордер ${slOrder.id} создан.`);
                }

                // (Создаем TP)
                if (take_profit_price) {
                    tpOrder = await this.executionService.createOrderWithRetry(
                        pair,
                        'limit', // (TP - это обычный Limit ордер)
                        oppositeSide,
                        new Decimal(realAmount),
                        take_profit_price
                    );
                    this.logger.debug(`[${pair}] TP ордер ${tpOrder.id} создан.`);
                }

                // --- Шаг 3: Сохранение Состояния в БД (Атомарно) ---

                // 1. Сохранить Позицию
                // (Задача 7.2 - Нюанс реализации):
                // Разработчик должен реализовать INSERT INTO ActivePositions...

                // 2. Сохранить Историю (вход)
                // (Задача 7.2 - Нюанс реализации):
                // Разработчик должен реализовать INSERT INTO TradeHistory...

                // 3. Сохранить SL ордер
                // (Задача 7.2 - Нюанс реализации):
                // Разработчик должен реализовать INSERT INTO ActiveOrders (для slOrder)...

                // 4. Сохранить TP ордер
                // (Задача 7.2 - Нюанс реализации):
                // Разработчик должен реализовать INSERT INTO ActiveOrders (для tpOrder)...

                // 5. Сохранить TSL (если есть)
                // (Задача 7.2 - Нюанс реализации):
                // Разработчик должен реализовать INSERT INTO TSL_State (если tslConfigJson)...

                this.logger.info(`[${pair}] Атомарная транзакция (OPEN Market) УСПЕШНА.`);

                return marketBuyOrder;
            });
        }

        // (НОВОЕ в 7.2) - Заглушка для Задачи 7.2.1
        private async _handleOpenLimitPosition(decision: LLMDecision, validationResult: ValidationResult): Promise<Order | null> {
            this.logger.debug(`[${decision.pair}] (STUB) Вызов _handleOpenLimitPosition...`);
            // (Логика Задачи 7.2.1 будет здесь)
            return null;
        }

        // (ИЗМЕНЕНО в 7.3) - Реализация `handleClosePosition`
        private async handleClosePosition(decision: LLMDecision, validationResult: ValidationResult): Promise<Order | null> {
            const { type } = decision.parameters;

            if (type === 'market') {
                // (Логика этой Задачи 7.3)
                return this._handleCloseMarketPosition(decision, validationResult);
            } else if (type === 'limit') {
                // (Логика Задачи 7.3.1)
                return this._handleCloseLimitPosition(decision, validationResult);
            }

            throw new Error(`[${decision.pair}] Неизвестный тип ордера в handleClosePosition: ${type}`);
        }

        // (НОВОЕ в 7.3) - Реализация `CLOSE (Market)`
        private async _handleCloseMarketPosition(decision: LLMDecision, validationResult: ValidationResult): Promise<Order> {
            const { pair } = decision;

            this.logger.debug(`[${pair}] Запуск _handleCloseMarketPosition.`);

            // (Критично) Вся операция выполняется в ОДНОЙ транзакции
            return this.dbService.executeInTransaction(async (client: TransactionClient): Promise<Order> => {

                // --- Шаг 1: Получить Позицию из БД (и заблокировать строку) ---
                // (Задача 7.3 - Нюанс реализации):
                // Разработчик должен реализовать SELECT ... FROM ActivePositions ... FOR UPDATE
                // для получения `amount` и `side`.
                // Обязательно проверить `rowCount === 0` (ошибка синхронизации).
                const positionAmount = new Decimal(0); // (Заглушка)
                const positionSide = 'long'; // (Заглушка)

                // --- Шаг 2: (Архитектура 7.3) - НЕ отменять ордера ---
                // (Логика не требуется)

                // --- Шаг 3: Создание Market ордера на Закрытие ---
                // (Задача 7.3 - Нюанс реализации):
                // Разработчик должен реализовать вызов
                // `this.executionService.createOrderWithRetry` для закрытия.
                const closeMarketOrder = {} as Order; // (Заглушка)

                // (Задача 7.3 - Нюанс реализации):
                // Разработчик должен извлечь `realClosePrice`, `realAmount` и т.д.
                // из `closeMarketOrder`.

                // --- Шаг 4: Атомарная Очистка БД ---
                // (Задача 7.3 - Нюанс реализации):
                // Разработчик должен реализовать:
                // 1. DELETE FROM ActivePositions ...
                // 2. DELETE FROM ActiveOrders ...
                // 3. DELETE FROM TSL_State ...
                // 4. INSERT INTO TradeHistory ... (для записи *выхода*)

                this.logger.info(`[${pair}] Атомарная транзакция (CLOSE Market) УСПЕШНА.`);

                return closeMarketOrder;
            });
        }

        // (ИЗМЕНЕНО в 7.3.1) - Реализация `CLOSE (Limit)`
        private async _handleCloseLimitPosition(decision: LLMDecision, validationResult: ValidationResult): Promise<Order | null> {
            const { pair, parameters } = decision;
            const { price: limitPrice } = parameters;

            if (!limitPrice) {
                throw new Error(`[${pair}] (ОШИБКА ВАЛИДАТОРА) CLOSE_POSITION (Limit) требует 'price'.`);
            }

            this.logger.debug(`[${pair}] Запуск _handleCloseLimitPosition. Price: ${limitPrice}`);

            // (Критично) Вся операция выполняется в ОДНОЙ транзакции
            return this.dbService.executeInTransaction(async (client: TransactionClient): Promise<Order> => {

                // --- Шаг 1: Получить Позицию из БД (и заблокировать строку) ---
                // (Задача 7.3.1 - Нюанс реализации):
                // Разработчик должен реализовать SELECT ... FROM ActivePositions ... FOR UPDATE
                // для получения `amount` и `side`.
                // Обязательно проверить `rowCount === 0` (ошибка синхронизации).
                const positionAmount = new Decimal(0); // (Заглушка)
                const positionSide = 'long'; // (Заглушка)
                const closeSide: OrderSide = 'sell'; // (Заглушка)

                // --- Шаг 2: Создание Limit ордера на Закрытие ---
                // (Задача 7.3.1 - Нюанс реализации):
                // Разработчик должен реализовать вызов
                // `this.executionService.createOrderWithRetry` для создания 'limit' 'closeSide' ордера.
                const newLimitOrder = {} as Order; // (Заглушка)

                // --- Шаг 3: Атомарная Запись Ордера в БД ---
                // (Задача 7.3.1 - Нюанс реализации):
                // Разработчик должен реализовать INSERT ... ON CONFLICT ...
                // в `ActiveOrders` с `type = 'limit_close'`.
                // (Позиция НЕ удаляется).

                this.logger.info(`[${pair}] Атомарная транзакция (CLOSE Limit) УСПЕШНА.`);

                return newLimitOrder;
            });
        }

        // (ИЗМЕНЕНО в 7.4) - Реализация `MODIFY_POSITION`
        private async handleModifyPosition(decision: LLMDecision, validationResult: ValidationResult): Promise<Order | null> {
            const { pair, parameters } = decision;
            const { new_stop_loss_price, new_take_profit_price, new_trailing_stop_config } = parameters;

            this.logger.debug(`[${pair}] Запуск handleModifyPosition...`);

            // (Критично) Вся операция выполняется в ОДНОЙ транзакции
            return this.dbService.executeInTransaction(async (client: TransactionClient): Promise<Order | null> => {

                // --- Шаг 1: Получить Позицию и ее Ордера из БД (и заблокировать) ---
                // (Задача 7.4 - Нюанс реализации):
                // Разработчик должен реализовать сложный SELECT ... FOR UPDATE ...
                // (как описано в Критерии 39)
                // для получения `pos.side`, `pos.amount`, `pos.current_sl_id`, `pos.current_tp_id`, `pos.current_tsl_sl_id`.
                // Обязательно проверить `rowCount === 0`.
                const pos = { side: 'long', amount: 0, current_sl_id: null, current_tp_id: null, current_tsl_sl_id: null }; // (Заглушка)
                const oppositeSide: OrderSide = 'sell'; // (Заглушка)
                const positionAmount = new Decimal(0); // (Заглушка)
                let newMainOrder: Order | null = null;

                // --- Шаг 2: Обработка нового Stop Loss (если запрошен) ---
                if (new_stop_loss_price) {
                    this.logger.debug(`[${pair}] Модификация SL. Новая цена: ${new_stop_loss_price}`);

                    // (Задача 7.4 - Нюанс реализации):
                    // Разработчик должен реализовать логику "Cancel-Then-Create" для SL:
                    // 1. (Cancel) Найти `oldSlId` (из `pos.current_tsl_sl_id` или `pos.current_sl_id`).
                    // 2. (Cancel) Вызвать `this.executionService.cancelOrderWithRetry(oldSlId, pair)`.
                    // 3. (Cancel) Вызвать `client.query(DELETE FROM ActiveOrders ...)`
                    // 4. (Cancel) Вызвать `client.query(DELETE FROM TSL_State ...)`
                    // 5. (Create) Вызвать `this.executionService.createOrderWithRetry(...)` (для 'stop_loss_limit').
                    // 6. (Create) Сохранить результат в `newMainOrder`.
                    // 7. (Create) Вызвать `client.query(INSERT INTO ActiveOrders ...)` (с `newMainOrder.id`).
                    // 8. (Create) Вызвать `client.query(UPDATE ActivePositions SET current_stop_loss_price = ...)`
                }

                // --- Шаг 2.4: Обработка TSL (если запрошен) ---
                if (new_trailing_stop_config && newMainOrder) { // (Критично: TSL требует *нового* SL ордера)
                     this.logger.debug(`[${pair}] (Re)Configuring TSL...`);
                     // (Задача 7.4 - Нюанс реализации):
                     // Разработчик должен реализовать UPSERT для TSL_State
                     // (INSERT ... ON CONFLICT ... DO UPDATE ...)
                     // привязывая `newMainOrder.id` к `current_sl_order_id`.
                }

                // --- Шаг 3: Обработка нового Take Profit (если запрошен) ---
                if (new_take_profit_price) {
                    this.logger.debug(`[${pair}] Модификация TP. Новая цена: ${new_take_profit_price}`);

                    // (Задача 7.4 - Нюанс реализации):
                    // Разработчик должен реализовать логику "Cancel-Then-Create" для TP:
                    // 1. (Cancel) Найти `pos.current_tp_id`.
                    // 2. (Cancel) Вызвать `this.executionService.cancelOrderWithRetry(pos.current_tp_id, pair)`.
                    // 3. (Cancel) Вызвать `client.query(DELETE FROM ActiveOrders ...)`
                    // 4. (Create) Вызвать `this.executionService.createOrderWithRetry(...)` (для 'limit' 'take_profit').
                    // 5. (Create) Вызвать `client.query(INSERT INTO ActiveOrders ...)`
                    // 6. (Create) Вызвать `client.query(UPDATE ActivePositions SET current_take_profit_price = ...)`
                }

                this.logger.info(`[${pair}] Атомарная транзакция (MODIFY Position) УСПЕШНА.`);

                return newMainOrder;
            });
        }

        // (ИЗМЕНЕНО в 7.5) - Реализация `CANCEL_ORDERS`
        private async handleCancelOrders(
            decision: LLMDecision,
            _validationResult: CalculatedAmounts
        ): Promise<void> {
            const { pair, parameters } = decision;
            const orderIdToCancel = parameters.order_id;

            this.logger.debug(`[${pair}] Запуск handleCancelOrders...`);

            // КРИТИЧНО: Отмена на бирже должна происходить ДО транзакции БД
            // Если отмена провалится, БД операция не начнется
            // Если отмена пройдет, а БД операция упадет - отмененные ордера будут "призраками" в БД

            if (orderIdToCancel) {
                // --- Сценарий A: Отмена КОНКРЕТНОГО ордера ---
                this.logger.debug(`[${pair}] Отмена конкретного ордера: ${orderIdToCancel}`);

                // Шаг 1: Отмена на Бирже (ДО транзакции БД)
                try {
                    await this.executionService.cancelOrderWithRetry(orderIdToCancel, pair);
                    this.logger.debug(`[${pair}] Ордер ${orderIdToCancel} успешно отменен на бирже.`);
                } catch (error) {
                    // Если отмена на бирже провалилась, не обновляем БД (ордер может быть уже исполнен)
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    this.logger.warn(
                        `[${pair}] Не удалось отменить ордер ${orderIdToCancel} на бирже (возможно, уже исполнен): ${errorMessage}`,
                    );
                    // Продолжаем: возможно ордер уже исполнен или не существует, все равно удалим из БД
                }

                // Шаг 2: Атомарная очистка БД (даже если отмена на бирже провалилась - удаляем "призрак")
                await this.databaseService.executeInTransaction(async (client: PoolClient): Promise<void> => {
                    // 2.1. Удаляем из ActiveOrders
                    await client.query(`DELETE FROM ActiveOrders WHERE exchange_order_id = $1`, [orderIdToCancel]);

                    // 2.2. (Критично) Удаляем связанный TSL, если он был
                    // Если мы отменили SL, TSL больше недействителен
                    await client.query(`DELETE FROM TSL_State WHERE current_stop_order_id = $1`, [orderIdToCancel]);
                });

                this.logger.info(`[${pair}] Атомарная транзакция (CANCEL Orders) УСПЕШНА.`);
            } else {
                // --- Сценарий Б: Отмена ВСЕХ ордеров по паре ---
                this.logger.debug(`[${pair}] Отмена ВСЕХ ордеров...`);

                // Шаг 1: Получить ВСЕ ID ордеров из БД (перед отменой на бирже)
                const ordersResult = await this.databaseService.query(
                    `SELECT exchange_order_id FROM ActiveOrders WHERE pair = $1`,
                    [pair],
                );
                const orderIdsToCancel: string[] = ordersResult.rows.map((r) => r.exchange_order_id as string);

                if (orderIdsToCancel.length === 0) {
                    this.logger.warn(`[${pair}] Нет ордеров для отмены.`);
                    return;
                }

                // Шаг 2: Отмена ВСЕХ ордеров на Бирже (ДО транзакции БД)
                const successfullyCancelledIds: string[] = [];
                const failedToCancelIds: string[] = [];

                for (const orderId of orderIdsToCancel) {
                    try {
                        await this.executionService.cancelOrderWithRetry(orderId, pair);
                        successfullyCancelledIds.push(orderId);
                        this.logger.debug(`[${pair}] Ордер ${orderId} успешно отменен на бирже.`);
                    } catch (error) {
                        // Логируем ошибку, но продолжаем отмену остальных ордеров
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        this.logger.warn(`[${pair}] Не удалось отменить ордер ${orderId} на бирже: ${errorMessage}`);
                        failedToCancelIds.push(orderId);
                    }
                }

                // Шаг 3: Атомарная очистка БД (удаляем все ордера, включая те, что не удалось отменить на бирже)
                // Если ордер не был отменен на бирже (ошибка), но был удален из БД - SyncEngine восстановит состояние
                await this.databaseService.executeInTransaction(async (client: PoolClient): Promise<void> => {
                    // 3.1. Удаляем ВСЕ ордера по паре (и успешно отмененные, и неотмененные - они могут быть "призраками")
                    await client.query(`DELETE FROM ActiveOrders WHERE pair = $1`, [pair]);

                    // 3.2. Удаляем ВСЕ TSL по паре
                    await client.query(`DELETE FROM TSL_State WHERE pair = $1`, [pair]);
                });

                // Логируем результаты
                if (failedToCancelIds.length > 0) {
                    this.logger.warn(
                        `[${pair}] Часть ордеров не была отменена на бирже (${failedToCancelIds.length} из ${orderIdsToCancel.length}), но удалены из БД. SyncEngine восстановит состояние при следующей сверке.`,
                    );
                }

                this.logger.info(
                    `[${pair}] Атомарная транзакция (CANCEL Orders) УСПЕШНА. Успешно отменено: ${successfullyCancelledIds.length}, не удалось: ${failedToCancelIds.length}.`,
                );
            }
        }
    }

## 5\. Критерии Приемки (Acceptance Criteria)

1.  **\[Interface\]** `src/interfaces/types.ts` дополнен типами `LLMDecisionParameters`, `LLMAction`, `LLMDecision` и `ValidationResult`.
2.  **\[Service\]** `WorkerService.ts` (Singleton) создан и корректно принимает _все 9 зависимостей_ (Validator, Execution, DB, EventBus, Notification, GlobalState, AccountState, ExchangeRules, Config).
3.  **\[Signature (Архитектура)\]** `execute()` имеет _корректную_ сигнатуру, принимающую `(decision, logId, accountState, strategyContext, marketData)`.
4.  **\[Logic (Шаг 1 - Успех)\]** `execute()` _сначала_ вызывает `validatorService.validateDecision()`.
5.  **\[Logic (Шаг 1 - Провал)\]** Если `Validator` бросает `Error`, `execute()` **немедленно** входит в `catch (validationError)`, вызывает `_updateDecisionLog` (с `rejected_by_validator`), `notificationService.sendAlert` и **завершается** (`return`).
6.  **\[Logic (Шаг 2 - Успех)\]** Если `Validator` успешен, `execute()` вызывает `switch (decision.action)` и (STUB) `handle...` методы.
7.  **\[Logic (Шаг 2 - Успех)\]** После `handle...` (в `try`), `execute()` вызывает `_updateDecisionLog` (с `accepted`), `notificationService.sendAlert` (с `includeAccountState: true`).
8.  **\[Logic (Шаг 2 - Провал)\]** Если `handle...` (в `try`) бросает `Error`, `execute()` **немедленно** входит в `catch (executionError)`.
9.  **\[Logic (Шаг 2 - Провал)\]** В `catch (executionError)`, `execute()` вызывает `_updateDecisionLog` (с `failed_by_worker`) и `notificationService.sendAlert` (с `includeAccountState: true`).
10. **\[Robustness (План 7.1)\]** В `catch (executionError)` есть `if (executionError instanceof ccxt.InsufficientFundsError)`.

11. **\[Robustness (План 7.1)\]** Этот `if` _корректно_ вызывает `globalStateService.pause()` и `accountStateService.refreshNow()`.

12. **\[Robustness\]** `catch (executionError)` _повторно_ бросает (`throw`) ошибку, чтобы `PairActorManager` (Эпик 9) мог ее обработать.

13. **\[EventBus (Задача 7.1.3)\]** При _успешном_ исполнении (в `try`), `execute()` вызывает `eventBus.emit('trade_executed', pair)`.

14. **\[DB Logic\]** `_updateDecisionLog` корректно формирует `UPDATE` SQL-запрос.

15. **\[Stubs (7.2)\]** `handleOpenPosition` вызывает `_handleOpenMarketPosition` или `_handleOpenLimitPosition` в зависимости от `decision.parameters.type`.

16. **\[7.2 Transaction\]** `_handleOpenMarketPosition` _полностью_ обернут в `this.dbService.executeInTransaction()`.

17. **\[7.2 Step 1: Order\]** `_handleOpenMarketPosition` вызывает `this.executionService.createOrderWithRetry` (с `type: 'market'`).

18. **\[7.2 Step 1: Data\]** Корректно извлекаются `realEntryPrice`, `realAmount`, `realFeeCost` из `marketBuyOrder`. Добавлена проверка на `null` price/amount.

19. **\[7.2 Step 2: SL/TP\]** Корректно (через `executionService`) создаются ордера `stop_loss_limit` (для SL) и `limit` (для TP), если они указаны.

20. **\[7.2 Step 3: DB\]** _Внутри_ транзакции (используя `client`) _все_ таблицы обновляются: `ActivePositions`, `TradeHistory`, `ActiveOrders` (для SL и TP), `TSL_State` (если TSL включен).

21. **\[7.2 Step 3: DB (Robustness)\]** Добавлена обработка `DatabaseError` (unique violation) в `execute()` для отлавливания ошибок синхронизации.

22. **\[7.2.1 Stub\]** Создана новая приватная заглушка `_handleOpenLimitPosition`.

23. **\[7.3 Stubs\]** `handleClosePosition` вызывает `_handleCloseMarketPosition` или `_handleCloseLimitPosition` в зависимости от `decision.parameters.type`.

24. **\[7.3 Transaction\]** `_handleCloseMarketPosition` _полностью_ обернут в `this.dbService.executeInTransaction()`.

25. **\[7.3 Step 1: Get Position\]** _Внутри_ транзакции `_handleCloseMarketPosition` _сначала_ делает `SELECT ... FROM ActivePositions ... FOR UPDATE` для получения `amount` и `side`.

26. **\[7.3 Step 1: Robustness\]** Добавлена проверка `rowCount === 0` (ошибка синхронизации) после `SELECT`.

27. **\[7.3 Step 2: Close Order\]** Корректно определяется `closeSide` ('sell' для 'long', 'buy' для 'short').

28. **\[7.3 Step 3: Close Order\]** `_handleCloseMarketPosition` вызывает `this.executionService.createOrderWithRetry` (с `type: 'market'`, `closeSide`, `positionAmount`).

29. **\[7.3 Step 4: DB\]** _Внутри_ транзакции (используя `client`) _все_ таблицы очищаются: `DELETE FROM ActivePositions`, `DELETE FROM ActiveOrders`, `DELETE FROM TSL_State`.

30. **\[7.3 Step 5: DB\]** _Внутри_ транзакции `INSERT INTO TradeHistory` (для записи _выхода_).

31. **\[7.3.1 Transaction\]** `_handleCloseLimitPosition` _полностью_ обернут в `this.dbService.executeInTransaction()`.

32. **\[7.3.1 Step 1: Get Position\]** _Внутри_ транзакции `_handleCloseLimitPosition` _сначала_ делает `SELECT ... FROM ActivePositions ... FOR UPDATE`.

33. **\[7.3.1 Step 1: Robustness\]** Добавлена проверка `rowCount === 0` (ошибка синхронизации) после `SELECT`.

34. **\[7.3.1 Step 2: Validation\]** Добавлена проверка `if (!limitPrice)`, бросающая `Error`.

35. **\[7.3.1 Step 3: Create Order\]** `_handleCloseLimitPosition` вызывает `this.executionService.createOrderWithRetry` (с `type: 'limit'`, `closeSide`, `positionAmount`, `limitPrice`).

36. **\[7.3.1 Step 4: DB\]** _Внутри_ транзакции `_handleCloseLimitPosition` _только_ добавляет (`INSERT ... ON CONFLICT ...`) в `ActiveOrders` с `type = 'limit_close'`.

37. **\[7.3.1 Step 4: DB\]** `_handleCloseLimitPosition` **НЕ** удаляет из `ActivePositions` или `TSL_State`.

38. **\[7.4 Transaction\]** `handleModifyPosition` _полностью_ обернут в `this.dbService.executeInTransaction()`.

39. **\[7.4 Step 1: Get Position\]** _Внутри_ транзакции `handleModifyPosition` _сначала_ делает `SELECT ... FOR UPDATE` из `ActivePositions` (с `JOIN` или `sub-select`) для получения `side`, `amount` и ID существующих `stop_loss`, `take_profit` и `TSL` ордеров.

40. **\[7.4 Step 1: Robustness\]** Добавлена проверка `rowCount === 0` (ошибка синхронизации) после `SELECT`.

41. **\[7.4 Step 2: Logic (SL)\]** Если `new_stop_loss_price` предоставлен, реализована логика "Cancel-Then-Create" (Отменить-Затем-Создать). 4al\]\*\* `handleCancelOrders` _полностью_ обернут в `this.dbService.executeInTransaction()`.

42. **(НОВОЕ - 7.5) \[Architecture (Критично)\]** Отмена на бирже происходит **ДО** транзакции БД. Если отмена провалится, БД операция не начнется. Если отмена пройдет, а БД операция упадет - отмененные ордера будут "призраками" в БД.

43. **(НОВОЕ - 7.5) \[Logic (Case A: ID)\]** Если `order_id` предоставлен, `handleCancelOrders` вызывает `executionService.cancelOrderWithRetry()` для этого ID **ДО** транзакции БД в `try/catch` (продолжает выполнение даже при ошибке отмены).

44. **(НОВОЕ - 7.5) \[DB (Case A: ID)\]** _Внутри_ транзакции (`databaseService.executeInTransaction` с `PoolClient`), `handleCancelOrders` выполняет `DELETE FROM ActiveOrders WHERE exchange_order_id = $1` и (критично) `DELETE FROM TSL_State WHERE current_stop_order_id = $1` используя `orderIdToCancel`.

45. **(НОВОЕ - 7.5) \[Logic (Case B: null)\]** Если `order_id` равен `null` или `undefined`, `handleCancelOrders` _сначала_ делает `SELECT exchange_order_id FROM ActiveOrders WHERE pair = $1` (БЕЗ `FOR UPDATE`, ДО транзакции БД), чтобы получить _все_ ID. Если список пуст, возвращается с `warn`.

46. **(НОВОЕ - 7.5) \[Logic (Case B: null)\]** Затем `handleCancelOrders` циклически вызывает `executionService.cancelOrderWithRetry()` для _каждого_ полученного ID **ДО** транзакции БД, сохраняя успешно отмененные ID в `successfullyCancelledIds` и неотмененные в `failedToCancelIds`.

47. **(НОВОЕ - 7.5) \[DB (Case B: null)\]** _Внутри_ транзакции (`databaseService.executeInTransaction` с `PoolClient`), `handleCancelOrders` выполняет `DELETE FROM ActiveOrders WHERE pair = $1` и `DELETE FROM TSL_State WHERE pair = $1` (удаляет все ордера, включая неотмененные на бирже).

48. **(НОВОЕ - 7.5) \[Logging (Case B)\]** После транзакции логируется предупреждение, если часть ордеров не была отменена на бирже (`failedToCancelIds.length > 0`), с информацией о количестве успешно отмененных и неотмененных ордеров.

49. **(НОВОЕ - 7.5) \[Parameter Name\]** Используется `parameters.order_id` вместо `parameters.order_id_to_cancel`.
