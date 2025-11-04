# Техническое Задание (ТЗ): 7.1 Диспетчер "Исполнителя" (WorkerService Dispatcher)

**Эпик:** 7. 👷 "Исполнитель" (Worker Service) **Задача:** 7.1 Диспетчер "Исполнителя" (WorkerService Dispatcher) **Включает:** 7.1.3 Публикация Событий (Event Publishing) **Архитектор:** Gemini **Дата:** 29.10.2025

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
- **`AccountStateService` (4.5):** (Зависимость) Для `refreshNow()` при `InsufficientFunds` и после каждого действия.
- **`ExchangeRulesService` (3.2):** (Зависимость) Для `getRules()`.
- **`IExchangeService` (3.1/3.5):** (Зависимость) Для получения правил биржи и округления.
- **`ConfigService` (1.3):** (Зависимость) Для `getLocalExecutionBalancePercent()` и получения конфигурации.
- **`LoggingService` (1.4):** (Зависимость) Для логирования.
- **`ExchangeErrors` (src/errors/ExchangeErrors.ts):** (Зависимость) Для импорта типов ошибок (`InsufficientFundsError`).
- **`ValidationError` (src/errors/ValidationError.ts):** (Зависимость) Для проверки типа ошибки валидации.

## 4\. Описание и Нюансы Реализации

### 4.1. Обновление Интерфейсов (`src/interfaces/IValidatorTypes.ts`)

Типы `LLMDecision`, `LLMAction`, `LLMDecisionParameters` находятся в `src/interfaces/ILLMTypes.ts`. Тип `CalculatedAmounts` находится в `src/interfaces/IValidatorTypes.ts` (вместо `ValidationResult`).

Нам нужны типы для решений LLM (из Задачи 10.5) и для результата `Validator`.

    // Типы находятся в src/interfaces/ILLMTypes.ts и src/interfaces/IValidatorTypes.ts
    // Используется CalculatedAmounts из IValidatorTypes.ts вместо ValidationResult

### 4.2. Создание `src/services/WorkerService.ts`

