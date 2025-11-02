import { LoggingService } from './LoggingService.js';
import { DatabaseService } from './DatabaseService.js';
import { LLMRequestAssemblerService } from './LLMRequestAssemblerService.js';
import { SyncEngineService } from './SyncEngineService.js';
import { PairActorManagerService } from './PairActorManagerService.js';
import { AccountStateService } from './AccountStateService.js';
import { ConfigService } from './ConfigService.js';
import { MarketDataService } from './MarketDataService.js';
import Decimal from 'decimal.js';
import type { ILLMService } from '../interfaces/ILLMService.js';
import type { LLMDecision, LLMResponse } from '../interfaces/ILLMTypes.js';
import type { AccountState, StrategyContext, MarketData } from '../interfaces/IValidatorTypes.js';
import type winston from 'winston';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DecimalConstructor = Decimal as any;

/**
 * Интерфейс для WorkerService (будет реализован в задаче 7.1)
 */
export interface IWorkerService {
  execute(
    decision: LLMDecision,
    llm_decision_log_id: string,
    accountState: AccountState,
    strategyContext: StrategyContext,
    marketData: MarketData,
  ): Promise<void>;
}

/**
 * Интерфейс для NotificationService (будет реализован в задаче 1.5/3.6)
 */
export interface INotificationService {
  sendAlert(message: string, includeAccountState?: boolean): void;
  sendTriggersUpdate?(
    pair: string,
    reason: string,
    triggerConditions: Array<{
      type: string;
      condition: string;
      value: number;
      name?: string;
      timeframe?: string;
    }>,
    requestedData: string[] | null,
    updatedAt: Date,
  ): void;
}

export class WatcherOrchestratorService {
  private static instance: WatcherOrchestratorService | undefined;
  private readonly logger: winston.Logger;
  private readonly databaseService: DatabaseService;
  private readonly llmService: ILLMService;
  private readonly assemblerService: LLMRequestAssemblerService;
  private readonly syncEngine: SyncEngineService;
  private readonly workerService: IWorkerService;
  private readonly pairActorManager: PairActorManagerService;
  private readonly notificationService: INotificationService;
  private readonly accountStateService: AccountStateService;
  private readonly configService: ConfigService;
  private readonly marketDataService: MarketDataService;
  // Счетчик глубины рекурсии для повторных запросов (максимум 3 попытки на пару)
  private readonly retryDepth: Map<string, number> = new Map();

  private constructor(
    databaseService: DatabaseService,
    llmService: ILLMService,
    assemblerService: LLMRequestAssemblerService,
    syncEngine: SyncEngineService,
    workerService: IWorkerService,
    pairActorManager: PairActorManagerService,
    notificationService: INotificationService,
    accountStateService: AccountStateService,
    configService: ConfigService,
    marketDataService: MarketDataService,
  ) {
    this.databaseService = databaseService;
    this.llmService = llmService;
    this.assemblerService = assemblerService;
    this.syncEngine = syncEngine;
    this.workerService = workerService;
    this.pairActorManager = pairActorManager;
    this.notificationService = notificationService;
    this.accountStateService = accountStateService;
    this.configService = configService;
    this.marketDataService = marketDataService;
    this.logger = LoggingService.getInstance().getLogger('WatcherOrchestrator');
    this.logger.info('WatcherOrchestratorService initialized.');
  }

  public static getInstance(
    databaseService: DatabaseService,
    llmService: ILLMService,
    assemblerService: LLMRequestAssemblerService,
    syncEngine: SyncEngineService,
    workerService: IWorkerService,
    pairActorManager: PairActorManagerService,
    notificationService: INotificationService,
    accountStateService: AccountStateService,
    configService: ConfigService,
    marketDataService: MarketDataService,
  ): WatcherOrchestratorService {
    if (!WatcherOrchestratorService.instance) {
      WatcherOrchestratorService.instance = new WatcherOrchestratorService(
        databaseService,
        llmService,
        assemblerService,
        syncEngine,
        workerService,
        pairActorManager,
        notificationService,
        accountStateService,
        configService,
        marketDataService,
      );
    }
    return WatcherOrchestratorService.instance;
  }

