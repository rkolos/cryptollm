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
- **`AccountStateService` (4.5):** (Зависимость) Для `refreshNow()` при `InsufficientFunds`.
- **`ExchangeRulesService` (3.2):** (Зависимость) Для `getRules()`.
- **`ConfigService` (1.3):** (Зависимость) Для `getStrategyContext()`.
- **`LoggingService` (1.4):** (Зависимость) Для логирования.
- **`ccxt` (1.2):** (Зависимость) Для импорта типов ошибок (`InsufficientFundsError`).

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
                        await this.handleOpenPosition(decision, validationResult);
                        break;

                    case 'CLOSE_POSITION':
                        await this.handleClosePosition(decision, validationResult);
                        break;

                    case 'MODIFY_POSITION':
                        await this.handleModifyPosition(decision, validationResult);
                        break;

                    case 'CANCEL_ORDERS':
                        await this.handleCancelOrders(decision, validationResult);
                        break;
                }

                // (Успех)
                this.logger.info(`[${pair}] Исполнение УСПЕШНО: ${decision.action}`);

                // (Задача 7.1.3: Публикация События)
                this.eventBus.emit('trade_executed', pair);

                // (Обновляем лог в БД)
                await this._updateDecisionLog(llm_decision_log_id, 'accepted', null, null);

                // (Отправляем PUSH)
                this.notificationService.sendAlert(
                    `[${pair}] ИСПОЛНЕНО: ${decision.action} (Justification: ${decision.justification})`,
                    true // (Включить AccountState)
                );

            } catch (executionError: any) {
                // (Провал Исполнения)
                this.logger.fatal(`[${pair}] КРИТИЧЕСКАЯ ОШИБКА ИСПОЛНЕНИЯ: ${executionError.message}`);

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

        private async handleOpenPosition(decision: LLMDecision, validationResult: ValidationResult): Promise<Order | null> {
            this.logger.debug(`[${decision.pair}] (STUB) Вызов handleOpenPosition...`);
            // (Логика Задачи 7.2 / 7.2.1 будет здесь)
            // (e.g., this.dbService.executeInTransaction(async (client) => { ... }))
            return null;
        }

        private async handleClosePosition(decision: LLMDecision, validationResult: ValidationResult): Promise<Order | null> {
            this.logger.debug(`[${decision.pair}] (STUB) Вызов handleClosePosition...`);
            // (Логика Задачи 7.3 / 7.3.1 будет здесь)
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

15. **\[Stubs\]** Приватные "заглушки" (`handleOpenPosition`, `handleClosePosition` и т.д.) созданы и готовы к реализации в 7.2-7.5.
