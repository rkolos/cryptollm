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
    // Враппер: Вся логика внутри PairActorManager для контроля конкурентности
    this.pairActorManager
      .execute(pair, async () => {
        try {
          // Шаг 1: Сборка запроса
          this.logger.info(`[${pair}] Начало оркестрации. Причина: ${triggerReason}`);
          let requestPayload;
          try {
            requestPayload = await this.assemblerService.buildRequest(pair, triggerReason);
            this.logger.debug(`[${pair}] Запрос к LLM собран успешно.`);
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

            llmResponse = await this.llmService.ask(llmRequest);
            this.logger.info(`[${pair}] Получен ответ от LLM. Решений: ${llmResponse.decisions.length}`);
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

              // 3.2. Обновление LLM_Triggers (UPSERT)
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
                  llmResponse.next_call_triggers.reason,
                  JSON.stringify(llmResponse.next_call_triggers.trigger_conditions),
                  JSON.stringify(llmResponse.request_additional_data),
                  new Date(),
                ],
              );

              this.logger.debug(`[${pair}] LLM_Triggers обновлены для пары: ${llmResponse.update_triggers_for_pair}`);
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
          for (const decision of llmResponse.decisions) {
            try {
              await this.workerService.execute(decision, llmLogId, accountState, strategyContext, marketData);
              this.logger.debug(`[${pair}] Решение [${decision.action}] передано в WorkerService.`);
            } catch (error) {
              // Worker сам обрабатывает ошибки и обновляет LLM_Decision_Log
              // Логируем здесь только для отладки
              this.logger.warn(`[${pair}] Worker вернул ошибку для решения [${decision.action}]:`, error);
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

          this.logger.info(`[${pair}] Оркестрация завершена успешно.`);
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
        this.logger.error(`[${pair}] КРИТИЧЕСКАЯ ОШИБКА PairActorManager:`, error);
        this.notificationService.sendAlert(`[${pair}] КРИТИЧЕСКАЯ ОШИБКА PairActorManager: ${String(error)}`, false);
      });
  }
}
