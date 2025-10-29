import Decimal from 'decimal.js';
import { LoggingService } from './LoggingService.js';
import { ConfigService } from './ConfigService.js';
import { GlobalStateService } from './GlobalStateService.js';
import { AccountStateService } from './AccountStateService.js';
import { SyncEngineService } from './SyncEngineService.js';
import { DatabaseService } from './DatabaseService.js';
import { MarketDataService } from './MarketDataService.js';
import { TAEngineService } from './TAEngineService.js';
import {
  WatcherOrchestratorService,
  type IWorkerService,
  type INotificationService,
} from './WatcherOrchestratorService.js';
import { PairActorManagerService } from './PairActorManagerService.js';
import type { IExchangeService, IDecimalTicker } from '../interfaces/IExchangeService.js';
import type { LLMTriggerCondition } from '../interfaces/ILLMTypes.js';
import type { AnalysisResult, DecimalValue } from '../interfaces/ITATypes.js';
import type winston from 'winston';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DecimalConstructor = Decimal as any;

interface DbTrigger {
  pair: string;
  reason: string | null;
  trigger_conditions_json: string | null;
  requested_data_json: string | null;
  updated_at: Date;
}

export class SlowCycleService {
  private static instance: SlowCycleService | undefined;
  private readonly logger: winston.Logger;
  private readonly configService: ConfigService;
  private readonly globalState: GlobalStateService;
  private readonly accountStateService: AccountStateService;
  private readonly syncEngine: SyncEngineService;
  private readonly databaseService: DatabaseService;
  private readonly marketDataService: MarketDataService;
  private readonly taEngineService: TAEngineService;
  private readonly orchestrator: WatcherOrchestratorService;
  private readonly exchangeService: IExchangeService;
  private readonly pairActorManager: PairActorManagerService;
  private readonly workerService: IWorkerService;
  private readonly notificationService: INotificationService;

  private intervalId: NodeJS.Timeout | null = null;

  private constructor(
    configService: ConfigService,
    globalState: GlobalStateService,
    accountStateService: AccountStateService,
    syncEngine: SyncEngineService,
    databaseService: DatabaseService,
    marketDataService: MarketDataService,
    taEngineService: TAEngineService,
    orchestrator: WatcherOrchestratorService,
    exchangeService: IExchangeService,
    pairActorManager: PairActorManagerService,
    workerService: IWorkerService,
    notificationService: INotificationService,
  ) {
    this.configService = configService;
    this.globalState = globalState;
    this.accountStateService = accountStateService;
    this.syncEngine = syncEngine;
    this.databaseService = databaseService;
    this.marketDataService = marketDataService;
    this.taEngineService = taEngineService;
    this.orchestrator = orchestrator;
    this.exchangeService = exchangeService;
    this.pairActorManager = pairActorManager;
    this.workerService = workerService;
    this.notificationService = notificationService;
    this.logger = LoggingService.getInstance().getLogger('SlowCycle');
    this.logger.info('SlowCycleService initialized.');
  }

  public static getInstance(
    configService: ConfigService,
    globalState: GlobalStateService,
    accountStateService: AccountStateService,
    syncEngine: SyncEngineService,
    databaseService: DatabaseService,
    marketDataService: MarketDataService,
    taEngineService: TAEngineService,
    orchestrator: WatcherOrchestratorService,
    exchangeService: IExchangeService,
    pairActorManager: PairActorManagerService,
    workerService: IWorkerService,
    notificationService: INotificationService,
  ): SlowCycleService {
    if (!SlowCycleService.instance) {
      SlowCycleService.instance = new SlowCycleService(
        configService,
        globalState,
        accountStateService,
        syncEngine,
        databaseService,
        marketDataService,
        taEngineService,
        orchestrator,
        exchangeService,
        pairActorManager,
        workerService,
        notificationService,
      );
    }
    return SlowCycleService.instance;
  }

  /**
   * Запускает медленный цикл с заданным интервалом
   */
  public start(): void {
    const intervalMs = this.configService.getSlowCycleIntervalMs();
    this.logger.info(`(SlowCycle) Запуск с интервалом ${intervalMs} мс...`);

    this.intervalId = setInterval(() => {
      this.runTick().catch((error) => {
        this.logger.error('(SlowCycle) Необработанная ошибка в runTick:', error);
      });
    }, intervalMs);

    // Немедленно вызываем runTick один раз при старте
    this.runTick().catch((error) => {
      this.logger.error('(SlowCycle) Ошибка при первоначальном запуске runTick:', error);
    });
  }