  /**
   * Главный метод оркестрации вызова LLM и исполнения решений.
   * Вызывается из FastCycleService и SlowCycleService.
   * Не является async, так как вызывается в режиме "fire-and-forget".
   */
  public executeOrchestration(pair: string, triggerReason: string): void {
    const isRetryRequest = triggerReason.includes('ПОВТОРНЫЙ ЗАПРОС');

    // Проверка глубины рекурсии для повторных запросов
    if (isRetryRequest) {
      const currentDepth = this.retryDepth.get(pair) || 0;
      const maxRetryDepth = 3;

      if (currentDepth >= maxRetryDepth) {
        this.logger.error(
          `[${pair}] Достигнут максимальный лимит повторных запросов (${maxRetryDepth}). Прерывание цепочки повторных запросов.`,
        );
        this.notificationService.sendAlert(
          `[${pair}] КРИТИЧЕСКОЕ ПРЕДУПРЕЖДЕНИЕ: Достигнут максимальный лимит повторных запросов (${maxRetryDepth}). Дальнейшие повторные запросы для этой пары будут игнорироваться.`,
          false,
        );
        // Сбрасываем счетчик для этой пары
        this.retryDepth.delete(pair);
        return;
      }

      // Увеличиваем счетчик глубины
      this.retryDepth.set(pair, currentDepth + 1);
      this.logger.info(
        `[${pair}] 🔄 ПОВТОРНЫЙ ЗАПРОС к LLM после отклонения валидатором (глубина: ${currentDepth + 1}/${maxRetryDepth})`,
      );
    } else {
      // Для обычных запросов сбрасываем счетчик
      this.retryDepth.delete(pair);
    }

    this.logger.info(
      `[${pair}] executeOrchestration вызван. Причина: ${triggerReason.substring(0, 100)}${triggerReason.length > 100 ? '...' : ''}`,
    );

    // Уведомление о срабатывании триггера
    this.notificationService.sendAlert(`🔔 ТРИГГЕР СРАБОТАЛ: ${pair}\nПричина: ${triggerReason}`, false);

    // Враппер: Вся логика внутри PairActorManager для контроля конкурентности
    // ВАЖНО: Promise от pairActorManager.execute() должен быть обработан для логирования ошибок
    this.pairActorManager
      .execute(pair, async () => {
        try {
          // Шаг 1: Сборка запроса
          if (isRetryRequest) {
            this.logger.info(`[${pair}] 🔄 ПОВТОРНЫЙ ЗАПРОС: Начало сборки запроса к LLM...`);
          } else {
            this.logger.info(`[${pair}] Начало оркестрации. Причина: ${triggerReason}`);
          }
          let requestPayload;
          try {
            this.logger.debug(`[${pair}] Начало сборки запроса к LLM...`);
            requestPayload = await this.assemblerService.buildRequest(pair, triggerReason);
            this.logger.info(
              `[${pair}] Запрос к LLM собран успешно. Размер payload: ${JSON.stringify(requestPayload).length} символов`,
            );
          } catch (error) {
            this.logger.error(`[${pair}] Ошибка при сборке запроса:`, error);
            return; // Выход из актора при ошибке сборки
          }

          // Шаг 2: Вызов LLM
          let llmResponse: LLMResponse;
          try {
            // Преобразуем LLMRequestPayload в LLMRequest для ILLMService
            // ProductionLLMService ожидает LLMRequest, но использует только для логирования
            // MockLLMService тоже ожидает LLMRequest
            // Для совместимости создаем минимальный LLMRequest
            const llmRequest = {
              strategy_context: {
                role: '',
                style: '',
                risk_rules: {
                  default_risk_per_trade_percent: 0,
                  max_allowed_risk_per_trade_percent: 0,
                  max_total_portfolio_risk_percent: 0,
                  desired_risk_reward_ratio: 0,
                },
                watchlist: [],
              },
              triggered_pair: pair,
              market_data: {},
              technical_analysis: {},
              account_state: {},
              question: requestPayload.user_prompt,
            };

            if (isRetryRequest) {
              this.logger.info(
                `[${pair}] 🔄 ПОВТОРНЫЙ ЗАПРОС: Отправка запроса в LLM с учетом отклоненного решения...`,
              );
            } else {
              this.logger.info(`[${pair}] Отправка запроса в LLM...`);
            }
            llmResponse = await this.llmService.ask(llmRequest);
            if (isRetryRequest) {
              this.logger.info(
                `[${pair}] 🔄 ПОВТОРНЫЙ ЗАПРОС: Получен ответ от LLM. Решений: ${llmResponse.decisions.length}, обновление триггеров для: ${llmResponse.update_triggers_for_pair}`,
              );
            } else {
              this.logger.info(
                `[${pair}] Получен ответ от LLM. Решений: ${llmResponse.decisions.length}, обновление триггеров для: ${llmResponse.update_triggers_for_pair}`,
              );
            }

            // Уведомление об успешном вызове LLM
            const decisionsCount = llmResponse.decisions.length;
            const decisionsSummary = llmResponse.decisions.map((d) => `${d.action} (${d.pair})`).join(', ');
            const summaryText =
              decisionsCount > 0 ? `Решений: ${decisionsCount} (${decisionsSummary})` : 'Решений нет (HOLD)';
            this.notificationService.sendAlert(
              `✅ LLM ОТВЕТ ПОЛУЧЕН: ${pair}\n${summaryText}\nОбновление триггеров для: ${llmResponse.update_triggers_for_pair}`,
              false,
            );
          } catch (error) {
            this.logger.error(`[${pair}] Ошибка при вызове LLM:`, error);
            return; // Выход из актора при ошибке LLM
          }

          // Шаг 3: Атомарный Аудит и Триггеры (критично - одна транзакция)
          let llmLogId: string | undefined;
          try {
            await this.databaseService.executeInTransaction(async (client) => {
              // 3.1. Запись полного лога в LLM_Decision_Log со статусом 'pending'
              const logResult = await client.query(
                `INSERT INTO LLM_Decision_Log (
                timestamp, triggered_pair, trigger_reason,
                request_payload_json, response_payload_json, decision_result
              ) VALUES ($1, $2, $3, $4, $5, $6)
              RETURNING id`,
                [
                  new Date(),
                  pair,
                  triggerReason,
                  JSON.stringify(requestPayload),
                  JSON.stringify(llmResponse),
                  'pending',
                ],
              );

              if (!logResult.rows[0]) {
                throw new Error('Failed to insert LLM_Decision_Log. No ID returned.');
              }

              llmLogId = String(logResult.rows[0].id);
              this.logger.debug(`[${pair}] LLM_Decision_Log создан. ID: ${llmLogId}`);

              // 3.2. Обновление LLM_Triggers (UPSERT) с проверкой на пустой массив
              let triggerConditionsToSave = llmResponse.next_call_triggers.trigger_conditions;
              let reasonToSave = llmResponse.next_call_triggers.reason;
              let isFallbackTrigger = false;

              // Проверка: если модель не установила триггеры (пустой массив), создаем fallback
              if (!triggerConditionsToSave || triggerConditionsToSave.length === 0) {
                const defaultTimeoutMinutes = this.configService.getDefaultTriggerTimeoutMinutes();
                this.logger.warn(
                  `[${pair}] Модель не установила триггеры (пустой массив). Создаю fallback timeout триггер на ${defaultTimeoutMinutes} минут.`,
                );

                triggerConditionsToSave = [
                  {
                    type: 'timeout' as const,
                    condition: 'minutes_passed',
                    value: defaultTimeoutMinutes,
                  },
                ];
                reasonToSave = `Fallback триггер (модель не установила триггеры): проверка через ${defaultTimeoutMinutes} минут`;
                isFallbackTrigger = true;
              } else {
                // Проверка: если триггеры есть, но нет timeout триггера, добавляем его по умолчанию (60 минут)
                const hasTimeoutTrigger = triggerConditionsToSave.some((trigger) => trigger.type === 'timeout');

                if (!hasTimeoutTrigger) {
                  const defaultTimeoutMinutes = 60; // По умолчанию 60 минут
                  this.logger.info(
                    `[${pair}] Модель не установила timeout триггер. Добавляю timeout триггер по умолчанию на ${defaultTimeoutMinutes} минут.`,
                  );

                  triggerConditionsToSave = [
                    ...triggerConditionsToSave,
                    {
                      type: 'timeout' as const,
                      condition: 'minutes_passed',
                      value: defaultTimeoutMinutes,
                    },
                  ];
                }
              }

              await client.query(
                `INSERT INTO LLM_Triggers (pair, reason, trigger_conditions_json, requested_data_json, updated_at)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (pair) DO UPDATE SET
                 reason = EXCLUDED.reason,
                 trigger_conditions_json = EXCLUDED.trigger_conditions_json,
                 requested_data_json = EXCLUDED.requested_data_json,
                 updated_at = EXCLUDED.updated_at`,
                [
                  llmResponse.update_triggers_for_pair,
                  reasonToSave,
                  JSON.stringify(triggerConditionsToSave),
                  JSON.stringify(llmResponse.request_additional_data),
                  new Date(),
                ],
              );

              if (isFallbackTrigger) {
                this.logger.info(
                  `[${pair}] Установлен fallback timeout триггер на ${this.configService.getDefaultTriggerTimeoutMinutes()} минут. Пара продолжит отслеживаться.`,
                );
              }

              this.logger.debug(`[${pair}] LLM_Triggers обновлены для пары: ${llmResponse.update_triggers_for_pair}`);

              // Отправляем уведомление об обновлении триггеров (используем сохраненные значения, возможно с fallback)
              if (this.notificationService.sendTriggersUpdate) {
                this.notificationService.sendTriggersUpdate(
                  llmResponse.update_triggers_for_pair,
                  reasonToSave,
                  triggerConditionsToSave,
                  llmResponse.request_additional_data,
                  new Date(),
                );
              }
            });
          } catch (error) {
            this.logger.error(`[${pair}] КРИТИЧЕСКАЯ ОШИБКА: Не удалось записать аудит в БД:`, error);
            this.notificationService.sendAlert(
              `[${pair}] КРИТИЧЕСКАЯ ОШИБКА: Не удалось записать аудит LLM в БД. ${String(error)}`,
              false,
            );
            return; // Выход из актора при ошибке БД
          }

          if (!llmLogId) {
            this.logger.error(`[${pair}] КРИТИЧЕСКАЯ ОШИБКА: llmLogId не был установлен.`);
            return;
          }

          // Шаг 4: Подготовка данных для WorkerService (необходимы для Validator)
          // Получаем свежие данные из кэша (синхронно)
          const accountState = this.accountStateService.getAccountState();

          // Формируем StrategyContext из ConfigService
          const riskRules = this.configService.getRiskRules();
          const strategyContext: StrategyContext = {
            risk_rules: {
              default_risk_per_trade_percent: riskRules.defaultRiskPercent,
              max_allowed_risk_per_trade_percent: riskRules.maxAllowedRiskPercent,
              max_total_portfolio_risk_percent: riskRules.maxTotalPortfolioRiskPercent,
              desired_risk_reward_ratio: riskRules.desiredRiskRewardRatio,
            },
          };

          // Получаем MarketData для текущей пары
          let marketData: MarketData;
          try {
            const ticker = await this.marketDataService.fetchTicker(pair);
            marketData = {
              pair,
              current_price: ticker.last,
            };
          } catch (error) {
            this.logger.error(`[${pair}] Ошибка получения MarketData, используем fallback:`, error);
            // Fallback: используем цену из requestPayload или 0
            marketData = {
              pair,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              current_price: new DecimalConstructor(0) as any as MarketData['current_price'],
            };
          }

          // Шаг 5: Исполнение решений
          // Проверка llmLogId перед использованием
          if (!llmLogId) {
            this.logger.warn(
              `[${pair}] КРИТИЧЕСКОЕ ПРЕДУПРЕЖДЕНИЕ: llmLogId отсутствует. Исполнение будет продолжено с пустым ID лога.`,
            );
            llmLogId = '';
          }

          if (isRetryRequest && llmResponse.decisions.length > 0) {
            this.logger.info(
              `[${pair}] 🔄 ПОВТОРНЫЙ ЗАПРОС: Получено ${llmResponse.decisions.length} решений. Передача в Worker для валидации...`,
            );
          }
          for (const decision of llmResponse.decisions) {
            try {
              await this.workerService.execute(decision, llmLogId, accountState, strategyContext, marketData);
              if (isRetryRequest) {
                this.logger.info(
                  `[${pair}] 🔄 ПОВТОРНЫЙ ЗАПРОС: Решение [${decision.action}] передано в WorkerService.`,
                );
              } else {
                this.logger.debug(`[${pair}] Решение [${decision.action}] передано в WorkerService.`);
              }
            } catch (error) {
              // Worker сам обрабатывает ошибки и обновляет LLM_Decision_Log
              // Логируем здесь только для отладки
              this.logger.warn(`[${pair}] Worker вернул ошибку для решения [${decision.action}]:`, error);
            }
          }

          // Шаг 5.5: Проверка результатов валидации и удаление триггеров при отклонении решений на открытие позиции
          if (llmResponse.decisions.length > 0 && llmLogId) {
            try {
              // Проверяем, есть ли решения на открытие позиции (OPEN_LONG/OPEN_SHORT)
              const hasOpenPositionDecisions = llmResponse.decisions.some(
                (d) => d.action === 'OPEN_LONG' || d.action === 'OPEN_SHORT',
              );

              if (hasOpenPositionDecisions) {
                // Проверяем финальный статус лога после выполнения всех решений
                const logCheckResult = await this.databaseService.query(
                  'SELECT decision_result, validator_error_message FROM LLM_Decision_Log WHERE id = $1',
                  [llmLogId],
                );

                if (logCheckResult.rows.length > 0) {
                  const finalStatus = logCheckResult.rows[0].decision_result;
                  const validatorErrorMessage = logCheckResult.rows[0].validator_error_message;

                  // Проверяем, было ли автоматическое исполнение
                  const isAutoExecution =
                    validatorErrorMessage &&
                    (validatorErrorMessage.includes('АВТОМАТИЧЕСКОЕ ИСПОЛНЕНИЕ') ||
                      validatorErrorMessage.includes('✅'));

                  // Если это было автоматическое исполнение, не отправляем повторный запрос
                  if (isAutoExecution) {
                    this.logger.info(
                      `[${pair}] Решение было автоматически исполнено. Повторный запрос к LLM не требуется.`,
                    );
                    // Пропускаем всю логику переспрашивания для автоматически исполненных сделок
                  } else if (finalStatus === 'rejected_by_validator') {
                    // Если решение на открытие позиции отклонено валидатором, удаляем триггеры
                    // (WorkerService обновляет статус на 'rejected_by_validator' при отклонении)
                    // Это означает, что позиция не была открыта, и триггеры для её отслеживания не имеют смысла
                    // Находим все решения на открытие позиции для определения пар, для которых нужно удалить триггеры
                    const openPositionDecisions = llmResponse.decisions.filter(
                      (d) => d.action === 'OPEN_LONG' || d.action === 'OPEN_SHORT',
                    );

                    // Удаляем триггеры для пар с отклоненными решениями на открытие позиции
                    // Используем пары из решений, а также update_triggers_for_pair для полноты
                    const pairsToClean = new Set<string>();
                    openPositionDecisions.forEach((d) => pairsToClean.add(d.pair));
                    if (llmResponse.update_triggers_for_pair) {
                      pairsToClean.add(llmResponse.update_triggers_for_pair);
                    }

                    for (const pairToClean of pairsToClean) {
                      this.logger.warn(
                        `[${pair}] Решение на открытие позиции отклонено валидатором. Удаление триггеров для пары ${pairToClean}...`,
                      );

                      await this.databaseService.query('DELETE FROM LLM_Triggers WHERE pair = $1', [pairToClean]);

                      this.logger.info(
                        `[${pair}] Триггеры удалены для пары ${pairToClean} из-за отклонения решения на открытие позиции валидатором.`,
                      );
                    }

                    // Уведомление о удалении триггеров
                    this.notificationService.sendAlert(
                      `⚠️ [${pair}] Решение на открытие позиции отклонено валидатором. Триггеры для ${Array.from(pairsToClean).join(', ')} удалены, так как позиция не была открыта.`,
                      false,
                    );

                    // Обновляем кэш AccountStateService, чтобы удалить триггеры из памяти
                    await this.accountStateService.refreshNow();

                    // Получаем актуальное состояние счета для формирования детального описания проблемы
                    const currentAccountState = this.accountStateService.getAccountState();
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const availableBalance = currentAccountState.available_quote_balance as any;
                    const availableBalanceNumber = availableBalance?.toNumber?.() || 0;

                    // Формируем детальный retryReason для каждой пары с отклоненным решением
                    for (const rejectedDecision of openPositionDecisions) {
                      const rejectedPair = rejectedDecision.pair;

                      // ВАЖНО: Проверяем, что повторный запрос не вызывается для той же пары, которая уже обрабатывается
                      // Это может привести к проблемам с очередью PairActorManager
                      if (rejectedPair === pair) {
                        this.logger.warn(
                          `[${pair}] Повторный запрос для ${rejectedPair} пропущен, так как эта пара уже обрабатывается в текущей задаче. Запрос будет выполнен после завершения текущей задачи.`,
                        );
                      }

                      // Формируем детальное описание отклоненного решения
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      const decisionParams = rejectedDecision.parameters as any;
                      const decisionParamsText: string[] = [];
                      if (decisionParams) {
                        if (decisionParams.risk_percent !== undefined) {
                          decisionParamsText.push(`risk_percent: ${decisionParams.risk_percent}%`);
                        }
                        if (decisionParams.stop_loss_price !== undefined) {
                          decisionParamsText.push(`stop_loss_price: ${decisionParams.stop_loss_price}`);
                        }
                        if (decisionParams.take_profit_price !== undefined) {
                          decisionParamsText.push(`take_profit_price: ${decisionParams.take_profit_price}`);
                        }
                        if (decisionParams.amount_percent !== undefined) {
                          decisionParamsText.push(`amount_percent: ${decisionParams.amount_percent}%`);
                        }
                      }

                      // Формируем детальный retryReason с полной информацией о проблеме
                      let retryReason = `ПОВТОРНЫЙ ЗАПРОС: Предыдущее решение было отклонено валидатором.\n\n`;
                      retryReason += `**Отклоненное решение:**\n`;
                      retryReason += `- Действие: ${rejectedDecision.action} (${rejectedPair})\n`;
                      if (rejectedDecision.justification) {
                        retryReason += `- Обоснование: ${rejectedDecision.justification}\n`;
                      }
                      if (decisionParamsText.length > 0) {
                        retryReason += `- Параметры: ${decisionParamsText.join(', ')}\n`;
                      }
                      retryReason += `\n**Причина отклонения:** ${validatorErrorMessage || 'Не указана'}\n\n`;

                      retryReason += `**Текущее состояние счета:**\n`;
                      retryReason += `- Доступный баланс: $${availableBalanceNumber.toFixed(2)}\n`;
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      const totalPortfolio = currentAccountState.total_portfolio_value_usdt as any;
                      const totalPortfolioNumber = totalPortfolio?.toNumber?.() || 0;
                      retryReason += `- Общая стоимость портфеля: $${totalPortfolioNumber.toFixed(2)}\n`;

                      const riskRules = this.configService.getRiskRules();
                      retryReason += `- Максимальный риск на сделку: ${riskRules.maxAllowedRiskPercent}%\n`;
                      retryReason += `- Желаемое соотношение риск/прибыль: ${riskRules.desiredRiskRewardRatio}\n\n`;

                      retryReason += `**Рекомендации:**\n`;
                      if (
                        validatorErrorMessage?.includes('превышает доступный баланс') ||
                        validatorErrorMessage?.includes('превышает')
                      ) {
                        retryReason += `- Уменьши risk_percent или amount_percent, чтобы рассчитанная стоимость ордера не превышала доступный баланс $${availableBalanceNumber.toFixed(2)}\n`;
                        retryReason += `- Учитывай, что доступно только $${availableBalanceNumber.toFixed(2)}, а не весь портфель\n`;
                      } else if (
                        validatorErrorMessage?.includes('минимальная') ||
                        validatorErrorMessage?.includes('minimum')
                      ) {
                        retryReason += `- Увеличь сумму сделки до минимально допустимого значения биржи\n`;
                      } else if (
                        validatorErrorMessage?.includes('максимальная') ||
                        validatorErrorMessage?.includes('maximum')
                      ) {
                        retryReason += `- Уменьши сумму сделки до максимально допустимого значения биржи\n`;
                      } else {
                        retryReason += `- Изучи причину отклонения и скорректируй параметры решения соответственно\n`;
                      }
                      retryReason += `- Убедись, что все параметры соответствуют правилам биржи и ограничениям риска\n`;
                      retryReason += `- Учитывай текущий баланс $${availableBalanceNumber.toFixed(2)} при расчете размера позиции\n\n`;

                      retryReason += `**Требуется:** Принять новое обоснованное решение с учетом указанных ограничений и причин отклонения.`;

                      this.logger.info(
                        `[${pair}] Отправка повторного запроса к LLM после отклонения валидатором для пары ${rejectedPair}`,
                      );
                      this.logger.debug(`[${pair}] Детальная причина повторного запроса: ${retryReason}`);

                      // ВАЖНО: Повторный запрос вызывается ПОСЛЕ завершения текущей задачи
                      // PairActorManager гарантирует, что задачи для одной пары выполняются последовательно
                      // Поэтому повторный запрос будет выполнен после завершения текущей задачи
                      // Триггеры уже удалены, но это нормально - повторный запрос создаст новые триггеры при успешном ответе LLM
                      this.logger.info(
                        `[${pair}] Повторный запрос для ${rejectedPair} будет добавлен в очередь PairActorManager. Выполнение начнется после завершения текущей задачи.`,
                      );
                      try {
                        // Используем setTimeout для асинхронного вызова вместо прямой рекурсии
                        // Это предотвращает переполнение стека и дает возможность другим задачам выполниться
                        setTimeout(() => {
                          try {
                            this.executeOrchestration(rejectedPair, retryReason);
                            this.logger.debug(
                              `[${pair}] executeOrchestration вызван для повторного запроса ${rejectedPair} (асинхронно). Ожидание выполнения в очереди...`,
                            );
                          } catch (error) {
                            // Ошибка при выполнении повторного запроса
                            this.logger.error(
                              `[${pair}] КРИТИЧЕСКАЯ ОШИБКА: Ошибка при выполнении повторного запроса для ${rejectedPair}:`,
                              error,
                            );
                            // Сбрасываем счетчик глубины при ошибке
                            this.retryDepth.delete(rejectedPair);
                          }
                        }, 0);
                      } catch (error) {
                        // Ошибка при попытке запустить повторный запрос (например, ошибка при создании задачи в PairActorManager)
                        this.logger.error(
                          `[${pair}] КРИТИЧЕСКАЯ ОШИБКА: Не удалось запустить повторный запрос для ${rejectedPair}:`,
                          error,
                        );
                        this.notificationService.sendAlert(
                          `[${pair}] КРИТИЧЕСКАЯ ОШИБКА: Не удалось запустить повторный запрос для ${rejectedPair}. ${String(error)}`,
                          false,
                        );
                        // Сбрасываем счетчик глубины при ошибке
                        this.retryDepth.delete(rejectedPair);
                      }
                    }
                  }
                }
              }
            } catch (error) {
              // Не критическая ошибка - логируем, но не прерываем выполнение
              this.logger.error(`[${pair}] Ошибка при проверке результатов валидации:`, error);
            }
          }

          // Шаг 6: Пост-Сверка (критично - только если есть решения)
          if (llmResponse.decisions.length > 0) {
            this.logger.info(`[${pair}] Действия выполнены Worker. Запуск принудительной пост-синхронизации...`);
            try {
              await this.syncEngine.reconcileStateForPair(pair);
              this.logger.info(`[${pair}] Пост-синхронизация завершена успешно.`);
            } catch (error) {
              this.logger.error(`[${pair}] Ошибка при пост-синхронизации:`, error);
              // Не прерываем выполнение, так как это не критическая ошибка
            }
          } else {
            this.logger.debug(`[${pair}] Нет решений для исполнения. Пост-синхронизация не требуется.`);
          }

          if (isRetryRequest) {
            this.logger.info(`[${pair}] 🔄 ПОВТОРНЫЙ ЗАПРОС: Оркестрация завершена успешно.`);
          } else {
            this.logger.info(`[${pair}] Оркестрация завершена успешно.`);
          }
        } catch (error) {
          // Фатальный сбой в акторе
          this.logger.error(`[${pair}] ФАТАЛЬНАЯ ОШИБКА в акторе:`, error);
          this.notificationService.sendAlert(
            `[${pair}] ФАТАЛЬНАЯ ОШИБКА в WatcherOrchestrator: ${String(error)}`,
            false,
          );
          // Пробрасываем ошибку дальше для логирования PairActorManager
          throw error;
        }
      })
      .catch((error) => {
        // Внешний обработчик для критических ошибок PairActorManager
        // Обрабатываем ошибки как для обычных, так и для повторных запросов
        const isRetryError = triggerReason.includes('ПОВТОРНЫЙ ЗАПРОС');
        if (isRetryError) {
          this.logger.error(`[${pair}] 🔄 ПОВТОРНЫЙ ЗАПРОС: КРИТИЧЕСКАЯ ОШИБКА PairActorManager:`, error);
          this.notificationService.sendAlert(
            `[${pair}] 🔄 ПОВТОРНЫЙ ЗАПРОС: КРИТИЧЕСКАЯ ОШИБКА PairActorManager: ${String(error)}`,
            false,
          );
        } else {
          this.logger.error(`[${pair}] КРИТИЧЕСКАЯ ОШИБКА PairActorManager:`, error);
          this.notificationService.sendAlert(`[${pair}] КРИТИЧЕСКАЯ ОШИБКА PairActorManager: ${String(error)}`, false);
        }
      });
  }
}
