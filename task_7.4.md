# Техническое Задание (ТЗ): 7.1 Диспетчер "Исполнителя" (WorkerService Dispatcher)

**Эпик:** 7. 👷 "Исполнитель" (Worker Service) **Задача:** 7.1, 7.1.3, 7.2, 7.3, 7.3.1, и **7.4 (Реализация `MODIFY_POSITION`)** **Архитектор:** Gemini **Дата:** 29.10.2025

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

    // src/services/WorkerService.ts (Изменения 7.4)

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
                // (Мы должны получить точное кол-во и сторону ПЕРЕД закрытием)
                const positionResult = await client.query(
                    `SELECT amount, side FROM ActivePositions WHERE pair = $1 FOR UPDATE`,
                    [pair]
                );

                if (positionResult.rowCount === 0) {
                    // (Это может случиться, если SL сработал за мгновение до этого)
                    this.logger.warn(`[${pair}] Попытка закрыть позицию, которая уже не существует в БД. (Возможно, SL/TP сработал?)`);
                    throw new Error(`[${pair}] (ОШИБКА СИНХРОНИЗАЦИИ) Позиция для закрытия не найдена в ActivePositions.`);
                }

                const currentPosition = positionResult.rows[0];
                const positionAmount = new Decimal(currentPosition.amount);
                const positionSide = currentPosition.side; // 'long' или 'short'

                // (Определяем ордер на закрытие)
                const closeSide: OrderSide = (positionSide === 'long') ? 'sell' : 'buy';

                this.logger.debug(`[${pair}] Закрытие ${positionSide} позиции. Объем: ${positionAmount}, Сторона ордера: ${closeSide}.`);

                // --- Шаг 2: (Архитектура 7.3) - НЕ отменять ордера ---
                // Мы НЕ вызываем `cancelAllOrders` здесь, чтобы избежать "гонок".
                // Вместо этого мы атомарно удалим их из ActiveOrders (Шаг 4).
                // "Осиротевшие" ордера на бирже будут очищены "Сверщиком" (SyncEngine 5.1).

                // --- Шаг 3: Создание Market ордера на Закрытие ---
                const closeMarketOrder = await this.executionService.createOrderWithRetry(
                    pair,
                    'market',
                    closeSide,
                    positionAmount
                );

                // (Извлекаем РЕАЛЬНЫЕ данные исполнения)
                const realClosePrice = closeMarketOrder.average || closeMarketOrder.price;
                const realAmount = closeMarketOrder.filled || closeMarketOrder.amount;
                const realFeeCost = closeMarketOrder.fee?.cost ?? 0;
                const realTimestamp = closeMarketOrder.timestamp ?? Date.now();

                if (!realClosePrice || !realAmount) {
                    throw new Error(`[${pair}] КРИТИЧЕСКАЯ ОШИБКА: Market ордер (Закрытие) ${closeMarketOrder.id} вернул 'null' price или 'null' amount.`);
                }

                this.logger.debug(`[${pair}] Market ордер (Закрытие) ${closeMarketOrder.id} исполнен. Price: ${realClosePrice}, Amount: ${realAmount}`);

                // --- Шаг 4: Атомарная Очистка БД ---

                // 1. Удалить Позицию
                await client.query(
                    `DELETE FROM ActivePositions WHERE pair = $1`, [pair]
                );

                // 2. Удалить ВСЕ связанные ордера (SL, TP, Limit)
                await client.query(
                    `DELETE FROM ActiveOrders WHERE pair = $1`, [pair]
                );

                // 3. Удалить ВСЕ связанные TSL
                await client.query(
                    `DELETE FROM TSL_State WHERE pair = $1`, [pair]
                );

                // 4. Сохранить Историю (выход)
                await client.query(
                    `INSERT INTO TradeHistory (
                        timestamp, pair, side, amount, price, fee_cost, exchange_order_id
                     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [
                        new Date(realTimestamp),
                        pair,
                        (positionSide === 'long') ? 'sell' : 'buy', // (Сторона ордера)
                        realAmount,
                        realClosePrice,
                        realFeeCost,
                        closeMarketOrder.id
                    ]
                );

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
                const positionResult = await client.query(
                    `SELECT amount, side FROM ActivePositions WHERE pair = $1 FOR UPDATE`,
                    [pair]
                );

                if (positionResult.rowCount === 0) {
                    this.logger.warn(`[${pair}] Попытка установить Limit Close для позиции, которая не существует в БД.`);
                    throw new Error(`[${pair}] (ОШИБКА СИНХРОНИЗАЦИИ) Позиция для Limit Close не найдена в ActivePositions.`);
                }

                const currentPosition = positionResult.rows[0];
                const positionAmount = new Decimal(currentPosition.amount);
                const positionSide = currentPosition.side; // 'long' или 'short'

                // (Определяем ордер на закрытие)
                const closeSide: OrderSide = (positionSide === 'long') ? 'sell' : 'buy';

                this.logger.debug(`[${pair}] Установка Limit Close (TP) для ${positionSide} позиции. Объем: ${positionAmount}, Сторона: ${closeSide}.`);

                // --- Шаг 2: Создание Limit ордера на Закрытие ---
                const newLimitOrder = await this.executionService.createOrderWithRetry(
                    pair,
                    'limit',
                    closeSide,
                    positionAmount,
                    limitPrice
                );

                this.logger.debug(`[${pair}] Limit ордер (Закрытие) ${newLimitOrder.id} создан.`);

                // --- Шаг 3: Атомарная Запись Ордера в БД ---
                // (Мы НЕ удаляем позицию, т.к. ордер еще не исполнен)

                await client.query(
                    `INSERT INTO ActiveOrders (
                        exchange_order_id, pair, status, type, side, price, amount
                     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
                     ON CONFLICT (exchange_order_id) DO UPDATE SET
                        status = excluded.status,
                        price = excluded.price,
                        amount = excluded.amount
                    `,
                    [
                        newLimitOrder.id, pair, newLimitOrder.status,
                        'limit_close', // (Наш внутренний тип)
                        newLimitOrder.side, newLimitOrder.price, newLimitOrder.amount
                    ]
                );

                this.logger.info(`[${pair}] Атомарная транзакция (CLOSE Limit) УСПЕШНА.`);

                return newLimitOrder;
            });
        }

        // (ИЗМЕНЕНО в 7.4) - Реализация `MODIFY_POSITION`
        private async handleModifyPosition(
            decision: LLMDecision,
            _validationResult: CalculatedAmounts
        ): Promise<void> {
            const { pair, parameters } = decision;
            const { new_stop_loss_price, new_take_profit_price, new_trailing_stop_config } = parameters;

            this.logger.debug(`[${pair}] Запуск handleModifyPosition...`);

            // КРИТИЧНО: Отмена и создание ордеров на бирже должны происходить ДО транзакции БД
            // Если БД операция упадет, нужно отменить созданные ордера

            // --- Шаг 1: Получить информацию о позиции (БЕЗ блокировки, для чтения) ---
            const positionCheckResult = await this.databaseService.query(
                `SELECT
                    p.side, p.amount,
                    (SELECT exchange_order_id FROM ActiveOrders WHERE pair = $1 AND type = 'stop_loss_limit' LIMIT 1) as current_sl_id,
                    (SELECT exchange_order_id FROM ActiveOrders WHERE pair = $1 AND type = 'take_profit_limit' LIMIT 1) as current_tp_id,
                    (SELECT current_stop_order_id FROM TSL_State WHERE pair = $1 LIMIT 1) as current_tsl_sl_id
                FROM ActivePositions p
                WHERE p.pair = $1`,
                [pair]
            );

            if (!positionCheckResult.rowCount || positionCheckResult.rowCount === 0) {
                this.logger.warn(`[${pair}] Попытка MODIFY_POSITION для несуществующей позиции.`);
                throw new Error(`[${pair}] (ОШИБКА СИНХРОНИЗАЦИИ) Позиция для MODIFY не найдена в ActivePositions.`);
            }

            const pos = positionCheckResult.rows[0];
            const oppositeSide: 'buy' | 'sell' = pos.side === 'long' ? 'sell' : 'buy';
            const positionAmountDecimal = new DecimalConstructor(pos.amount.toString());
            let newSlOrder: IDecimalOrder | null = null;
            let newTpOrder: IDecimalOrder | null = null;
            const ordersToCancel: string[] = [];

            // Объявляем oldSlId вне блока if для использования в catch
            const oldSlId = pos.current_tsl_sl_id || pos.current_sl_id;
            let oldSlPriceForRollback: DecimalValue | null = null;
            let oldSlAmountForRollback: DecimalValue | null = null;

            // --- Шаг 2: Обработка нового Stop Loss (если запрошен) ДО транзакции БД ---
            if (new_stop_loss_price !== null && new_stop_loss_price !== undefined) {
                this.logger.debug(`[${pair}] Модификация SL. Новая цена: ${new_stop_loss_price}`);

                // 2.1. Отмена старого SL на бирже (сохраняем данные для возможного rollback)
                if (oldSlId) {
                    try {
                        // ВАЖНО: Получаем данные старого SL из БД ПЕРЕД отменой (для rollback)
                        const oldSlOrderResult = await this.databaseService.query(
                            `SELECT price, amount FROM ActiveOrders WHERE exchange_order_id = $1`,
                            [oldSlId]
                        );

                        if (oldSlOrderResult.rowCount && oldSlOrderResult.rowCount > 0) {
                            const oldSlData = oldSlOrderResult.rows[0];
                            oldSlPriceForRollback = new DecimalConstructor(oldSlData.price.toString());
                            oldSlAmountForRollback = new DecimalConstructor(oldSlData.amount.toString());
                            this.logger.debug(
                                `[${pair}] Сохранены параметры старого SL для rollback: price=${oldSlPriceForRollback.toString()}, amount=${oldSlAmountForRollback.toString()}`,
                            );
                        }

                        await this.executionService.cancelOrderWithRetry(oldSlId, pair);
                        ordersToCancel.push(oldSlId);
                        this.logger.debug(`[${pair}] Старый SL ордер ${oldSlId} отменен на бирже.`);
                    } catch (cancelError) {
                        this.logger.warn(`[${pair}] Не удалось отменить старый SL ордер ${oldSlId}:`, cancelError);
                        // Продолжаем работу, возможно ордер уже исполнен или отменен
                    }
                }

                // 2.2. Создание нового SL на бирже
                const slPriceDecimal = new DecimalConstructor(new_stop_loss_price.toString());
                const slPriceParams = { stopPrice: slPriceDecimal.toNumber() };

                try {
                    newSlOrder = await this.executionService.createOrderWithRetry(
                        pair,
                        'stop_loss_limit',
                        oppositeSide,
                        positionAmountDecimal,
                        slPriceDecimal,
                        slPriceParams,
                    );
                    this.logger.debug(`[${pair}] Новый SL ордер ${newSlOrder.id} создан на бирже.`);
                } catch (createError) {
                    // КРИТИЧЕСКИЙ СБОЙ: новый SL не создан, но старый уже отменен
                    // Попытка восстановить старый SL (rollback)
                    this.logger.error(
                        `[${pair}] Не удалось создать новый SL ордер. Попытка восстановить старый SL...`,
                        createError,
                    );

                    if (oldSlId && oldSlPriceForRollback && oldSlAmountForRollback) {
                        try {
                            const oldSlPriceParams = { stopPrice: oldSlPriceForRollback.toNumber() };

                            // Пытаемся восстановить старый SL (может не сработать, если ордер уже исполнен на бирже)
                            await this.executionService
                                .createOrderWithRetry(
                                    pair,
                                    'stop_loss_limit',
                                    oppositeSide,
                                    oldSlAmountForRollback,
                                    oldSlPriceForRollback,
                                    oldSlPriceParams,
                                )
                                .then(() => {
                                    this.logger.warn(
                                        `[${pair}] Старый SL ордер восстановлен. Позиция снова под защитой. Но MODIFY_POSITION провалился.`,
                                    );
                                })
                                .catch((rollbackError) => {
                                    this.logger.error(
                                        `[${pair}] Не удалось восстановить старый SL ордер (возможно, он уже исполнен):`,
                                        rollbackError,
                                    );
                                    this.logger.error(`[${pair}] КРИТИЧЕСКАЯ СИТУАЦИЯ: Позиция может остаться без защиты!`);
                                });
                        } catch (rollbackError) {
                            this.logger.error(`[${pair}] КРИТИЧЕСКАЯ ОШИБКА при попытке rollback старого SL:`, rollbackError);
                        }
                    } else {
                        this.logger.error(`[${pair}] Невозможно выполнить rollback: данные старого SL не были сохранены.`);
                    }

                    throw createError;
                }
            }

            // --- Шаг 3: Обработка нового Take Profit (если запрошен) ДО транзакции БД ---
            if (new_take_profit_price !== null && new_take_profit_price !== undefined) {
                this.logger.debug(`[${pair}] Модификация TP. Новая цена: ${new_take_profit_price}`);

                // 3.1. Отмена старого TP на бирже
                if (pos.current_tp_id) {
                    try {
                        await this.executionService.cancelOrderWithRetry(pos.current_tp_id, pair);
                        ordersToCancel.push(pos.current_tp_id);
                        this.logger.debug(`[${pair}] Старый TP ордер ${pos.current_tp_id} отменен на бирже.`);
                    } catch (cancelError) {
                        this.logger.warn(`[${pair}] Не удалось отменить старый TP ордер ${pos.current_tp_id}:`, cancelError);
                    }
                }

                // 3.2. Создание нового TP на бирже
                const tpPriceDecimal = new DecimalConstructor(new_take_profit_price.toString());

                try {
                    newTpOrder = await this.executionService.createOrderWithRetry(
                        pair,
                        'limit',
                        oppositeSide,
                        positionAmountDecimal,
                        tpPriceDecimal,
                    );
                    this.logger.debug(`[${pair}] Новый TP ордер ${newTpOrder.id} создан на бирже.`);
                } catch (createError) {
                    this.logger.error(`[${pair}] Не удалось создать новый TP ордер:`, createError);
                    // Если SL был создан, отменяем его
                    if (newSlOrder) {
                        try {
                            await this.executionService.cancelOrderWithRetry(newSlOrder.id, pair);
                        } catch (cancelError) {
                            this.logger.error(`[${pair}] Не удалось отменить только что созданный SL ордер:`, cancelError);
                        }
                    }
                    throw createError;
                }
            }

            // --- Шаг 4: Атомарное обновление БД ---
            try {
                await this.databaseService.executeInTransaction(async (client: PoolClient): Promise<void> => {
                    // Блокируем позицию для обновления
                    const queryResult = await client.query(`SELECT side, amount FROM ActivePositions WHERE pair = $1 FOR UPDATE`, [
                        pair,
                    ]);

                    if (!queryResult.rowCount || queryResult.rowCount === 0) {
                        throw new Error(`[${pair}] Позиция исчезла из БД во время MODIFY.`);
                    }

                    // 4.1. Удаляем старые ордера из БД
                    for (const orderId of ordersToCancel) {
                        await client.query(`DELETE FROM ActiveOrders WHERE exchange_order_id = $1`, [orderId]);
                        await client.query(`DELETE FROM TSL_State WHERE current_stop_order_id = $1`, [orderId]);
                    }

                    // 4.2. Сохранение нового SL в БД
                    if (newSlOrder) {
                        const slOrderAny = newSlOrder as any;
                        const slPrice = slOrderAny.price || slOrderAny.stopPrice || new_stop_loss_price;
                        const slPriceDecimalForDb = new DecimalConstructor(slPrice.toString());

                        await client.query(
                            `INSERT INTO ActiveOrders (exchange_order_id, pair, status, type, side, price, amount)
                             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                            [
                                newSlOrder.id,
                                pair,
                                newSlOrder.status || 'open',
                                'stop_loss_limit',
                                newSlOrder.side,
                                slPriceDecimalForDb.toNumber(),
                                positionAmountDecimal.toNumber(),
                            ],
                        );

                        // Обновляем цену в ActivePositions
                        await client.query(`UPDATE ActivePositions SET stop_loss_price = $1 WHERE pair = $2`, [
                            slPriceDecimalForDb.toNumber(),
                            pair,
                        ]);

                        // 4.3. Логика сохранения/обновления TSL (если запрошен)
                        if (new_trailing_stop_config) {
                            this.logger.debug(`[${pair}] (Re)Configuring TSL...`);
                            const tslConfigJson = JSON.stringify(new_trailing_stop_config);

                            await client.query(
                                `INSERT INTO TSL_State (pair, current_stop_price, current_stop_order_id, price_seen, rule_config_json)
                                 VALUES ($1, $2, $3, $4, $5)
                                 ON CONFLICT (pair) DO UPDATE SET
                                   current_stop_price = excluded.current_stop_price,
                                   current_stop_order_id = excluded.current_stop_order_id,
                                   price_seen = excluded.price_seen,
                                   rule_config_json = excluded.rule_config_json,
                                   updated_at = NOW()`,
                                [pair, slPriceDecimalForDb.toNumber(), newSlOrder.id, slPriceDecimalForDb.toNumber(), tslConfigJson],
                            );
                        } else if (ordersToCancel.length > 0) {
                            // Если TSL был отключен, удаляем его состояние
                            await client.query(`DELETE FROM TSL_State WHERE pair = $1`, [pair]);
                        }
                    }

                    // 4.4. Сохранение нового TP в БД
                    if (newTpOrder) {
                        const tpOrderAny = newTpOrder as any;
                        const tpPrice = tpOrderAny.price || new_take_profit_price;
                        const tpPriceDecimalForDb = new DecimalConstructor(tpPrice.toString());

                        await client.query(
                            `INSERT INTO ActiveOrders (exchange_order_id, pair, status, type, side, price, amount)
                             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                            [
                                newTpOrder.id,
                                pair,
                                newTpOrder.status || 'open',
                                'take_profit_limit',
                                newTpOrder.side,
                                tpPriceDecimalForDb.toNumber(),
                                positionAmountDecimal.toNumber(),
                            ],
                        );
                    }

                    this.logger.info(`[${pair}] Атомарная транзакция (MODIFY_POSITION) УСПЕШНА.`);
                });
            } catch (dbError) {
                // КРИТИЧЕСКИЙ СБОЙ: БД операция упала, но новые ордера уже созданы на бирже
                // Отменяем их, чтобы избежать "зомби" ордеров
                this.logger.error(`[${pair}] КРИТИЧЕСКИЙ СБОЙ: БД транзакция провалилась. Отменяем новые ордера...`, dbError);

                const cancelPromises: Promise<void>[] = [];
                if (newSlOrder) {
                    cancelPromises.push(
                        this.executionService.cancelOrderWithRetry(newSlOrder.id, pair).catch((cancelError) => {
                            this.logger.error(`[${pair}] Не удалось отменить новый SL ордер ${newSlOrder.id}:`, cancelError);
                        }),
                    );
                }
                if (newTpOrder) {
                    cancelPromises.push(
                        this.executionService.cancelOrderWithRetry(newTpOrder.id, pair).catch((cancelError) => {
                            this.logger.error(`[${pair}] Не удалось отменить новый TP ордер ${newTpOrder.id}:`, cancelError);
                        }),
                    );
                }

                await Promise.allSettled(cancelPromises);
                this.logger.warn(
                    `[${pair}] Новые ордера отменены. Старые ордера уже отменены, позиция в несогласованном состоянии. SyncEngine восстановит состояние при следующей сверке.`,
                );

                // Пробрасываем ошибку выше
                throw dbError;
            }
        }

        // (ИЗМЕНЕНО в 7.4) - Заглушка для Задачи 7.5
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

38. **(НОВОЕ - 7.4) \[Architecture (Критично)\]** Отмена и создание ордеров на бирже происходят **ДО** транзакции БД. Если БД операция упадет, созданные ордера отменяются.

39. **(НОВОЕ - 7.4) \[Step 1: Get Position (Read-Only)\]** `handleModifyPosition` _сначала_ делает `SELECT` (БЕЗ `FOR UPDATE`) из `ActivePositions` с sub-select для получения `side`, `amount` и ID существующих `stop_loss_limit`, `take_profit_limit` и `TSL` ордеров (используется `current_stop_order_id` вместо `current_sl_order_id`).

40. **(НОВОЕ - 7.4) \[Step 1: Robustness\]** Добавлена проверка `!positionCheckResult.rowCount || positionCheckResult.rowCount === 0` (ошибка синхронизации) после `SELECT`.

41. **(НОВОЕ - 7.4) \[Step 2: Cancel (SL) - Before DB\]** Если `new_stop_loss_price` предоставлен, логика отмены старого SL происходит **ДО** транзакции БД: получает данные старого SL из БД для rollback, вызывает `executionService.cancelOrderWithRetry()` на бирже, сохраняет ID в `ordersToCancel`.

42. **(НОВОЕ - 7.4) \[Step 2: Create (SL) - Before DB\]** Логика создания нового SL происходит **ДО** транзакции БД: вызывает `executionService.createOrderWithRetry()` для `stop_loss_limit`, сохраняет результат в `newSlOrder`.

43. **(НОВОЕ - 7.4) \[Step 2: Rollback (SL)\]** Если создание нового SL провалилось, реализована логика rollback: попытка восстановить старый SL через `executionService.createOrderWithRetry()` с сохраненными параметрами (`oldSlPriceForRollback`, `oldSlAmountForRollback`).

44. **(НОВОЕ - 7.4) \[Step 3: Cancel/Create (TP) - Before DB\]** Если `new_take_profit_price` предоставлен, логика отмены/создания TP происходит **ДО** транзакции БД. При ошибке создания TP отменяется созданный SL (если был).

45. **(НОВОЕ - 7.4) \[Step 4: DB Transaction\]** Транзакция БД обернута в `try/catch`: блокирует позицию через `SELECT ... FOR UPDATE`, удаляет старые ордера из БД (`DELETE FROM ActiveOrders`, `DELETE FROM TSL_State WHERE current_stop_order_id`), сохраняет новые ордера (`INSERT INTO ActiveOrders`), обновляет `ActivePositions.stop_loss_price`, выполняет UPSERT для `TSL_State` с `current_stop_order_id`, `rule_config_json` и `ON CONFLICT DO UPDATE`.

46. **(НОВОЕ - 7.4) \[Step 4: DB Error Handling\]** При ошибке БД транзакции (`catch (dbError)`): отменяет созданные на бирже ордера (`newSlOrder`, `newTpOrder`) через `executionService.cancelOrderWithRetry()` в `Promise.allSettled`, логирует предупреждение о несогласованном состоянии.

47. **(НОВОЕ - 7.4) \[Return Type\]** `handleModifyPosition` возвращает `Promise<void>` вместо `Promise<Order | null>`.

48. **(НОВОЕ - 7.4) \[TSL Config\]** Если `new_trailing_stop_config` не предоставлен, но старые ордера были отменены (`ordersToCancel.length > 0`), TSL состояние удаляется (`DELETE FROM TSL_State WHERE pair`).

49. **(НОВОЕ - 7.4) \[Stub 7.5\]** `handleCancelOrders` остается заглушкой (STUB).
