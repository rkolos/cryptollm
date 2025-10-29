import * as ccxt from 'ccxt';
import { LoggingService } from './LoggingService.js';
import { ValidatorService } from './ValidatorService.js';
import { GuaranteedOrderExecutionService } from './GuaranteedOrderExecutionService.js';
import { DatabaseService } from './DatabaseService.js';
import { EventBusService } from './EventBusService.js';
import { NotificationService } from './NotificationService.js';
import { GlobalStateService } from './GlobalStateService.js';
import { AccountStateService } from './AccountStateService.js';
import { ExchangeRulesService } from './ExchangeRulesService.js';
import { ConfigService } from './ConfigService.js';
import type { LLMDecision } from '../interfaces/ILLMTypes.js';
import type { AccountState, MarketData, StrategyContext, CalculatedAmounts } from '../interfaces/IValidatorTypes.js';
import { InsufficientFundsError } from '../errors/ExchangeErrors.js';
import type winston from 'winston';

/**
 * WorkerService - Диспетчер "Исполнителя"
 * Полный цикл исполнения решения LLM: валидация -> исполнение -> логирование
 */
export class WorkerService {
  private static instance: WorkerService | undefined;
  private readonly logger: winston.Logger;
  private readonly validatorService: ValidatorService;
  private readonly executionService: GuaranteedOrderExecutionService;
  private readonly databaseService: DatabaseService;
  private readonly eventBus: EventBusService;
  private readonly notificationService: NotificationService;
  private readonly globalStateService: GlobalStateService;
  private readonly accountStateService: AccountStateService;
  private readonly exchangeRulesService: ExchangeRulesService;
  private readonly configService: ConfigService;

  private constructor(
    validatorService: ValidatorService,
    executionService: GuaranteedOrderExecutionService,
    databaseService: DatabaseService,
    eventBus: EventBusService,
    notificationService: NotificationService,
    globalStateService: GlobalStateService,
    accountStateService: AccountStateService,
    exchangeRulesService: ExchangeRulesService,
    configService: ConfigService,
  ) {
    this.validatorService = validatorService;
    this.executionService = executionService;
    this.databaseService = databaseService;
    this.eventBus = eventBus;
    this.notificationService = notificationService;
    this.globalStateService = globalStateService;
    this.accountStateService = accountStateService;
    this.exchangeRulesService = exchangeRulesService;
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
    configService: ConfigService,
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
        configService,
      );
    }
    return WorkerService.instance;
  }

  /**
   * Главный метод-диспетчер
   * Вызывается из WatcherOrchestrator внутри PairActorManager
   */
  public async execute(
    decision: LLMDecision,
    llm_decision_log_id: string,
    accountState: AccountState,
    strategyContext: StrategyContext,
    marketData: MarketData,
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
          exchangeRules,
        );
        this.logger.debug(
          `[${pair}] Валидация успешна. Rounded Amount: ${validationResult.roundedAmountCoin.toString()}`,
        );
      }
    } catch (validationError) {
      // Провал Валидации
      const errorMessage = validationError instanceof Error ? validationError.message : String(validationError);
      this.logger.error(`[${pair}] ПРОВАЛ ВАЛИДАЦИИ: ${errorMessage}`);

      // Обновляем лог в БД
      await this._updateDecisionLog(llm_decision_log_id, 'rejected_by_validator', errorMessage, null);

      // Отправляем уведомление
      this.notificationService.sendAlert(`[${pair}] РЕШЕНИЕ ОТКЛОНЕНО: ${errorMessage}`, false);

      return; // Остановка
    }

    // --- Шаг 2: ИСПОЛНЕНИЕ ---
    try {
      // Передаем validationResult, т.к. там уже рассчитаны все суммы
      switch (decision.action) {
        case 'OPEN_LONG':
        case 'OPEN_SHORT':
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
          // Ничего не делаем
          break;
      }

      // Успех
      this.logger.info(`[${pair}] Исполнение УСПЕШНО: ${decision.action}`);

      // Публикация События (Задача 7.1.3)
      this.eventBus.emitTradeExecuted(pair);

      // Обновляем лог в БД
      await this._updateDecisionLog(llm_decision_log_id, 'accepted', null, null);

      // Отправляем уведомление
      this.notificationService.sendAlert(
        `[${pair}] ИСПОЛНЕНО: ${decision.action} (Justification: ${decision.justification})`,
        true, // Включить AccountState
      );
    } catch (executionError) {
      // Провал Исполнения
      const errorMessage = executionError instanceof Error ? executionError.message : String(executionError);
      this.logger.error(`[${pair}] КРИТИЧЕСКАЯ ОШИБКА ИСПОЛНЕНИЯ: ${errorMessage}`);

      // Обновляем лог в БД
      await this._updateDecisionLog(llm_decision_log_id, 'failed_by_worker', null, errorMessage);

      // Отправляем уведомление
      this.notificationService.sendAlert(`[${pair}] ОШИБКА ИСПОЛНЕНИЯ: ${errorMessage}`, true);

      // Специальная обработка InsufficientFunds
      if (executionError instanceof InsufficientFundsError || executionError instanceof ccxt.InsufficientFunds) {
        this.logger.error(`[${pair}] InsufficientFundsError! Активация Глобальной Паузы.`);
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
   * Вспомогательный метод: Обновляет LLM_Decision_Log в БД
   */
  private async _updateDecisionLog(
    logId: string,
    status: 'rejected_by_validator' | 'accepted' | 'failed_by_worker',
    validatorError: string | null,
    workerError: string | null,
  ): Promise<void> {
    try {
      await this.databaseService.query(
        `UPDATE LLM_Decision_Log
         SET
            decision_result = $2,
            validator_error_message = $3,
            worker_error_message = $4
         WHERE id = $1`,
        [logId, status, validatorError, workerError],
      );
    } catch (dbError) {
      const errorMessage = dbError instanceof Error ? dbError.message : String(dbError);
      this.logger.error(`[FATAL] Не удалось обновить LLM_Decision_Log (ID: ${logId}): ${errorMessage}`);
    }
  }

  // --- ЗАГЛУШКИ: Будут реализованы в 7.2 - 7.5 ---

  private async handleOpenPosition(
    decision: LLMDecision,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _validationResult: CalculatedAmounts,
  ): Promise<void> {
    this.logger.debug(`[${decision.pair}] (STUB) Вызов handleOpenPosition...`);
    // Логика Задачи 7.2 / 7.2.1 будет здесь
    // e.g., this.databaseService.executeInTransaction(async (client) => { ... })
  }

  private async handleClosePosition(
    decision: LLMDecision,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _validationResult: CalculatedAmounts,
  ): Promise<void> {
    this.logger.debug(`[${decision.pair}] (STUB) Вызов handleClosePosition...`);
    // Логика Задачи 7.3 / 7.3.1 будет здесь
  }

  private async handleModifyPosition(
    decision: LLMDecision,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _validationResult: CalculatedAmounts,
  ): Promise<void> {
    this.logger.debug(`[${decision.pair}] (STUB) Вызов handleModifyPosition...`);
    // Логика Задачи 7.4 будет здесь
  }

  private async handleCancelOrders(
    decision: LLMDecision,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _validationResult: CalculatedAmounts,
  ): Promise<void> {
    this.logger.debug(`[${decision.pair}] (STUB) Вызов handleCancelOrders...`);
    // Логика Задачи 7.5 будет здесь
  }
}