Этот сервис будет содержать "скелет" диспетчера и заглушки для обработчиков (7.2-7.5).

    // src/services/WorkerService.ts (Новый Файл)

    import ccxt from 'ccxt';
    import {
        LLMDecision, LLMRequestData, ValidationResult,
        AccountState, StrategyContext, MarketData
    } from '../interfaces';
    import { LoggingService } from './LoggingService';
    import { ValidatorService } from './ValidatorService';
    import { GuaranteedOrderExecutionService } from './GuaranteedOrderExecutionService';
    import { DatabaseService } from './DatabaseService';
    import { EventBusService } from './EventBusService';
    import { NotificationService } from './NotificationService';
    import { GlobalStateService } from './GlobalStateService';
    import { AccountStateService } from './AccountStateService';
    import { ExchangeRulesService } from './ExchangeRulesService';
    import { ConfigService } from './ConfigService';
    import { Decimal } from 'decimal.js';
    import { Order } from 'ccxt';

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
            validatorService: ValidatorService,
            executionService: GuaranteedOrderExecutionService,
            databaseService: DatabaseService,
            eventBus: EventBusService,
            notificationService: NotificationService,
            globalStateService: GlobalStateService,
            accountStateService: AccountStateService,
            exchangeRulesService: ExchangeRulesService,
            exchangeService: IExchangeService,
            configService: ConfigService
        ) {
            this.validatorService = validatorService;
            this.executionService = executionService;
            this.databaseService = databaseService;
            this.eventBus = eventBus;
            this.notificationService = notificationService;
            this.globalStateService = globalStateService;
            this.accountStateService = accountStateService;
            this.exchangeRulesService = exchangeRulesService;
            this.exchangeService = exchangeService;
            this.configService = configService;
            this.logger = LoggingService.getInstance().getLogger('Worker');
            this.logger.info('WorkerService initialized.');
        }

        public static getInstance(
            validatorService: ValidatorService,
            executionService: GuaranteedOrderExecutionService,
            databaseService: DatabaseService,
            eventBus: EventBusService,
            notificationService: NotificationService,
            globalStateService: GlobalStateService,
            accountStateService: AccountStateService,
            exchangeRulesService: ExchangeRulesService,
            exchangeService: IExchangeService,
            configService: ConfigService
        ): WorkerService {
            if (!WorkerService.instance) {
                WorkerService.instance = new WorkerService(
                    validatorService,
                    executionService,
                    databaseService,
                    eventBus,
                    notificationService,
                    globalStateService,
                    accountStateService,
                    exchangeRulesService,
                    exchangeService,
                    configService
                );
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
            accountState: AccountState,
            strategyContext: StrategyContext,
            marketData: MarketData
        ): Promise<void> {
            const pair = decision.pair;
            const logIdShort = llm_decision_log_id.substring(0, 8);
            this.logger.info(`[${pair}] Worker принял задачу (Log ID: ${logIdShort}). Action: ${decision.action}`);

            let validationResult: CalculatedAmounts | null = null;

            // --- Шаг 1: ВАЛИДАЦИЯ ---
            try {
                // HOLD не требует валидации
                if (decision.action === 'HOLD') {
                    this.logger.debug(`[${pair}] Action: HOLD. Валидация не требуется.`);
                } else {
                    const exchangeRules = this.exchangeRulesService.getRules(pair);

                    // Вызов Валидатора
                    validationResult = this.validatorService.validateDecision(
                        decision,
                        accountState,
                        strategyContext,
                        marketData,
                        exchangeRules
                    );
                    this.logger.debug(
                        `[${pair}] Валидация успешна. Rounded Amount: ${validationResult.roundedAmountCoin.toString()}`,
                    );
                }
            } catch (validationError) {
                // Провал Валидации
                const errorMessage = validationError instanceof Error ? validationError.message : String(validationError);
                this.logger.error(`[${pair}] ПРОВАЛ ВАЛИДАЦИИ: ${errorMessage}`);

                // Проверяем, является ли это ошибкой превышения баланса для действий OPEN_LONG/OPEN_SHORT
                const isBalanceError =
                    validationError instanceof ValidationError &&
                    (errorMessage.includes('превышает доступный баланс') || errorMessage.includes('превышает')) &&
                    (decision.action === 'OPEN_LONG' || decision.action === 'OPEN_SHORT');

                if (isBalanceError) {
                    // ЛОКАЛЬНОЕ ВЫПОЛНЕНИЕ: Пересчитываем размер позиции на основе доступного баланса
                    this.logger.info(
                        `[${pair}] Попытка локального выполнения с пересчетом размера позиции на основе доступного баланса`,
                    );

                    try {
                        // Получаем доступный баланс и процент для локального выполнения
                        const availableBalanceDecimal = accountState.available_quote_balance as any;
                        const localExecutionPercentValue = this.configService.getLocalExecutionBalancePercent();
                        const localExecutionPercent = new DecimalConstructor(localExecutionPercentValue);
                        const maxUsdForOrder = availableBalanceDecimal.mul(localExecutionPercent) as DecimalValue;

                        // Получаем цену входа
                        const entryPrice = decision.parameters.price || (marketData.current_price as DecimalValue);
                        if (!entryPrice) {
                            throw new Error(`[${pair}] Не удалось определить цену входа для локального выполнения`);
                        }

                        const entryPriceDecimal = entryPrice as any;

                        // Получаем или устанавливаем автоматически цену стоп-лосса (10% от суммы покупки)
                        let stopLossPrice = decision.parameters.stop_loss_price;
                        if (!stopLossPrice) {
                            const slPercent = new DecimalConstructor(10);
                            const hundred = new DecimalConstructor(100);
                            if (decision.action === 'OPEN_LONG') {
                                const slMultiplier = hundred.minus(slPercent).div(hundred) as any;
                                stopLossPrice = entryPriceDecimal.mul(slMultiplier).toNumber();
                            } else {
                                const slMultiplier = hundred.plus(slPercent).div(hundred) as any;
                                stopLossPrice = entryPriceDecimal.mul(slMultiplier).toNumber();
                            }
                        }

                        // Получаем или устанавливаем автоматически цену тейк-профита (10% от суммы покупки)
                        let takeProfitPrice = decision.parameters.take_profit_price;
                        if (!takeProfitPrice) {
                            const tpPercent = new DecimalConstructor(10);
                            const hundred = new DecimalConstructor(100);
                            if (decision.action === 'OPEN_LONG') {
                                const tpMultiplier = hundred.plus(tpPercent).div(hundred) as any;
                                takeProfitPrice = entryPriceDecimal.mul(tpMultiplier).toNumber();
                            } else {
                                const tpMultiplier = hundred.minus(tpPercent).div(hundred) as any;
                                takeProfitPrice = entryPriceDecimal.mul(tpMultiplier).toNumber();
                            }
                        }

                        // Рассчитываем дистанцию до стопа
                        const stopLossPriceDecimal = stopLossPrice as any;
                        const distanceToStop = entryPriceDecimal.sub(stopLossPriceDecimal).abs() as DecimalValue;
                        const zero = new DecimalConstructor(0);
                        const distanceDecimal = distanceToStop as any;
                        if (distanceDecimal.isZero() || distanceDecimal.eq(zero)) {
                            throw new Error(`[${pair}] Дистанция до стопа равна нулю, локальное выполнение невозможно`);
                        }

                        // Рассчитываем максимальное количество монет на основе доступного баланса
                        const maxAmountCoin = maxUsdForOrder.div(entryPriceDecimal) as DecimalValue;

                        // Округляем amount по правилам биржи
                        const exchangeRules = this.exchangeRulesService.getRules(pair);
                        const precision = exchangeRules.precision;
                        const maxAmountCoinDecimal = maxAmountCoin as any;
                        const amountPrecisionDecimal = precision.amount as any;
                        const amountPrecisionE = amountPrecisionDecimal.e !== undefined ? Math.abs(amountPrecisionDecimal.e) : 0;
                        const amountMultiplier = new DecimalConstructor(10).pow(amountPrecisionE);
                        const roundedAmountCoin = maxAmountCoinDecimal.mul(amountMultiplier).floor().div(amountMultiplier) as DecimalValue;

                        // Пересчитываем стоимость ордера
                        const roundedAmountCoinDecimal = roundedAmountCoin as any;
                        const roundedAmountUsd = roundedAmountCoinDecimal.mul(entryPriceDecimal) as DecimalValue;

                        // Рассчитываем реальный USD@Risk
                        const recalculatedUsdAtRisk = roundedAmountCoinDecimal.mul(distanceDecimal) as DecimalValue;

                        // Пересчитываем цены SL/TP пропорционально изменению размера позиции
                        // (Сохранение процентного расстояния до SL/TP относительно цены входа)
                        const hundred = new DecimalConstructor(100);
                        const originalStopLossPriceDecimal = stopLossPrice as any;
                        const originalTakeProfitPriceDecimal = takeProfitPrice as any;
                        const slDistancePercentDecimal = entryPriceDecimal.sub(originalStopLossPriceDecimal).abs().div(entryPriceDecimal).mul(hundred) as any;
                        const tpDistancePercentDecimal = originalTakeProfitPriceDecimal.sub(entryPriceDecimal).abs().div(entryPriceDecimal).mul(hundred) as any;

                        let recalculatedStopLossPrice: number;
                        let recalculatedTakeProfitPrice: number;
                        if (decision.action === 'OPEN_LONG') {
                            const slMultiplier = hundred.minus(slDistancePercentDecimal).div(hundred) as any;
                            const tpMultiplier = hundred.plus(tpDistancePercentDecimal).div(hundred) as any;
                            recalculatedStopLossPrice = entryPriceDecimal.mul(slMultiplier).toNumber();
                            recalculatedTakeProfitPrice = entryPriceDecimal.mul(tpMultiplier).toNumber();
                        } else {
                            const slMultiplier = hundred.plus(slDistancePercentDecimal).div(hundred) as any;
                            const tpMultiplier = hundred.minus(tpDistancePercentDecimal).div(hundred) as any;
                            recalculatedStopLossPrice = entryPriceDecimal.mul(slMultiplier).toNumber();
                            recalculatedTakeProfitPrice = entryPriceDecimal.mul(tpMultiplier).toNumber();
                        }

                        // Обновляем параметры решения с пересчитанными ценами SL/TP
                        decision.parameters.stop_loss_price = recalculatedStopLossPrice;
                        decision.parameters.take_profit_price = recalculatedTakeProfitPrice;

                        // Проверяем minNotional
                        const minNotionalDecimal = exchangeRules.minNotional as any;
                        const roundedAmountUsdDecimal = roundedAmountUsd as any;
                        if (roundedAmountUsdDecimal.lt(minNotionalDecimal)) {
                            this.logger.warn(`[${pair}] После пересчета размер позиции ниже биржевого минимума. Локальное выполнение невозможно.`);
                        } else if (roundedAmountCoinDecimal.isZero() || roundedAmountCoinDecimal.eq(zero)) {
                            this.logger.warn(`[${pair}] После пересчета размер позиции стал 0. Локальное выполнение невозможно.`);
                        } else {
                            // Создаем модифицированный validationResult для локального выполнения
                            const localValidationResult: CalculatedAmounts = {
                                rawAmountCoin: roundedAmountCoin,
                                rawAmountUsd: roundedAmountUsd,
                                roundedAmountCoin: roundedAmountCoin,
                                roundedAmountUsd: roundedAmountUsd,
                                roundedEntryPrice: entryPrice,
                                usdAtRisk: recalculatedUsdAtRisk,
                                entryPrice: entryPrice,
                            };

                            this.logger.info(
                                `[${pair}] ✅ ЛОКАЛЬНОЕ ВЫПОЛНЕНИЕ: Пересчитанный размер позиции ${roundedAmountCoinDecimal.toString()} монет ($${roundedAmountUsdDecimal.toFixed(2)}), реальный риск: $${recalculatedUsdAtRisk.toFixed(2)}`,
                            );

                            // Обновляем лог в БД с пометкой о локальном выполнении
                            await this._updateDecisionLog(
                                llm_decision_log_id,
                                'rejected_by_validator',
                                `${errorMessage} [ЛОКАЛЬНОЕ ВЫПОЛНЕНИЕ: Пересчитан размер до $${roundedAmountUsdDecimal.toFixed(2)}]`,
                                null,
                            );

                            // Отправляем уведомление о локальном выполнении
                            this.notificationService.sendAlert(
                                `[${pair}] ⚠️ ЛОКАЛЬНОЕ ВЫПОЛНЕНИЕ: Решение было отклонено валидатором из-за превышения баланса, но выполняется с пересчитанным размером $${roundedAmountUsdDecimal.toFixed(2)}`,
                                false,
                            );

                            // Переходим к выполнению с пересчитанным размером
                            validationResult = localValidationResult;
                        }
                    } catch (localExecutionError) {
                        const localErrorMessage = localExecutionError instanceof Error ? localExecutionError.message : String(localExecutionError);
                        this.logger.error(`[${pair}] ОШИБКА ЛОКАЛЬНОГО ВЫПОЛНЕНИЯ: ${localErrorMessage}`);
                    }
                }

                // Если не было локального выполнения или оно не удалось, продолжаем стандартную обработку отклонения
                if (!validationResult) {
                    // Обновляем лог в БД
                    await this._updateDecisionLog(llm_decision_log_id, 'rejected_by_validator', errorMessage, null);

                    // Отправляем уведомление
                    this.notificationService.sendAlert(`[${pair}] РЕШЕНИЕ ОТКЛОНЕНО: ${errorMessage}`, false);

                    return; // Остановка
                }
                // Если validationResult был установлен (локальное выполнение успешно), продолжаем выполнение
            }

            // --- Шаг 2: ИСПОЛНЕНИЕ ---
            try {
                // Передаем validationResult, т.к. там уже рассчитаны все суммы
                switch (decision.action) {
                    case 'OPEN_LONG':
                    case 'OPEN_SHORT':
                        await this.handleOpenPosition(decision, validationResult!);
                        // Обновляем кэш AccountStateService после открытия позиции
                        try {
                            await this.accountStateService.refreshNow();
                            this.logger.debug(`[${pair}] Кэш AccountStateService обновлен после открытия позиции`);
                        } catch (error) {
                            this.logger.error(`[${pair}] Ошибка при обновлении кэша после открытия позиции:`, error);
                        }
                        break;

                    case 'CLOSE_POSITION':
                        await this.handleClosePosition(decision, validationResult!);
                        // Обновляем кэш AccountStateService после закрытия позиции
                        try {
                            await this.accountStateService.refreshNow();
                            this.logger.debug(`[${pair}] Кэш AccountStateService обновлен после закрытия позиции`);
                        } catch (error) {
                            this.logger.error(`[${pair}] Ошибка при обновлении кэша после закрытия позиции:`, error);
                        }
                        break;

                    case 'MODIFY_POSITION':
                        await this.handleModifyPosition(decision, validationResult!);
                        // Обновляем кэш AccountStateService после модификации позиции
                        try {
                            await this.accountStateService.refreshNow();
                            this.logger.debug(`[${pair}] Кэш AccountStateService обновлен после модификации позиции`);
                        } catch (error) {
                            this.logger.error(`[${pair}] Ошибка при обновлении кэша после модификации позиции:`, error);
                        }
                        break;

                    case 'CANCEL_ORDERS':
                        await this.handleCancelOrders(decision, validationResult!);
                        break;
                }

                // Успех
                this.logger.info(`[${pair}] Исполнение УСПЕШНО: ${decision.action}`);

                // (Задача 7.1.3: Публикация События)
                this.eventBus.emit('trade_executed', pair);

                // Обновляем лог в БД
                await this._updateDecisionLog(llm_decision_log_id, 'accepted', null, null);

                // Отправляем PUSH
                this.notificationService.sendAlert(
                    `[${pair}] ИСПОЛНЕНО: ${decision.action} (Justification: ${decision.justification})`,
                    true, // Включить AccountState
                );
            } catch (executionError) {
                // Провал Исполнения
                const errorMessage = executionError instanceof Error ? executionError.message : String(executionError);
                this.logger.fatal(`[${pair}] КРИТИЧЕСКАЯ ОШИБКА ИСПОЛНЕНИЯ: ${errorMessage}`);

                // Обновляем лог в БД
                await this._updateDecisionLog(llm_decision_log_id, 'failed_by_worker', null, errorMessage);

                // Отправляем PUSH
                this.notificationService.sendAlert(`[${pair}] ОШИБКА ИСПОЛНЕНИЯ: ${errorMessage}`, true);

                // Специальная обработка InsufficientFunds
                if (executionError instanceof InsufficientFundsError) {
                    this.logger.fatal(`[${pair}] InsufficientFundsError! Активация Глобальной Паузы.`);
                    this.notificationService.sendAlert(
                        `[FATAL] НЕДОСТАТОЧНО СРЕДСТВ! Бот ПРИОСТАНОВЛЕН. Требуется ручное вмешательство.`,
                        true,
                    );
                    // Ставим на паузу
                    this.globalStateService.pause();
                    // Принудительно обновляем кэш баланса
                    await this.accountStateService.refreshNow();
                }

                // Пробрасываем ошибку выше, чтобы PairActorManager ее "увидел"
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
                await this.databaseService.query(
                    `UPDATE LLM_Decision_Log
                     SET
                        decision_result = $2,
                        validator_error_message = $3,
                        worker_error_message = $4
                     WHERE id = $1`,
                    [logId, status, validatorError, workerError]
                );
            } catch (dbError) {
                const errorMessage = dbError instanceof Error ? dbError.message : String(dbError);
                this.logger.error(`[FATAL] Не удалось обновить LLM_Decision_Log (ID: ${logId}): ${errorMessage}`);
            }
        }

        // --- (ЗАГЛУШКИ: Будут реализованы в 7.2 - 7.5) ---

        private async handleOpenPosition(decision: LLMDecision, validationResult: CalculatedAmounts): Promise<IDecimalOrder | null> {
            this.logger.debug(`[${decision.pair}] (STUB) Вызов handleOpenPosition...`);
            // (Логика Задачи 7.2 / 7.2.1 будет здесь)
            // (e.g., this.databaseService.executeInTransaction(async (client) => { ... }))
            return null;
        }

        private async handleClosePosition(decision: LLMDecision, validationResult: CalculatedAmounts): Promise<IDecimalOrder | null> {
            this.logger.debug(`[${decision.pair}] (STUB) Вызов handleClosePosition...`);
            // (Логика Задачи 7.3 / 7.3.1 будет здесь)
            return null;
        }

        private async handleModifyPosition(decision: LLMDecision, validationResult: CalculatedAmounts): Promise<IDecimalOrder | null> {
            this.logger.debug(`[${decision.pair}] (STUB) Вызов handleModifyPosition...`);
            // (Логика Задачи 7.4 будет здесь)
            return null;
        }

        private async handleCancelOrders(decision: LLMDecision, validationResult: CalculatedAmounts): Promise<void> {
            this.logger.debug(`[${decision.pair}] (STUB) Вызов handleCancelOrders...`);
            // (Логика Задачи 7.5 будет здесь)
        }
    }