  /**
   * Останавливает медленный цикл
   */
  public stop(): void {
    this.logger.warn('(SlowCycle) Остановка...');
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Основной метод тика медленного цикла
   */
  private async runTick(): Promise<void> {
    // Проверка состояния
    if (this.globalState.getIsPaused() || this.globalState.getIsShuttingDown()) {
      this.logger.debug('(SlowCycle) Тик пропущен (пауза или завершение работы).');
      return;
    }

    try {
      this.logger.info('(SlowCycle) Тик ЗАПУЩЕН.');

      // Шаг 1: Обновление кэша
      await this.accountStateService.refreshNow();

      // Шаг 2: Плановая сверка
      await this.syncEngine.reconcileStateAll();

      // Шаг 3: Проверка триггеров
      await this._checkTriggers();

      // Шаг 4: Аварийный SL (Stop-Loss Janitor)
      await this._runStopLossJanitor();

      this.logger.info('(SlowCycle) Тик ЗАВЕРШЕН.');
    } catch (error) {
      this.logger.error(`(SlowCycle) КРИТИЧЕСКИЙ СБОЙ "Медленного Цикла": ${String(error)}`, error);
      // Не бросаем ошибку, чтобы setInterval() продолжил работу
    }
  }

  /**
   * Проверка timeout и indicator триггеров
   */
  private async _checkTriggers(): Promise<void> {
    try {
      const allTriggersResult = await this.databaseService.query('SELECT * FROM LLM_Triggers');
      const allTriggers = allTriggersResult.rows as unknown[] as DbTrigger[];

      for (const row of allTriggers) {
        try {
          const pair = row.pair;
          if (!pair) {
            continue;
          }

          const triggerConditionsJson = row.trigger_conditions_json;
          if (!triggerConditionsJson) {
            continue;
          }

          let conditions: LLMTriggerCondition[];
          try {
            conditions = JSON.parse(triggerConditionsJson) as LLMTriggerCondition[];
          } catch (parseError) {
            this.logger.error(`(SlowCycle) [${pair}] Ошибка парсинга trigger_conditions_json:`, parseError);
            continue; // Пропускаем эту пару при ошибке парсинга
          }

          if (!Array.isArray(conditions)) {
            this.logger.warn(`(SlowCycle) [${pair}] trigger_conditions_json не является массивом. Пропускаем.`);
            continue;
          }

          for (const condition of conditions) {
            let triggerHit = false;

            // Проверка timeout триггеров
            if (condition.type === 'timeout') {
              // Условие для timeout: значение - это timestamp в миллисекундах
              if (Date.now() >= condition.value) {
                triggerHit = true;
                this.logger.info(`(SlowCycle) [${pair}] Сработал timeout триггер (value: ${condition.value}).`);
              }
            }

            // Проверка indicator триггеров
            if (condition.type === 'indicator' && condition.name && condition.timeframe) {
              try {
                const ohlcv = await this.marketDataService.fetchOHLCV(pair, condition.timeframe, undefined, 50);
                if (ohlcv.length === 0) {
                  this.logger.warn(`(SlowCycle) [${pair}] Недостаточно данных OHLCV для проверки индикатора.`);
                  continue;
                }

                const analysis = this.taEngineService.getAnalysis(ohlcv, []);

                // Проверка индикатора по имени
                if (condition.name === 'rsi') {
                  const rsiValue = this._getAnalysisValue(analysis, condition.timeframe, 'rsi');
                  if (rsiValue !== null) {
                    // condition.condition может быть 'below' или 'above'
                    if (condition.condition === 'below' && rsiValue < condition.value) {
                      triggerHit = true;
                      this.logger.info(
                        `(SlowCycle) [${pair}] Сработал indicator триггер: RSI(${condition.timeframe}) = ${rsiValue} < ${condition.value}`,
                      );
                    } else if (condition.condition === 'above' && rsiValue > condition.value) {
                      triggerHit = true;
                      this.logger.info(
                        `(SlowCycle) [${pair}] Сработал indicator триггер: RSI(${condition.timeframe}) = ${rsiValue} > ${condition.value}`,
                      );
                    }
                  }
                }
                // Можно добавить другие индикаторы здесь
              } catch (indicatorError) {
                this.logger.error(
                  `(SlowCycle) [${pair}] Ошибка при проверке индикатора ${condition.name}:`,
                  indicatorError,
                );
                continue;
              }
            }

            // Если триггер сработал, запускаем оркестрацию и прерываем цикл для этой пары
            if (triggerHit) {
              this.orchestrator.executeOrchestration(
                pair,
                `SlowCycle Trigger: ${condition.type} (${condition.name || 'timeout'})`,
              );
              break; // Прерываем внутренний цикл по условиям для этой пары
            }
          }
        } catch (error) {
          this.logger.error(`(SlowCycle) [${row.pair}] Ошибка проверки триггера:`, error);
        }
      }
    } catch (error) {
      this.logger.error('(SlowCycle) Ошибка при чтении триггеров из БД:', error);
    }
  }

  /**
   * Вспомогательный метод для получения значения индикатора из анализа
   */
  private _getAnalysisValue(analysis: AnalysisResult, timeframe: string, indicatorName: string): number | null {
    // Анализ возвращается для конкретного таймфрейма, но нужно извлечь значение
    // Структура: analysis содержит поля напрямую (rsi, ema_50, etc.)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const analysisAny = analysis as any;

    if (indicatorName === 'rsi' && analysisAny.rsi) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rsiDecimal = analysisAny.rsi as any;
      if (rsiDecimal && typeof rsiDecimal.toNumber === 'function') {
        return rsiDecimal.toNumber();
      }
      return typeof rsiDecimal === 'number' ? rsiDecimal : null;
    }

    return null;
  }

