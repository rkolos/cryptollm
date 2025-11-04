# Техническое Задание (ТЗ): 7.1 Диспетчер "Исполнителя" (WorkerService Dispatcher)

**Эпик:** 7. 👷 "Исполнитель" (Worker Service) **Задача:** 7.1, 7.1.3, 7.2, и **7.3 (Реализация `CLOSE (Market)`)** **Архитектор:** Gemini **Дата:** 29.10.2025

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

    // src/services/WorkerService.ts (Изменения 7.3)

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
                await client.query(
                    `INSERT INTO ActivePositions (
                        pair, side, amount, average_entry_price,
                        current_stop_loss_price, current_take_profit_price
                     ) VALUES ($1, $2, $3, $4, $5, $6)`,
                    [
                        pair,
                        (action === 'OPEN_LONG') ? 'long' : 'short',
                        realAmount,
                        realEntryPrice,
                        stop_loss_price?.toNumber() ?? null,
                        take_profit_price?.toNumber() ?? null
                    ]
                );

                // 2. Сохранить Историю (вход)
                await client.query(
                    `INSERT INTO TradeHistory (
                        timestamp, pair, side, amount, price, fee_cost, exchange_order_id
                     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [
                        new Date(realTimestamp),
                        pair,
                        (action === 'OPEN_LONG') ? 'long' : 'short',
                        realAmount,
                        realEntryPrice,
                        realFeeCost,
                        marketBuyOrder.id
                    ]
                );

                // 3. Сохранить SL ордер
                if (slOrder) {
                    await client.query(
                        `INSERT INTO ActiveOrders (
                            exchange_order_id, pair, status, type, side, price, amount
                         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                        [
                            slOrder.id, pair, slOrder.status, 'stop_loss',
                            slOrder.side, slOrder.price, slOrder.amount
                        ]
                    );
                }

                // 4. Сохранить TP ордер
                if (tpOrder) {
                    await client.query(
                        `INSERT INTO ActiveOrders (
                            exchange_order_id, pair, status, type, side, price, amount
                         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                        [
                            tpOrder.id, pair, tpOrder.status, 'take_profit',
                            tpOrder.side, tpOrder.price, tpOrder.amount
                        ]
                    );
                }

                // 5. Сохранить TSL (если есть)
                if (trailing_stop_config && slOrder) {
                    // (Критично) TSL привязан к ID SL-ордера
                    const tslConfigJson = JSON.stringify(trailing_stop_config);

                    await client.query(
                        `INSERT INTO TSL_State (
                            pair, current_sl_order_id, tsl_config_json,
                            side, amount, current_stop_price, highest_price_since_open
                         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                        [
                            pair,
                            slOrder.id,
                            tslConfigJson,
                            (action === 'OPEN_LONG') ? 'long' : 'short',
                            realAmount,
                            slOrder.price, // (Начальная цена SL)
                            realEntryPrice  // (Начальная "пиковая" цена = цена входа)
                        ]
                    );
                }

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
        private async handleClosePosition(decision: LLMDecision, validationResult: CalculatedAmounts): Promise<void> {
            const { type } = decision.parameters;

            if (type === 'market') {
                // Логика Задачи 7.3
                await this._handleCloseMarketPosition(decision, validationResult);
            } else if (type === 'limit') {
                // Логика Задачи 7.3.1
                await this._handleCloseLimitPosition(decision, validationResult);
            } else {
                throw new Error(`[${decision.pair}] Неизвестный тип ордера в handleClosePosition: ${type}`);
            }
        }

        // (НОВОЕ в 7.3) - Реализация `CLOSE (Market)`
        private async _handleCloseMarketPosition(
            decision: LLMDecision,
            _validationResult: CalculatedAmounts
        ): Promise<void> {
            const { pair, parameters } = decision;
            const { amount_percent } = parameters;

            this.logger.debug(`[${pair}] Запуск _handleCloseMarketPosition.`);

            // Критично: Вся операция выполняется в ОДНОЙ транзакции
            await this.databaseService.executeInTransaction(async (client: PoolClient): Promise<void> => {
                // --- Шаг 1: Получить Позицию из БД (и заблокировать строку) ---
                // Мы должны получить точное кол-во, сторону, цену входа и комиссию ПЕРЕД закрытием
                const positionResult = await client.query(
                    `SELECT amount, side, average_entry_price, total_fee_cost FROM ActivePositions WHERE pair = $1 FOR UPDATE`,
                    [pair]
                );

                if (!positionResult.rowCount || positionResult.rowCount === 0) {
                    // Это может случиться, если SL сработал за мгновение до этого
                    this.logger.warn(
                        `[${pair}] Попытка закрыть позицию, которая уже не существует в БД. (Возможно, SL/TP сработал?)`,
                    );
                    throw new Error(`[${pair}] (ОШИБКА СИНХРОНИЗАЦИИ) Позиция для закрытия не найдена в ActivePositions.`);
                }

                const currentPosition = positionResult.rows[0];
                const fullPositionAmountDecimal = new DecimalConstructor(currentPosition.amount.toString());
                const positionSide = currentPosition.side as 'long' | 'short';

                // --- Шаг 1.5: Расчет объема для закрытия на основе amount_percent ---
                const amountPercentDecimal = new DecimalConstructor(amount_percent!.toString());
                const fullAmountDecimal = fullPositionAmountDecimal as any;
                const percentDecimal = amountPercentDecimal as any;
                const hundred = new DecimalConstructor(100);
                // Рассчитываем объем для закрытия: position_amount * amount_percent / 100
                const closeAmountDecimal = fullAmountDecimal.mul(percentDecimal).div(hundred) as any as DecimalValue;

                // Определяем ордер на закрытие
                const closeSide: 'buy' | 'sell' = positionSide === 'long' ? 'sell' : 'buy';

                this.logger.debug(
                    `[${pair}] Закрытие ${positionSide} позиции. Объем позиции: ${fullPositionAmountDecimal.toString()}, Закрывается: ${closeAmountDecimal.toString()} (${amount_percent}%), Сторона ордера: ${closeSide}.`,
                );

                // --- Шаг 2: Отменяем все открытые ордера для данной пары ---
                // Это необходимо для спотового трейдинга, где стоп-лосс ордера блокируют токены
                try {
                    const openOrders = await this.exchangeService.fetchOpenOrders(pair);
                    if (openOrders.length > 0) {
                        this.logger.info(
                            `[${pair}] Найдено ${openOrders.length} открытых ордеров. Отменяем их перед закрытием позиции...`,
                        );
                        const cancelPromises = openOrders.map((order: IDecimalOrder) =>
                            this.executionService.cancelOrderWithRetry(order.id, pair).catch((cancelError) => {
                                this.logger.warn(`[${pair}] Не удалось отменить ордер ${order.id}:`, cancelError);
                            }),
                        );
                        await Promise.all(cancelPromises);
                        this.logger.info(`[${pair}] Все открытые ордера отменены.`);
                    }
                } catch (error) {
                    this.logger.error(`[${pair}] Ошибка при отмене открытых ордеров:`, error);
                    // Продолжаем выполнение, так как это не критично
                }

                // --- Шаг 3: Создание Market ордера на Закрытие ---
                const closeMarketOrder = await this.executionService.createOrderWithRetry(
                    pair,
                    'market',
                    closeSide,
                    closeAmountDecimal,
                );

                // Извлекаем РЕАЛЬНЫЕ данные исполнения
                const orderAny = closeMarketOrder as any;
                const realClosePrice = orderAny.average || orderAny.price;
                const realAmount = orderAny.filled || orderAny.amount;
                const realFeeCost = orderAny.fee?.cost ?? new DecimalConstructor(0);
                const realTimestamp = orderAny.timestamp ?? Date.now();

                if (!realClosePrice || !realAmount) {
                    throw new Error(
                        `[${pair}] КРИТИЧЕСКАЯ ОШИБКА: Market ордер (Закрытие) ${closeMarketOrder.id} вернул 'null' price или 'null' amount.`,
                    );
                }

                this.logger.debug(
                    `[${pair}] Market ордер (Закрытие) ${closeMarketOrder.id} исполнен. Price: ${realClosePrice.toString()}, Amount: ${realAmount.toString()}`,
                );

                // Конвертируем DecimalValue в Decimal для вычислений
                const closePriceDecimal = new DecimalConstructor(realClosePrice.toString());
                const amountDecimal = new DecimalConstructor(realAmount.toString());
                const closeFeeCostDecimal = new DecimalConstructor(realFeeCost.toString() || '0');

                // --- Расчет Realized PnL (с учетом частичного закрытия) ---
                const entryPriceDecimal = new DecimalConstructor(currentPosition.average_entry_price.toString());
                const fullEntryFeeCostDecimal = new DecimalConstructor(currentPosition.total_fee_cost?.toString() || '0');

                // Для частичного закрытия: пропорционально распределяем комиссию входа
                const fullAmountDecimalForFeeCalc = fullPositionAmountDecimal as any;
                const closeAmountDecimalForCalc = amountDecimal as any;
                const fullEntryFeeDecimal = fullEntryFeeCostDecimal as any;

                // Проверка деления на ноль (защита от edge cases)
                const zero = new DecimalConstructor(0);
                if (fullAmountDecimalForFeeCalc.isZero() || fullAmountDecimalForFeeCalc.eq(zero)) {
                    throw new Error(
                        `[${pair}] КРИТИЧЕСКАЯ ОШИБКА: Размер позиции равен нулю. Невозможно рассчитать пропорциональную комиссию.`,
                    );
                }

                // Пропорциональная доля комиссии входа: (close_amount / full_amount) * entry_fee
                const proportionalEntryFeeResult = closeAmountDecimalForCalc
                    .div(fullAmountDecimalForFeeCalc)
                    .mul(fullEntryFeeDecimal);
                const proportionalEntryFee = proportionalEntryFeeResult as any as DecimalValue;
                const closeFeeDecimal = closeFeeCostDecimal as any;

                let realizedPnlUsd: DecimalValue;
                if (positionSide === 'long') {
                    // Для LONG: PnL = (close_price - entry_price) * amount - proportional_entry_fee - close_fee
                    const priceDiffDecimal = (closePriceDecimal as any).minus(entryPriceDecimal);
                    const amountDecimalForCalc = amountDecimal as any;
                    const grossPnl = priceDiffDecimal.mul(amountDecimalForCalc);
                    const totalFees = proportionalEntryFee.plus(closeFeeDecimal);
                    realizedPnlUsd = grossPnl.minus(totalFees) as DecimalValue;
                } else {
                    // Для SHORT: PnL = (entry_price - close_price) * amount - proportional_entry_fee - close_fee
                    const priceDiffDecimal = (entryPriceDecimal as any).minus(closePriceDecimal);
                    const amountDecimalForCalc = amountDecimal as any;
                    const grossPnl = priceDiffDecimal.mul(amountDecimalForCalc);
                    const totalFees = proportionalEntryFee.plus(closeFeeDecimal);
                    realizedPnlUsd = grossPnl.minus(totalFees) as DecimalValue;
                }

                // Логируем PnL
                const realizedPnlDecimal = realizedPnlUsd as any;
                this.logger.info(
                    `[${pair}] Realized PnL: ${realizedPnlDecimal.toFixed(2)} USDT (Entry: ${entryPriceDecimal.toString()}, Close: ${closePriceDecimal.toString()}, Amount: ${amountDecimal.toString()})`,
                );

                // --- Шаг 4: Определяем, полное или частичное закрытие ---
                const amountDecimalForCheck = amountDecimal as any;
                const isFullClose = amountDecimalForCheck.gte(fullAmountDecimalForFeeCalc) || amountPercentDecimal.gte(hundred);

                // --- Шаг 5: Атомарное обновление БД ---
                if (isFullClose) {
                    // Полное закрытие: удаляем позицию и все связанные данные
                    // 1. Удалить Позицию
                    await client.query(`DELETE FROM ActivePositions WHERE pair = $1`, [pair]);

                    // 2. Удалить ВСЕ связанные ордера (SL, TP, Limit)
                    await client.query(`DELETE FROM ActiveOrders WHERE pair = $1`, [pair]);

                    // 3. Удалить ВСЕ связанные TSL
                    await client.query(`DELETE FROM TSL_State WHERE pair = $1`, [pair]);
                } else {
                    // Частичное закрытие: обновляем позицию и пропорционально распределяем комиссии
                    const remainingAmount = fullAmountDecimalForFeeCalc.minus(amountDecimalForCheck) as any as DecimalValue;
                    const remainingEntryFee = fullEntryFeeDecimal.minus(proportionalEntryFee) as any as DecimalValue;

                    // 1. Обновить Позицию (уменьшаем amount и fee_cost)
                    await client.query(`UPDATE ActivePositions SET amount = $1, total_fee_cost = $2 WHERE pair = $3`, [
                        remainingAmount.toString(),
                        remainingEntryFee.toString(),
                        pair,
                    ]);

                    // 2. Обновить размеры связанных ордеров (SL, TP) пропорционально
                    const remainingAmountDecimal = remainingAmount as any;
                    await client.query(
                        `UPDATE ActiveOrders SET amount = $1 WHERE pair = $2 AND type IN ('stop_loss_limit', 'take_profit_limit')`,
                        [remainingAmountDecimal.toString(), pair],
                    );

                    // 3. TSL остается активным (price_seen обновляется автоматически при тиках)
                }

                // 4. Сохранить Историю (выход) с calculated PnL
                // Для exchange_trade_id используем order.id + timestamp + случайный UUID для гарантированной уникальности
                const { randomUUID } = await import('crypto');
                const uniqueSuffix = randomUUID().substring(0, 8);
                const exchangeTradeId = `${closeMarketOrder.id}-${realTimestamp}-${uniqueSuffix}`;
                const feeCurrency = (orderAny.fee?.currency as string) || 'USDT';

                await client.query(
                    `INSERT INTO TradeHistory (
                        timestamp, exchange_trade_id, exchange_order_id, pair, side, price, amount, fee_cost, fee_currency, realized_pnl_usd
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                    [
                        new Date(realTimestamp),
                        exchangeTradeId,
                        closeMarketOrder.id,
                        pair,
                        closeSide, // Сторона ордера ('buy' или 'sell')
                        closePriceDecimal.toNumber(),
                        amountDecimal.toNumber(),
                        closeFeeCostDecimal.toNumber(),
                        feeCurrency,
                        realizedPnlDecimal.toNumber(),
                    ],
                );

                this.logger.info(`[${pair}] Атомарная транзакция (CLOSE Market) УСПЕШНА.`);
            });
        }

        // (НОВОЕ в 7.3) - Заглушка для Задачи 7.3.1
        private async _handleCloseLimitPosition(decision: LLMDecision, validationResult: ValidationResult): Promise<Order | null> {
            this.logger.debug(`[${decision.pair}] (STUB) Вызов _handleCloseLimitPosition...`);
            // (Логика Задачи 7.3.1 будет здесь)
            return null;
        }

        private async handleModifyPosition(decision: LLMDecision, validationResult: ValidationResult): Promise<Order | null> {
            this.logger.debug(`[${decision.pair}] (STUB) Вызов handleModifyPosition...`);
            // (Логика Задачи 7.4 будет здесь)
            return null;
        }

        private async handleCancelOrders(decision: LLMDecision, validationResult: ValidationResult): Promise<void> {
            this.logger.debug(`[${decision.pair}] (STUB) Вызов handleCancelOrders...`);
            // (Логика Задачи 7.5 будет здесь)
        }
    }

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Interface

    `src/interfaces/types.ts` дополнен типами `LLMDecisionParameters`, `LLMAction`, `LLMDecision` и `ValidationResult`.

2.  Service

    `WorkerService.ts` (Singleton) создан и корректно принимает _все 9 зависимостей_ (Validator, Execution, DB, EventBus, Notification, GlobalState, AccountState, ExchangeRules, Config).

3.  Signature(Архитектура)

    `execute()` имеет _корректную_ сигнатуру, принимающую `(decision, logId, accountState, strategyContext, marketData)`.

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

16. **(НОВОЕ - 7.2) \[Transaction (Критично)\]** `_handleOpenMarketPosition` _полностью_ обернут в `this.dbService.executeInTransaction()`.

17. **(НОВОЕ - 7.2) \[Step 1: Order\]** `_handleOpenMarketPosition` вызывает `this.executionService.createOrderWithRetry` (с `type: 'market'`).

18. **(НОВОЕ - 7.2) \[Step 1: Data\]** Корректно извлекаются `realEntryPrice`, `realAmount`, `realFeeCost` из `marketBuyOrder`. Добавлена проверка на `null` price/amount.

19. **(НОВОЕ - 7.2) \[Step 2: SL/TP\]** Корректно (через `executionService`) создаются ордера `stop_loss_limit` (для SL) и `limit` (для TP), если они указаны.

20. **(НОВОЕ - 7.2) \[Step 3: DB (Критично)\]** _Внутри_ транзакции (используя `client`) _все_ таблицы обновляются: `ActivePositions`, `TradeHistory`, `ActiveOrders` (для SL и TP), `TSL_State` (если TSL включен).

21. **(НОВОЕ - 7.2) \[Step 3: DB (Robustness)\]** Добавлена обработка `DatabaseError` (unique violation) в `execute()` для отлавливания ошибок синхронизации.

22. **(НОВОЕ - 7.2) \[Stub 7.2.1\]** Создана новая приватная заглушка `_handleOpenLimitPosition`.

23. **(НОВОЕ - 7.3) \[Stubs (7.3)\]** `handleClosePosition` вызывает `_handleCloseMarketPosition` или `_handleCloseLimitPosition` в зависимости от `decision.parameters.type`.

24. **(НОВОЕ - 7.3) \[Transaction (Критично)\]** `_handleCloseMarketPosition` _полностью_ обернут в `this.databaseService.executeInTransaction()` (использует `PoolClient` вместо `TransactionClient`).

25. **(НОВОЕ - 7.3) \[Step 1: Get Position\]** _Внутри_ транзакции `_handleCloseMarketPosition` _сначала_ делает `SELECT amount, side, average_entry_price, total_fee_cost FROM ActivePositions ... FOR UPDATE` для получения полной информации о позиции.

26. **(НОВОЕ - 7.3) \[Step 1: Robustness\]** Добавлена проверка `!positionResult.rowCount || positionResult.rowCount === 0` (ошибка синхронизации) после `SELECT`.

27. **(НОВОЕ - 7.3) \[Step 1.5: Partial Close\]** Реализована логика частичного закрытия через `amount_percent`: рассчитывается `closeAmountDecimal = fullPositionAmount * amount_percent / 100` с использованием `Decimal` методов.

28. **(НОВОЕ - 7.3) \[Step 2: Cancel Orders\]** Перед закрытием отменяются все открытые ордера через `exchangeService.fetchOpenOrders(pair)` и `executionService.cancelOrderWithRetry()` для каждого ордера в `Promise.all` с обработкой ошибок через `.catch()`.

29. **(НОВОЕ - 7.3) \[Step 3: Close Order\]** `_handleCloseMarketPosition` вызывает `this.executionService.createOrderWithRetry` (с `type: 'market'`, `closeSide`, `closeAmountDecimal` вместо полного `positionAmount`).

30. **(НОВОЕ - 7.3) \[Step 3: PnL Calculation\]** Реализован расчет Realized PnL с учетом частичного закрытия: пропорциональное распределение комиссии входа (`proportionalEntryFee = (close_amount / full_amount) * entry_fee`), расчет PnL для LONG (`(close_price - entry_price) * amount - fees`) и SHORT (`(entry_price - close_price) * amount - fees`).

31. **(НОВОЕ - 7.3) \[Step 4: Full/Partial Logic\]** Реализована логика определения полного/частичного закрытия: `isFullClose = amount.gte(fullAmount) || amount_percent.gte(100)`.

32. **(НОВОЕ - 7.3) \[Step 5: DB (Full Close)\]** При полном закрытии _внутри_ транзакции (используя `client`) _все_ таблицы очищаются: `DELETE FROM ActivePositions`, `DELETE FROM ActiveOrders`, `DELETE FROM TSL_State`.

33. **(НОВОЕ - 7.3) \[Step 5: DB (Partial Close)\]** При частичном закрытии: `UPDATE ActivePositions SET amount = remainingAmount, total_fee_cost = remainingEntryFee`, `UPDATE ActiveOrders SET amount = remainingAmount WHERE type IN ('stop_loss_limit', 'take_profit_limit')`, TSL остается активным.

34. **(НОВОЕ - 7.3) \[Step 6: DB (TradeHistory)\]** _Внутри_ транзакции `INSERT INTO TradeHistory` включает `exchange_trade_id` (генерируется как `order.id-timestamp-UUID`), `realized_pnl_usd`, `fee_currency` из `order.fee.currency`.

35. **(НОВОЕ - 7.3) \[Return Type\]** `_handleCloseMarketPosition` возвращает `Promise<void>` вместо `Promise<Order>`.

36. **(НОВОЕ - 7.3) \[Stub 7.3.1\]** Создана новая приватная заглушка `_handleCloseLimitPosition`.