## 5\. Критерии Приемки (Acceptance Criteria)

1.  **\[Interface\]** Типы `LLMDecision`, `LLMAction`, `LLMDecisionParameters` находятся в `src/interfaces/ILLMTypes.ts`. Тип `CalculatedAmounts` находится в `src/interfaces/IValidatorTypes.ts` (используется вместо `ValidationResult`).

2.  **\[Service\]** `WorkerService.ts` (Singleton) создан с методом `getInstance(validatorService, executionService, databaseService, eventBus, notificationService, globalStateService, accountStateService, exchangeRulesService, exchangeService, configService)` и корректно принимает _все 10 зависимостей_.

3.  **\[Signature (Архитектура)\]** `execute()` имеет _корректную_ сигнатуру, принимающую `(decision, llm_decision_log_id, accountState, strategyContext, marketData)`.

4.  **\[Logic (Шаг 1 - HOLD)\]** `execute()` проверяет `if (decision.action === 'HOLD')` и пропускает валидацию, логируя `debug`.

5.  **\[Logic (Шаг 1 - Успех)\]** `execute()` _сначала_ вызывает `validatorService.validateDecision(decision, accountState, strategyContext, marketData, exchangeRules)` и сохраняет результат в `validationResult: CalculatedAmounts | null`.

6.  **\[Logic (Шаг 1 - Локальное Выполнение)\]** Если `Validator` бросает `ValidationError` с сообщением о превышении баланса для `OPEN_LONG`/`OPEN_SHORT`, `execute()` пытается выполнить локальное выполнение с пересчетом размера позиции, автоматической установкой SL/TP и проверкой minNotional.