  /**
   * Аварийная проверка "Зависшего Стопа" (Stop-Loss Janitor)
   */
  private async _runStopLossJanitor(): Promise<void> {
    if (this.globalState.getIsPaused()) {
      return;
    }

    try {
      const accountState = this.accountStateService.getAccountState();
      if (!accountState.open_positions || accountState.open_positions.length === 0) {
        return;
      }

      // Получаем тикеры для всех пар из watchlist
      const watchlist = this.configService.getWatchlist();
      const tickerPromises = watchlist.map((pair) => this.exchangeService.fetchTicker(pair));
      const tickers = await Promise.all(tickerPromises);

      // Создаем Map для быстрого поиска тикеров по паре
      const tickerMap = new Map<string, IDecimalTicker>();
      for (const ticker of tickers) {
        tickerMap.set(ticker.symbol, ticker);
      }

      // Проверяем каждую позицию
      for (const position of accountState.open_positions) {
        try {
          const ticker = tickerMap.get(position.pair);
          if (!ticker) {
            this.logger.warn(`(StopLossJanitor) [${position.pair}] Тикер не найден. Пропускаем проверку.`);
            continue;
          }

          if (!position.stop_loss_price) {
            continue; // Нет SL - не проверяем
          }

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const currentPriceDecimal = ticker.last as any as DecimalValue;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const slPriceDecimal = position.stop_loss_price as any as DecimalValue;

          const currentPrice = new DecimalConstructor(currentPriceDecimal.toString());
          const slPrice = new DecimalConstructor(slPriceDecimal.toString());

          // Определяем, пробит ли SL
          let isBreached = false;
          if (position.side === 'long' && currentPrice.lessThan(slPrice)) {
            isBreached = true;
          } else if (position.side === 'short' && currentPrice.greaterThan(slPrice)) {
            isBreached = true;
          }

          if (isBreached) {
            // Проверяем, есть ли открытый SL ордер
            const hasOpenSlOrder = accountState.open_orders.some((order: unknown) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const orderTyped = order as any;
              return (
                orderTyped.pair === position.pair &&
                orderTyped.type === 'stop_loss_limit' &&
                orderTyped.status === 'open'
              );
            });

            if (hasOpenSlOrder) {
              this.logger.error(
                `(StopLossJanitor) [${position.pair}] ФАТАЛЬНАЯ ОШИБКА: Цена ${currentPrice.toString()} ПРОБИЛА SL ${slPrice.toString()}, но позиция НЕ ЗАКРЫТА! Запуск принудительного закрытия.`,
              );

              // Вызываем pairActorManager.execute БЕЗ await (fire-and-forget)
              this.pairActorManager
                .execute(position.pair, async () => {
                  await this.notificationService.sendAlert(
                    `[${position.pair}] ФАТАЛЬНАЯ ОШИБКА Stop-Loss Janitor: Цена ${currentPrice.toString()} пробила SL ${slPrice.toString()}, но позиция не закрыта! Принудительное закрытие.`,
                    true,
                  );

                  // Создаем решение для принудительного закрытия
                  const closeDecision = {
                    action: 'CLOSE_POSITION' as const,
                    pair: position.pair,
                    parameters: {
                      type: 'market' as const,
                      amount_percent: 100,
                    },
                    justification: 'Принудительное закрытие из-за пробития Stop-Loss (Stop-Loss Janitor)',
                  };

                  // Подготовка данных для WorkerService
                  const accountState = this.accountStateService.getAccountState();
                  const riskRules = this.configService.getRiskRules();
                  const strategyContext = {
                    risk_rules: {
                      default_risk_per_trade_percent: riskRules.defaultRiskPercent,
                      max_allowed_risk_per_trade_percent: riskRules.maxAllowedRiskPercent,
                      max_total_portfolio_risk_percent: riskRules.maxTotalPortfolioRiskPercent,
                      desired_risk_reward_ratio: riskRules.desiredRiskRewardRatio,
                    },
                  };
                  const ticker = await this.exchangeService.fetchTicker(position.pair);
                  const marketData = {
                    pair: position.pair,
                    current_price: ticker.last,
                  };

                  // Вызываем workerService.execute (llmLogId пустой для Stop-Loss Janitor)
                  await this.workerService.execute(closeDecision, '', accountState, strategyContext, marketData);
                })
                .catch((actorError) => {
                  this.logger.error(
                    `(StopLossJanitor) [${position.pair}] Ошибка в акторе при принудительном закрытии:`,
                    actorError,
                  );
                });
            }
          }
        } catch (error) {
          this.logger.error(`(StopLossJanitor) [${position.pair}] Ошибка проверки SL:`, error);
        }
      }
    } catch (error) {
      this.logger.error('(StopLossJanitor) Критическая ошибка:', error);
    }
  }
}
