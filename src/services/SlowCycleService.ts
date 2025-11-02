import Decimal from 'decimal.js';
import cron from 'node-cron';
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
import type { ScheduledTask } from 'node-cron';
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

  private cronJob: ScheduledTask | null = null;

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
   * Конвертирует интервал в миллисекундах в cron выражение
   * @param intervalMs Интервал в миллисекундах
   * @returns Cron выражение (формат: минута час день месяц день_недели)
   */
  private _msToCronExpression(intervalMs: number): string {
    const minutes = Math.floor(intervalMs / 60000);

    if (minutes >= 60) {
      // Если интервал больше часа, используем часы
      const hours = Math.floor(minutes / 60);
      const remainingMinutes = minutes % 60;
      if (remainingMinutes === 0) {
        return `0 */${hours} * * *`;
      }
      // Для нецелых часов используем минуты
      return `*/${minutes} * * * *`;
    }

    if (minutes < 1) {
      // Если интервал меньше минуты, используем минимальный интервал в 1 минуту
      this.logger.warn(
        `(SlowCycle) Интервал ${intervalMs} мс меньше 1 минуты. Используется минимальный интервал 1 минута.`,
      );
      return `* * * * *`;
    }

    // Стандартный случай: каждые N минут
    return `*/${minutes} * * * *`;
  }

  /**
   * Запускает медленный цикл с заданным интервалом (использует node-cron для надежности)
   */
  public start(): void {
    const intervalMs = this.configService.getSlowCycleIntervalMs();
    const cronExpression = this._msToCronExpression(intervalMs);
    this.logger.info(`(SlowCycle) Запуск с интервалом ${intervalMs} мс (cron: ${cronExpression})...`);

    // Проверяем валидность cron выражения
    if (!cron.validate(cronExpression)) {
      this.logger.error(`(SlowCycle) Невалидное cron выражение: ${cronExpression}`);
      throw new Error(`Invalid cron expression: ${cronExpression}`);
    }

    // Создаем cron задачу
    this.cronJob = cron.schedule(
      cronExpression,
      () => {
        this.runTick().catch((error) => {
          this.logger.error('(SlowCycle) Необработанная ошибка в runTick:', error);
        });
      },
      {
        timezone: 'UTC',
      },
    );

    // Сначала проверяем просроченные триггеры немедленно при старте
    this.checkOverdueTriggersOnStartup()
      .catch((error) => {
        this.logger.error('(SlowCycle) Ошибка при проверке просроченных триггеров при старте:', error);
      })
      .finally(() => {
        // Затем запускаем обычный цикл
        this.runTick().catch((error) => {
          this.logger.error('(SlowCycle) Ошибка при первоначальном запуске runTick:', error);
        });
      });
  }

  /**
   * Останавливает медленный цикл
   */
  public stop(): void {
    this.logger.warn('(SlowCycle) Остановка...');
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
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
      try {
        this.logger.debug('(SlowCycle) Шаг 1: Обновление кэша AccountState...');
        await this.accountStateService.refreshNow();
        this.logger.debug('(SlowCycle) Шаг 1: Обновление кэша завершено.');
      } catch (error) {
        this.logger.error('(SlowCycle) Ошибка при обновлении кэша AccountState:', error);
        // Продолжаем выполнение, так как это не критично
      }

      // Шаг 2: Плановая сверка (с таймаутом, чтобы не блокировать проверку триггеров)
      try {
        this.logger.debug('(SlowCycle) Шаг 2: Плановая сверка...');
        // Таймаут 8 минут (480 секунд) - чтобы сверка не блокировала проверку триггеров
        const syncPromise = this.syncEngine.reconcileStateAll();
        const timeoutPromise = new Promise<void>((_, reject) => {
          setTimeout(() => {
            reject(new Error('Таймаут плановой сверки (8 минут)'));
          }, 480000); // 8 минут
        });

        await Promise.race([syncPromise, timeoutPromise]);
        this.logger.debug('(SlowCycle) Шаг 2: Плановая сверка завершена.');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('Таймаут')) {
          this.logger.warn('(SlowCycle) Плановая сверка превысила таймаут (8 минут). Продолжаем выполнение...');
        } else {
          this.logger.error('(SlowCycle) Ошибка при плановой сверке:', error);
        }
        // Продолжаем выполнение, так как это не критично
      }

      // Шаг 3: Проверка триггеров
      try {
        this.logger.debug('(SlowCycle) Шаг 3: Проверка триггеров...');
        await this._checkTriggers();
        this.logger.debug('(SlowCycle) Шаг 3: Проверка триггеров завершена.');
      } catch (error) {
        this.logger.error('(SlowCycle) Ошибка при проверке триггеров:', error);
        // Продолжаем выполнение, так как это не критично
      }

      // Шаг 4: Аварийный SL (Stop-Loss Janitor)
      try {
        this.logger.debug('(SlowCycle) Шаг 4: Stop-Loss Janitor...');
        await this._runStopLossJanitor();
        this.logger.debug('(SlowCycle) Шаг 4: Stop-Loss Janitor завершен.');
      } catch (error) {
        this.logger.error('(SlowCycle) Ошибка в Stop-Loss Janitor:', error);
        // Продолжаем выполнение, так как это не критично
      }

      this.logger.info('(SlowCycle) Тик ЗАВЕРШЕН.');
    } catch (error) {
      this.logger.error(`(SlowCycle) КРИТИЧЕСКИЙ СБОЙ "Медленного Цикла": ${String(error)}`, error);
      // Не бросаем ошибку, чтобы setInterval() продолжил работу
      // Но все равно логируем завершение тика для диагностики
      this.logger.info('(SlowCycle) Тик ЗАВЕРШЕН (с ошибками).');
    }
  }

  /**
   * Проверка просроченных триггеров при старте приложения
   * Обрабатывает триггеры, которые уже просрочены (например, если приложение было остановлено)
   */
  private async checkOverdueTriggersOnStartup(): Promise<void> {
    try {
      this.logger.info('(SlowCycle) Проверка просроченных триггеров при старте приложения...');
      const allTriggersResult = await this.databaseService.query('SELECT * FROM llm_triggers');
      const allTriggers = allTriggersResult.rows as unknown[] as DbTrigger[];

      this.logger.info(`(SlowCycle) Найдено ${allTriggers.length} триггеров для проверки на просроченность при старте`);

      if (allTriggers.length === 0) {
        this.logger.debug('(SlowCycle) Нет триггеров для проверки.');
        return;
      }

      let overdueCount = 0;

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
            // PostgreSQL возвращает JSONB как объект, а не строку
            if (typeof triggerConditionsJson === 'string') {
              if (triggerConditionsJson === '[object Object]') {
                continue;
              }
              conditions = JSON.parse(triggerConditionsJson) as LLMTriggerCondition[];
            } else if (Array.isArray(triggerConditionsJson)) {
              conditions = triggerConditionsJson as LLMTriggerCondition[];
            } else if (triggerConditionsJson && typeof triggerConditionsJson === 'object') {
              try {
                const jsonString = JSON.stringify(triggerConditionsJson);
                conditions = JSON.parse(jsonString) as LLMTriggerCondition[];
              } catch {
                continue;
              }
            } else {
              continue;
            }
          } catch {
            continue;
          }

          if (!Array.isArray(conditions)) {
            continue;
          }

          // Проверяем только timeout триггеры на просроченность
          for (const condition of conditions) {
            if (condition.type === 'timeout') {
              if (condition.condition === 'minutes_passed') {
                const updatedAt = new Date(row.updated_at).getTime();
                const now = Date.now();
                const minutesPassed = Math.floor((now - updatedAt) / 60000);
                const requiredMinutes = condition.value;

                if (minutesPassed >= requiredMinutes) {
                  overdueCount++;
                  this.logger.info(
                    `(SlowCycle) [${pair}] Найден просроченный timeout триггер при старте: прошло ${minutesPassed} минут, требуется ${requiredMinutes} минут. Немедленная обработка...`,
                  );
                  // Запускаем оркестрацию для просроченного триггера
                  this.orchestrator.executeOrchestration(
                    pair,
                    `Startup Overdue Trigger: timeout (просрочен на ${minutesPassed - requiredMinutes} минут)`,
                  );
                  break; // Прерываем цикл по условиям для этой пары
                }
              } else {
                // Старый формат: значение - это timestamp в миллисекундах
                const now = Date.now();
                const triggerTime = condition.value;
                if (now >= triggerTime) {
                  overdueCount++;
                  this.logger.info(
                    `(SlowCycle) [${pair}] Найден просроченный timeout триггер (legacy) при старте. Немедленная обработка...`,
                  );
                  this.orchestrator.executeOrchestration(pair, `Startup Overdue Trigger: timeout (legacy, просрочен)`);
                  break;
                }
              }
            }
          }
        } catch (error) {
          this.logger.error(`(SlowCycle) [${row.pair}] Ошибка при проверке просроченного триггера при старте:`, error);
        }
      }

      if (overdueCount > 0) {
        this.logger.info(
          `(SlowCycle) Проверка просроченных триггеров завершена. Найдено и обработано ${overdueCount} просроченных триггеров.`,
        );
      } else {
        this.logger.info('(SlowCycle) Просроченных триггеров не найдено.');
      }
    } catch (error) {
      this.logger.error('(SlowCycle) Ошибка при проверке просроченных триггеров при старте:', error);
      // Не пробрасываем ошибку, чтобы не блокировать запуск приложения
    }
  }

  /**
   * Проверка timeout и indicator триггеров
   */
  private async _checkTriggers(): Promise<void> {
    try {
      this.logger.info('(SlowCycle) Начало проверки триггеров...');
      const allTriggersResult = await this.databaseService.query('SELECT * FROM llm_triggers');
      const allTriggers = allTriggersResult.rows as unknown[] as DbTrigger[];

      this.logger.info(`(SlowCycle) Проверка триггеров: найдено ${allTriggers.length} записей в llm_triggers`);

      if (allTriggers.length === 0) {
        this.logger.warn(
          '(SlowCycle) В БД нет записей в таблице LLM_Triggers. Используйте скрипт create-triggers для создания начальных триггеров.',
        );
      }

      for (const row of allTriggers) {
        try {
          const pair = row.pair;
          if (!pair) {
            continue;
          }

          const triggerConditionsJson = row.trigger_conditions_json;
          if (!triggerConditionsJson) {
            this.logger.debug(`(SlowCycle) [${pair}] trigger_conditions_json пуст, пропускаем.`);
            continue;
          }

          let conditions: LLMTriggerCondition[];
          try {
            // PostgreSQL возвращает JSONB как объект, а не строку
            if (typeof triggerConditionsJson === 'string') {
              // Проверяем, что это не "[object Object]"
              if (triggerConditionsJson === '[object Object]') {
                this.logger.error(
                  `(SlowCycle) [${pair}] Ошибка: trigger_conditions_json преобразован в "[object Object]". Данные повреждены.`,
                );
                continue;
              }
              conditions = JSON.parse(triggerConditionsJson) as LLMTriggerCondition[];
            } else if (Array.isArray(triggerConditionsJson)) {
              conditions = triggerConditionsJson as LLMTriggerCondition[];
            } else if (triggerConditionsJson && typeof triggerConditionsJson === 'object') {
              // Если это объект (но не массив), пытаемся использовать JSON.stringify + parse
              try {
                const jsonString = JSON.stringify(triggerConditionsJson);
                conditions = JSON.parse(jsonString) as LLMTriggerCondition[];
              } catch (stringifyError) {
                this.logger.error(`(SlowCycle) [${pair}] Ошибка сериализации trigger_conditions_json:`, stringifyError);
                continue;
              }
            } else {
              this.logger.error(
                `(SlowCycle) [${pair}] Неожиданный тип trigger_conditions_json: ${typeof triggerConditionsJson}`,
              );
              continue;
            }
          } catch (parseError) {
            this.logger.error(`(SlowCycle) [${pair}] Ошибка парсинга trigger_conditions_json:`, parseError);
            continue; // Пропускаем эту пару при ошибке парсинга
          }

          if (!Array.isArray(conditions)) {
            this.logger.warn(`(SlowCycle) [${pair}] trigger_conditions_json не является массивом. Пропускаем.`);
            continue;
          }

          this.logger.debug(`(SlowCycle) [${pair}] Проверка ${conditions.length} условий триггера`);

          for (const condition of conditions) {
            let triggerHit = false;

            // Проверка timeout триггеров
            if (condition.type === 'timeout') {
              if (condition.condition === 'minutes_passed') {
                // Условие для timeout: проверяем, прошло ли указанное количество минут с момента последнего обновления триггера
                const updatedAt = new Date(row.updated_at).getTime();
                const now = Date.now();
                const minutesPassed = Math.floor((now - updatedAt) / 60000); // Разница в минутах
                const requiredMinutes = condition.value;

                this.logger.debug(
                  `(SlowCycle) [${pair}] Проверка timeout триггера (minutes_passed): прошло=${minutesPassed} мин, требуется=${requiredMinutes} мин`,
                );

                if (minutesPassed >= requiredMinutes) {
                  triggerHit = true;
                  this.logger.info(
                    `(SlowCycle) [${pair}] Сработал timeout триггер (minutes_passed): прошло ${minutesPassed} минут, требуется ${requiredMinutes} минут.`,
                  );
                }
              } else {
                // Старый формат: значение - это timestamp в миллисекундах (для обратной совместимости)
                const now = Date.now();
                const triggerTime = condition.value;
                this.logger.debug(
                  `(SlowCycle) [${pair}] Проверка timeout триггера (legacy timestamp): сейчас=${now}, триггер=${triggerTime}, разница=${triggerTime - now} мс`,
                );
                if (now >= triggerTime) {
                  triggerHit = true;
                  this.logger.info(
                    `(SlowCycle) [${pair}] Сработал timeout триггер (legacy timestamp) (value: ${triggerTime}, сейчас: ${now}).`,
                  );
                }
              }
            }

            // Проверка indicator триггеров
            if (condition.type === 'indicator' && condition.name && condition.timeframe) {
              try {
                this.logger.debug(
                  `(SlowCycle) [${pair}] Проверка индикатора ${condition.name} (timeframe: ${condition.timeframe})...`,
                );
                const ohlcv = await this.marketDataService.fetchOHLCV(pair, condition.timeframe, undefined, 50);
                if (ohlcv.length === 0) {
                  this.logger.warn(`(SlowCycle) [${pair}] Недостаточно данных OHLCV для проверки индикатора.`);
                  continue; // Пропускаем этот индикатор, но продолжаем проверку других условий
                }

                const analysis = this.taEngineService.getAnalysis(ohlcv, []);

                // Проверка индикатора по имени
                if (condition.name === 'rsi') {
                  const rsiValue = this._getAnalysisValue(analysis, condition.timeframe, 'rsi');
                  if (rsiValue !== null) {
                    this.logger.debug(
                      `(SlowCycle) [${pair}] RSI(${condition.timeframe}) = ${rsiValue}, проверка условия: ${condition.condition} ${condition.value}`,
                    );
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
                  } else {
                    this.logger.debug(`(SlowCycle) [${pair}] RSI значение не найдено в анализе.`);
                  }
                }
                // Можно добавить другие индикаторы здесь
              } catch (indicatorError) {
                this.logger.error(
                  `(SlowCycle) [${pair}] Ошибка при проверке индикатора ${condition.name} (timeframe: ${condition.timeframe}):`,
                  indicatorError,
                );
                // Продолжаем проверку других условий для этой пары, не прерываем весь цикл
                continue;
              }
            }

            // Если триггер сработал, запускаем оркестрацию и прерываем цикл для этой пары
            if (triggerHit) {
              this.logger.info(`(SlowCycle) [${pair}] Триггер сработал! Запуск оркестрации LLM запроса...`);
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
        this.logger.debug('(StopLossJanitor) Нет открытых позиций, проверка не требуется.');
        return;
      }

      this.logger.debug(`(StopLossJanitor) Проверка ${accountState.open_positions.length} открытых позиций...`);

      // Получаем тикеры для всех пар из watchlist
      // Используем Promise.allSettled вместо Promise.all, чтобы ошибки сети не блокировали проверку
      const watchlist = this.configService.getWatchlist();
      const tickerPromises = watchlist.map((pair) => this.exchangeService.fetchTicker(pair));
      const tickerResults = await Promise.allSettled(tickerPromises);

      // Создаем Map для быстрого поиска тикеров по паре
      const tickerMap = new Map<string, IDecimalTicker>();
      let successfulTickers = 0;
      for (let i = 0; i < tickerResults.length; i++) {
        const result = tickerResults[i];
        if (!result) {
          continue;
        }
        if (result.status === 'fulfilled') {
          tickerMap.set(result.value.symbol, result.value);
          successfulTickers++;
        } else if (result.status === 'rejected') {
          const pair = watchlist[i];
          this.logger.warn(`(StopLossJanitor) Не удалось получить тикер для ${pair}: ${String(result.reason)}`);
        }
      }

      this.logger.debug(`(StopLossJanitor) Получено ${successfulTickers}/${watchlist.length} тикеров успешно.`);

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
      // Не пробрасываем ошибку дальше, чтобы не блокировать завершение тика SlowCycle
      // Логируем для диагностики, но продолжаем работу
    }
  }
}