7.  **\[Logic (Шаг 1 - Провал)\]** Если локальное выполнение не удалось или не применимо, `execute()` вызывает `_updateDecisionLog` (с `rejected_by_validator`), `notificationService.sendAlert` и **завершается** (`return`).

8.  **\[Logic (Шаг 2 - Успех)\]** Если `Validator` успешен (или локальное выполнение успешно), `execute()` вызывает `switch (decision.action)` и (STUB) `handle...` методы.

9.  **\[Logic (Шаг 2 - Cache Update)\]** После каждого `handle...` (для `OPEN_LONG`, `OPEN_SHORT`, `CLOSE_POSITION`, `MODIFY_POSITION`) `execute()` вызывает `accountStateService.refreshNow()` в `try/catch` для обновления кэша.

10. **\[Logic (Шаг 2 - Успех)\]** После `handle...` (в `try`), `execute()` вызывает `_updateDecisionLog` (с `accepted`), `eventBus.emit('trade_executed', pair)` и `notificationService.sendAlert` (с `includeAccountState: true`).

11. **\[Logic (Шаг 2 - Провал)\]** Если `handle...` (в `try`) бросает `Error`, `execute()` **немедленно** входит в `catch (executionError)`.

12. **\[Logic (Шаг 2 - Провал)\]** В `catch (executionError)`, `execute()` извлекает `errorMessage` и вызывает `_updateDecisionLog` (с `failed_by_worker`) и `notificationService.sendAlert` (с `includeAccountState: true`).

13. **\[Robustness (План 7.1)\]** В `catch (executionError)` есть `if (executionError instanceof InsufficientFundsError)` (кастомный класс из `ExchangeErrors`).

14. **\[Robustness (План 7.1)\]** Этот `if` _корректно_ вызывает `globalStateService.pause()`, `notificationService.sendAlert` с FATAL сообщением и `accountStateService.refreshNow()`.

15. **\[Robustness\]** `catch (executionError)` _повторно_ бросает (`throw`) ошибку, чтобы `PairActorManager` (Эпик 9) мог ее обработать.

16. **\[EventBus (Задача 7.1.3)\]** При _успешном_ исполнении (в `try`), `execute()` вызывает `eventBus.emit('trade_executed', pair)`.

17. **\[DB Logic\]** `_updateDecisionLog` корректно формирует `UPDATE` SQL-запрос с использованием `databaseService.query()` и обрабатывает ошибки через `try/catch`.

18. **\[Stubs\]** Приватные "заглушки" (`handleOpenPosition`, `handleClosePosition`, `handleModifyPosition`, `handleCancelOrders`) принимают `CalculatedAmounts` вместо `ValidationResult` и возвращают `IDecimalOrder | null` или `Promise<void>`.

19. **\[LogIdShort\]** Для логирования используется короткая версия `llm_decision_log_id.substring(0, 8)`.
