import { LoggingService } from './LoggingService.js';
import { ConfigService } from './ConfigService.js';
import { GlobalStateService } from './GlobalStateService.js';
import { AccountStateService } from './AccountStateService.js';
import { NotificationService } from './NotificationService.js';
import type { IExchangeService, IDecimalTicker } from '../interfaces/IExchangeService.js';
import type { DecimalValue } from '../interfaces/IValidatorTypes.js';
import type winston from 'winston';
import Decimal from 'decimal.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DecimalConstructor = Decimal as any;

/**
 * Интерфейс для TSLHandlerService (реализован в задаче 5.4)
 */
interface ITSLHandlerService {
  handleTicker(ticker: IDecimalTicker): void;
}

/**
 * Интерфейс для PriceTriggerHandler (будет реализован в задаче 5.5)
 */
interface IPriceTriggerHandler {
  handleTicker(ticker: IDecimalTicker): void;
}

export class FastCycleService {
  private static instance: FastCycleService | undefined;
  private readonly logger: winston.Logger;
  private readonly configService: ConfigService;
  private readonly globalState: GlobalStateService;
  private readonly accountState: AccountStateService;
  private readonly notificationService: NotificationService;
  private readonly exchangeService: IExchangeService;
  private readonly tslHandler: ITSLHandlerService;
  private readonly priceTriggerHandler: IPriceTriggerHandler;

  private isStopping: boolean = false;
  private isClosingAllPositions: boolean = false; // Защита от множественных одновременных закрытий
  private lastProfitCheck: number = 0; // Timestamp последней проверки прибыли
  private isCheckingProfit: boolean = false; // Защита от множественных одновременных проверок прибыли
  private lastTickerTime: number = 0; // Timestamp последнего полученного тикера
  private tickerCount: number = 0; // Счетчик тикеров для логирования
  private isMonitoringStarted: boolean = false; // Флаг запуска мониторинга
  private profitCheckStartTime: number = 0; // Timestamp начала проверки прибыли
  private profitCheckTimer: NodeJS.Timeout | null = null; // Таймер для независимой проверки прибыли
  private lastPositionCheckTime: number = 0; // Timestamp последней проверки наличия позиций
  private hasOpenPositionsCache: boolean = false; // Кэш результата проверки позиций

  private constructor(
    configService: ConfigService,
    globalState: GlobalStateService,
    accountState: AccountStateService,
    exchangeService: IExchangeService,
    tslHandler: ITSLHandlerService,
    priceTriggerHandler: IPriceTriggerHandler,
  ) {
    this.configService = configService;
    this.globalState = globalState;
    this.accountState = accountState;
    this.exchangeService = exchangeService;
    this.tslHandler = tslHandler;
    this.priceTriggerHandler = priceTriggerHandler;
    this.notificationService = NotificationService.getInstance(configService);
    this.logger = LoggingService.getInstance().getLogger('FastCycle');
    this.logger.info('FastCycleService initialized.');
  }

  public static getInstance(
    configService: ConfigService,
    globalState: GlobalStateService,
    accountState: AccountStateService,
    exchangeService: IExchangeService,
    tslHandler: ITSLHandlerService,
    priceTriggerHandler: IPriceTriggerHandler,
  ): FastCycleService {
    if (!FastCycleService.instance) {
      FastCycleService.instance = new FastCycleService(
        configService,
        globalState,
        accountState,
        exchangeService,
        tslHandler,
        priceTriggerHandler,
      );
    }
    return FastCycleService.instance;
  }

  /**
   * Запускает быстрый цикл (WebSocket)
   */
  public start(): void {
    this.isStopping = false;
    this.logger.info('(FastCycle) Запуск...');
    this.logger.info('(FastCycle) Начинаем инициализацию WebSocket...');

    // Запускаем вечный цикл в фоновом режиме (без await)
    this._runWebSocketLoop().catch((error) => {
      this.logger.error('(FastCycle) Фатальная ошибка в _runWebSocketLoop:', error);
      // Очищаем таймер при ошибке, чтобы избежать утечки
      if (this.profitCheckTimer) {
        clearInterval(this.profitCheckTimer);
        this.profitCheckTimer = null;
        this.logger.warn('(FastCycle) Таймер проверки прибыли очищен из-за ошибки WebSocket цикла');
      }
    });

    // Запускаем независимый таймер для проверки прибыли (на случай если тикеры перестанут приходить)
    this._startProfitCheckTimer();

    this.logger.info('(FastCycle) WebSocket цикл запущен');
  }

  /**
   * Останавливает быстрый цикл
   */
  public async stop(): Promise<void> {
    this.logger.warn('(FastCycle) Остановка...');
    this.isStopping = true;

    // Останавливаем таймер проверки прибыли
    if (this.profitCheckTimer) {
      clearInterval(this.profitCheckTimer);
      this.profitCheckTimer = null;
    }

    await this.exchangeService.close();
    this.logger.info('(FastCycle) Остановлен.');
  }

  /**
   * Вечный цикл WebSocket с автоматическим переподключением
   */
  private async _runWebSocketLoop(): Promise<void> {
    const watchlist = this.configService.getWatchlist();
    const reconnectDelayMs = 5000; // 5 секунд
    let loopIteration = 0;

    while (!this.isStopping) {
      loopIteration++;
      try {
        this.logger.info(
          `(FastCycle) Подключение к watchTickers для ${watchlist.length} пар... (итерация цикла: ${loopIteration})`,
        );

        // Запускаем мониторинг тикеров в фоне только один раз
        if (!this.isMonitoringStarted) {
          this.isMonitoringStarted = true;
          this._startTickerMonitoring().catch((error) => {
            this.logger.error('(FastCycle) Ошибка в мониторинге тикеров:', error);
          });
        }

        // watchTickers возвращает Promise<void>, который завершается при закрытии соединения
        // Оборачиваем синхронный _handleTickerData в async функцию для соответствия интерфейсу
        const watchStartTime = Date.now();
        this.logger.info(`(FastCycle) Вызов watchTickers... (итерация: ${loopIteration})`);

        await this.exchangeService.watchTickers(watchlist, async (ticker) => {
          this._handleTickerData(ticker);
        });

        // Если мы здесь, значит watchTickers завершился (штатно или с ошибкой)
        const watchDuration = Date.now() - watchStartTime;
        this.logger.warn(
          `(FastCycle) watchTickers завершился после ${Math.round(watchDuration / 1000)} сек. Переподключение... (итерация: ${loopIteration})`,
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Проверяем, достигнут ли лимит переподключений
        if (errorMessage.includes('Max reconnection attempts')) {
          this.logger.error(
            `(FastCycle) КРИТИЧНО: Достигнут лимит переподключений WebSocket. Соединение не может быть восстановлено.`,
            error,
          );
          // Отправляем критическое уведомление
          try {
            this.notificationService.sendAlert(
              `🚨 **КРИТИЧЕСКАЯ ОШИБКА**\n\nWebSocket соединение не может быть восстановлено после ${loopIteration} попыток переподключения.\n\nБот продолжит работать, но тикеры не будут поступать до перезапуска.`,
              false,
            );
          } catch (notifyError) {
            this.logger.error('Ошибка при отправке уведомления о критической ошибке WebSocket:', notifyError);
          }
          // Прекращаем попытки переподключения
          break;
        }

        this.logger.error(
          `(FastCycle) Ошибка watchTickers: ${errorMessage}. Переподключение через ${reconnectDelayMs} мс... (итерация: ${loopIteration})`,
          error,
        );

        // Если это не остановка, ждем перед переподключением
        if (!this.isStopping) {
          await this._sleep(reconnectDelayMs);
        }
      }
    }

    this.logger.info('(FastCycle) Вечный цикл завершен (isStopping = true).');
  }

  /**
   * Рассчитывает общую прибыльность всех открытых позиций с учетом комиссий биржи
   * @returns Общая прибыль в USDT или null, если расчет невозможен
   */
  private async _calculateTotalProfit(): Promise<DecimalValue | null> {
    try {
      // Получаем состояние аккаунта (уже обновленное в вызывающем методе)
      const accountState = this.accountState.getAccountState();
      const openPositions = accountState.open_positions;

      if (openPositions.length === 0) {
        return new DecimalConstructor(0) as DecimalValue;
      }

      let totalProfit = new DecimalConstructor(0) as DecimalValue;
      const exchangeFeePercent = new DecimalConstructor(0.001); // 0.1% комиссия биржи
      let processedCount = 0;
      const failedPositions: Array<{ pair: string; error: string }> = [];

      for (const position of openPositions) {
        try {
          // Получаем текущую цену для позиции
          const ticker = await this.exchangeService.fetchTicker(position.pair);
          const currentPrice = ticker.last;

          // Расчет гипотетической прибыли при закрытии позиции
          const entryPrice = position.average_entry_price;
          const amount = position.amount;
          // Примечание: в гипотетическом расчете используем 0 для комиссии на вход,
          // так как точные данные доступны только при реальном закрытии
          const entryFeeCost = new DecimalConstructor(0); // Комиссия на вход (гипотетическая)

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const entryPriceDecimal = entryPrice as any;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const currentPriceDecimal = currentPrice as any;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const amountDecimal = amount as any;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const entryFeeDecimal = entryFeeCost as any;

          let grossProfit: DecimalValue;
          if (position.side === 'long') {
            // Для LONG: валовая прибыль = (текущая_цена - цена_входа) * объем
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            grossProfit = currentPriceDecimal.minus(entryPriceDecimal).mul(amountDecimal) as DecimalValue;
          } else {
            // Для SHORT: валовая прибыль = (цена_входа - текущая_цена) * объем
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            grossProfit = entryPriceDecimal.minus(currentPriceDecimal).mul(amountDecimal) as DecimalValue;
          }

          // Вычитаем комиссии: комиссия на вход + комиссия на выход (0.1% от объема в USDT)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const closeValue = currentPriceDecimal.mul(amountDecimal) as DecimalValue;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const closeFee = closeValue.mul(exchangeFeePercent) as DecimalValue;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const totalFees = entryFeeDecimal.plus(closeFee) as DecimalValue;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const positionProfit = (grossProfit as any).minus(totalFees) as DecimalValue;

          // Суммируем прибыль/убыток по всем позициям (включая отрицательные значения)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          totalProfit = (totalProfit as any).plus(positionProfit) as DecimalValue;
          processedCount++;

          // Логируем расчет для каждой позиции для отладки
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const positionProfitNum = (positionProfit as any).toNumber();
          this.logger.debug(
            `[${position.pair}] ${position.side.toUpperCase()} позиция: ` +
              `объем=${amountDecimal.toString()}, ` +
              `вход=${entryPriceDecimal.toString()}, ` +
              `текущая=${currentPriceDecimal.toString()}, ` +
              `прибыль/убыток=${positionProfitNum.toFixed(4)} USDT`,
          );
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          failedPositions.push({ pair: position.pair, error: errorMessage });
          this.logger.warn(`Ошибка при расчете прибыли для позиции ${position.pair}: ${errorMessage}`, error);
          // Продолжаем с другими позициями
        }
      }

      // Логируем результат с деталями
      if (failedPositions.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const totalProfitNum = (totalProfit as any).toNumber();
        this.logger.warn(
          `Расчет прибыли завершен частично: обработано ${processedCount}/${openPositions.length} позиций. ` +
            `Частичная прибыль: ${totalProfitNum.toFixed(4)} USDT. ` +
            `Ошибки в позициях: ${failedPositions.map((p) => `${p.pair} (${p.error})`).join(', ')}`,
        );
      }

      return totalProfit;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Критическая ошибка при расчете общей прибыли: ${errorMessage}`, error);
      return null;
    }
  }

  /**
   * Закрывает все открытые позиции через market ордера
   */
  private async _closeAllPositions(): Promise<void> {
    try {
      this.logger.info('Начинаем закрытие всех открытых позиций...');

      const accountState = this.accountState.getAccountState();
      const openPositions = accountState.open_positions;

      if (openPositions.length === 0) {
        this.logger.info('Нет открытых позиций для закрытия');
        return;
      }

      // Примечание: Используем динамические импорты здесь, чтобы избежать циклических зависимостей
      // при инициализации FastCycleService. Эти сервисы требуются только в редких случаях
      // (при автоматическом закрытии всех позиций), поэтому динамический импорт оправдан.
      const { WorkerService } = await import('./WorkerService.js');
      const { ValidatorService } = await import('./ValidatorService.js');
      const { GuaranteedOrderExecutionService } = await import('./GuaranteedOrderExecutionService.js');
      const { DatabaseService } = await import('./DatabaseService.js');
      const { EventBusService } = await import('./EventBusService.js');
      const { NotificationService } = await import('./NotificationService.js');
      const { ExchangeRulesService } = await import('./ExchangeRulesService.js');

      const databaseService = DatabaseService.getInstance();
      const eventBus = EventBusService.getInstance();
      const notificationService = NotificationService.getInstance(this.configService);
      const exchangeRulesService = ExchangeRulesService.getInstance();
      const validatorService = ValidatorService.getInstance(exchangeRulesService);
      const executionService = GuaranteedOrderExecutionService.getInstance();
      executionService.initialize(this.exchangeService);

      const workerService = WorkerService.getInstance(
        validatorService,
        executionService,
        databaseService,
        eventBus,
        notificationService,
        this.globalState,
        this.accountState,
        exchangeRulesService,
        this.exchangeService,
        this.configService,
      );

      // Закрываем каждую позицию, проверяя актуальность перед каждым закрытием
      for (const originalPosition of openPositions) {
        try {
          // Проверяем, существует ли позиция еще в БД (могла быть закрыта TSL или другой логикой)
          const positionResult = await databaseService.query(`SELECT pair FROM ActivePositions WHERE pair = $1`, [
            originalPosition.pair,
          ]);

          if (!positionResult.rowCount || positionResult.rowCount === 0) {
            this.logger.info(`Позиция ${originalPosition.pair} уже закрыта (не найдена в БД), пропускаем`);
            continue;
          }

          // Дополнительная проверка в accountState для консистентности
          const currentAccountState = this.accountState.getAccountState();
          const currentPosition = currentAccountState.open_positions.find((p) => p.pair === originalPosition.pair);

          if (!currentPosition) {
            this.logger.info(`Позиция ${originalPosition.pair} уже закрыта (не найдена в accountState), пропускаем`);
            continue;
          }

          this.logger.info(`Закрываем позицию ${currentPosition.pair}...`);

          // Создаем decision для закрытия позиции
          const closeDecision = {
            action: 'CLOSE_POSITION' as const,
            pair: currentPosition.pair,
            parameters: {
              type: 'market' as const,
              amount_percent: 100, // Закрываем всю позицию
            },
            justification: 'Автоматическое закрытие всех позиций при достижении целевой прибыли',
          };

          // Получаем актуальное состояние для этой позиции
          const currentMarketData = {
            pair: currentPosition.pair,
            current_price: (await this.exchangeService.fetchTicker(currentPosition.pair)).last,
          };

          // Получаем strategy context
          const strategyContext = {
            role: 'Auto Close All Positions',
            style: 'Conservative',
            risk_rules: {
              default_risk_per_trade_percent: 1,
              max_allowed_risk_per_trade_percent: 5,
              max_total_portfolio_risk_percent: 10,
              desired_risk_reward_ratio: 2,
            },
            watchlist: this.configService.getWatchlist(),
          };

          // Валидируем decision
          validatorService.validateDecision(
            closeDecision,
            currentAccountState,
            strategyContext,
            currentMarketData,
            exchangeRulesService.getRules(currentPosition.pair),
          );

          // Создаем запись в LLM_Decision_Log для auto-close операции
          const logResult = await databaseService.query(
            `INSERT INTO LLM_Decision_Log (
              timestamp, triggered_pair, trigger_reason,
              request_payload_json, response_payload_json, decision_result
            ) VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id`,
            [
              new Date(),
              currentPosition.pair,
              'auto_close_profitable_position',
              JSON.stringify({
                action: 'auto_close',
                position: currentPosition,
                accountState: currentAccountState,
              }),
              JSON.stringify({
                decision: closeDecision,
                reason: 'Auto-close profitable position by FastCycle',
              }),
              'pending',
            ],
          );

          if (!logResult.rows[0]) {
            throw new Error(`Failed to create LLM_Decision_Log for auto-close ${currentPosition.pair}`);
          }

          const llmDecisionLogId = String(logResult.rows[0].id);

          // Выполняем закрытие через WorkerService
          await workerService.execute(
            closeDecision,
            llmDecisionLogId,
            currentAccountState,
            strategyContext,
            currentMarketData,
          );

          this.logger.info(`Позиция ${currentPosition.pair} успешно закрыта`);

          // Обновляем состояние аккаунта после каждого закрытия
          await this.accountState.refreshNow();
        } catch (error) {
          this.logger.error(`Ошибка при закрытии позиции ${originalPosition.pair}:`, error);
          // Продолжаем с другими позициями
        }
      }

      this.logger.info('Закрытие всех позиций завершено');
    } catch (error) {
      this.logger.error('Критическая ошибка при закрытии всех позиций:', error);
    }
  }

  /**
   * Проверяет общую прибыль всех позиций и закрывает их, если прибыль > 10 USD
   */
  private async _checkAndClosePositionsIfProfitable(): Promise<void> {
    // Защита от множественных одновременных вызовов
    // Флаг должен быть уже установлен в _handleTickerData или в таймере
    if (!this.isCheckingProfit) {
      // Если флаг не установлен, значит вызов произошел нестандартным путем
      // Устанавливаем флаг здесь для безопасности
      this.isCheckingProfit = true;
    }

    if (this.isClosingAllPositions) {
      this.logger.debug('(FastCycle) Проверка прибыли пропущена: закрываются позиции');
      this.isCheckingProfit = false;
      return;
    }

    this.profitCheckStartTime = Date.now();
    this.logger.info('(FastCycle) Начало проверки прибыли позиций...');

    try {
      // Обновляем состояние аккаунта перед проверкой
      await this.accountState.refreshNow();
      const accountState = this.accountState.getAccountState();

      // Если нет открытых позиций, не считаем прибыль и не закрываем
      if (accountState.open_positions.length === 0) {
        this.isCheckingProfit = false;
        this.profitCheckStartTime = 0;
        return;
      }

      const totalProfit = await this._calculateTotalProfit();

      if (totalProfit === null) {
        this.isCheckingProfit = false;
        this.profitCheckStartTime = 0;
        return; // Не удалось рассчитать прибыль
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const profitDecimal = totalProfit as any;

      // Логируем прибыль один раз за проверку
      const profitNum = profitDecimal.toNumber();
      this.logger.info(
        `[FastCycle] Общая прибыль портфеля: ${profitNum.toFixed(4)} USDT (${accountState.open_positions.length} позиций)`,
      );

      const minProfitThreshold = new DecimalConstructor(10); // 10 долларов

      if (profitDecimal.gte(minProfitThreshold)) {
        this.logger.info(`Обнаружена общая прибыль: ${profitDecimal.toFixed(2)} USDT. Закрываем все позиции...`);

        // Устанавливаем флаг блокировки
        this.isClosingAllPositions = true;

        await this._closeAllPositions();

        this.logger.info(`Все позиции закрыты. Целевая прибыль зафиксирована: ${profitDecimal.toFixed(2)} USDT`);

        // Очищаем базу данных от информации об открытых сделках и пересоздаем триггеры
        await this._cleanupDatabaseAfterCloseAll();

        this.logger.info('База данных очищена и триггеры пересозданы с таймаутами');

        // Отправляем уведомление в Telegram
        const message = `🎯 **АВТОМАТИЧЕСКОЕ ЗАКРЫТИЕ ВСЕХ ПОЗИЦИЙ**\n\n💰 *Общая прибыль зафиксирована:* ${profitDecimal.toFixed(2)} USDT\n\n📊 Все открытые позиции были закрыты по текущим рыночным ценам для фиксации прибыли.\n\n*Причина:* Достигнут порог прибыли > 10 USD`;

        this.notificationService.sendAlert(message, true); // true для включения состояния аккаунта
      }
    } catch (error) {
      this.logger.error('Ошибка при проверке и закрытии позиций:', error);
    } finally {
      // Снимаем флаг блокировки
      const checkDuration = Date.now() - this.profitCheckStartTime;
      this.logger.info(`(FastCycle) Проверка прибыли завершена за ${Math.round(checkDuration / 1000)} сек`);
      this.isCheckingProfit = false;
      this.isClosingAllPositions = false;
      this.profitCheckStartTime = 0;
    }
  }

  /**
   * Очищает базу данных после закрытия всех позиций и пересоздает триггеры с таймаутами
   */
  private async _cleanupDatabaseAfterCloseAll(): Promise<void> {
    try {
      this.logger.info('Очищаем базу данных от информации об открытых сделках...');

      // Используем DatabaseService вместо создания нового подключения
      const { DatabaseService } = await import('./DatabaseService.js');
      const databaseService = DatabaseService.getInstance();

      this.logger.info(
        'Очищаем таблицы ActivePositions, ActiveOrders, TSL_State, TradeHistory, LLM_Triggers, LLM_Decision_Log...',
      );

      // Очищаем все таблицы и сбрасываем счетчики SERIAL
      await databaseService.query(
        'TRUNCATE activepositions, activeorders, tsl_state, tradehistory, llm_triggers, llm_decision_log RESTART IDENTITY CASCADE',
      );

      this.logger.info('Все таблицы очищены, счетчики ID сброшены');

      // Создаем начальные триггеры для всех пар из watchlist
      this.logger.info('Создаем начальные триггеры с таймаутами...');
      const watchlist = this.configService.getWatchlist();

      this.logger.info(`Пары для инициализации: ${watchlist.join(', ')}`);

      for (let i = 0; i < watchlist.length; i++) {
        const pair = watchlist[i];
        // Создаем триггеры с задержкой 1 минута между парами
        // Первая пара сработает через 1 минуту, вторая через 2 минуты и т.д.
        const initialTimeout = Date.now() + (i + 1) * 60000; // (i + 1) минут от текущего времени

        const triggerConditions = [
          {
            type: 'timeout' as const,
            value: initialTimeout,
          },
        ];

        try {
          await databaseService.query(
            `INSERT INTO LLM_Triggers (pair, reason, trigger_conditions_json, requested_data_json, updated_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (pair) DO UPDATE SET
               reason = EXCLUDED.reason,
               trigger_conditions_json = EXCLUDED.trigger_conditions_json,
               requested_data_json = EXCLUDED.requested_data_json,
               updated_at = EXCLUDED.updated_at`,
            [
              pair,
              'Auto close all positions - trigger reset after profit taking',
              JSON.stringify(triggerConditions),
              null,
              new Date(),
            ],
          );

          const triggerTime = new Date(initialTimeout).toLocaleTimeString();
          this.logger.info(`${pair}: триггер на ${triggerTime} (через ${i + 1} мин.)`);
        } catch (error) {
          this.logger.error(`Ошибка при создании триггера для ${pair}:`, error);
          throw error;
        }
      }

      this.logger.info('Триггеры пересозданы с таймаутами');
    } catch (error) {
      this.logger.error('Ошибка при очистке базы данных:', error);
      throw error;
    }
  }

  /**
   * Обработчик тика (вызывается на каждый обновленный тикер)
   * КРИТИЧНО: Метод НЕ async и НЕ содержит await
   */
  private _handleTickerData(ticker: IDecimalTicker): void {
    // Обновляем время последнего тикера
    const now = Date.now();
    this.lastTickerTime = now;
    this.tickerCount++;

    // Логируем получение тикеров каждые 100 тикеров (чтобы не засорять логи)
    if (this.tickerCount % 100 === 0) {
      this.logger.debug(
        `(FastCycle) Получено ${this.tickerCount} тикеров. Последний: ${ticker.symbol} @ ${ticker.last}`,
      );
    }

    // Проверка состояния (критично)
    if (this.globalState.getIsPaused() || this.globalState.getIsShuttingDown() || this.isStopping) {
      return;
    }

    try {
      // (Задача 5.4) Делегирование TSL (без await)
      this.tslHandler.handleTicker(ticker);

      // (Задача 5.5) Делегирование Price Triggers (без await)
      this.priceTriggerHandler.handleTicker(ticker);

      // Расчет общей прибыли и автоматическое закрытие позиций (не чаще чем раз в 30 секунд)
      if (now - this.lastProfitCheck > 30000 && !this.isCheckingProfit) {
        // 30 секунд и проверка не выполняется
        // Сохраняем старое значение для корректного вычисления времени
        const savedLastCheck = this.lastProfitCheck;
        // Устанавливаем флаг ДО асинхронного вызова для защиты от race condition
        this.isCheckingProfit = true;
        this.lastProfitCheck = now;
        const timeSinceLastCheck = savedLastCheck > 0 ? Math.round((now - savedLastCheck) / 1000) : 0;
        this.logger.info(`(FastCycle) Запуск проверки прибыли (прошло ${timeSinceLastCheck} сек с последней проверки)`);
        this._checkAndClosePositionsIfProfitable().catch((error) => {
          this.logger.error(`(FastCycle) [${ticker.symbol}] Ошибка при проверке прибыли: ${String(error)}`, error);
        });
      }
    } catch (error) {
      this.logger.error(`(FastCycle) [${ticker.symbol}] КРИТИЧЕСКИЙ СБОЙ обработчика "тика": ${String(error)}`, error);
      // Не бросаем ошибку, чтобы не "убить" WS-цикл
    }
  }

  /**
   * Мониторинг получения тикеров - проверяет, что тикеры продолжают приходить
   */
  private async _startTickerMonitoring(): Promise<void> {
    const monitoringInterval = 60000; // Проверяем каждую минуту

    while (!this.isStopping) {
      await this._sleep(monitoringInterval);

      const now = Date.now();
      const timeSinceLastTicker = now - this.lastTickerTime;

      if (this.lastTickerTime === 0) {
        // Еще не было тикеров
        this.logger.warn('(FastCycle) Мониторинг: тикеры еще не получены');
      } else if (timeSinceLastTicker > 120000) {
        // Нет тикеров более 2 минут - это проблема
        this.logger.error(
          `(FastCycle) КРИТИЧНО: Тикеры не поступают уже ${Math.round(timeSinceLastTicker / 1000)} секунд! Последний тикер был ${new Date(this.lastTickerTime).toISOString()}`,
        );
      } else if (timeSinceLastTicker > 60000) {
        // Нет тикеров более 1 минуты - предупреждение
        this.logger.warn(
          `(FastCycle) ВНИМАНИЕ: Тикеры не поступают уже ${Math.round(timeSinceLastTicker / 1000)} секунд. Последний тикер был ${new Date(this.lastTickerTime).toISOString()}`,
        );
      } else {
        // Все в порядке
        this.logger.debug(
          `(FastCycle) Мониторинг: OK. Получено ${this.tickerCount} тикеров. Последний тикер ${Math.round(timeSinceLastTicker / 1000)} сек назад`,
        );
      }

      // Проверяем, не застряла ли проверка прибыли
      if (this.isCheckingProfit && this.profitCheckStartTime > 0) {
        const timeSinceCheckStarted = now - this.profitCheckStartTime;
        if (timeSinceCheckStarted > 120000) {
          // Проверка прибыли выполняется более 2 минут - это проблема
          this.logger.error(
            `(FastCycle) КРИТИЧНО: Проверка прибыли выполняется уже ${Math.round(timeSinceCheckStarted / 1000)} секунд! Возможно, застряла.`,
          );
        } else if (timeSinceCheckStarted > 60000) {
          // Проверка прибыли выполняется более 1 минуты - предупреждение
          this.logger.warn(
            `(FastCycle) ВНИМАНИЕ: Проверка прибыли выполняется уже ${Math.round(timeSinceCheckStarted / 1000)} секунд (обычно должно быть < 10 сек)`,
          );
        }
      } else {
        // Проверяем, не пора ли запустить проверку прибыли принудительно
        const timeSinceLastCheck = now - this.lastProfitCheck;
        if (this.lastProfitCheck > 0 && timeSinceLastCheck > 90000) {
          // Прошло более 90 секунд с последней проверки - предупреждение
          this.logger.warn(
            `(FastCycle) ВНИМАНИЕ: Прошло ${Math.round(timeSinceLastCheck / 1000)} секунд с последней проверки прибыли. Ожидается каждые 30 секунд.`,
          );
        }
      }
    }
  }

  /**
   * Запускает независимый таймер для проверки прибыли каждые 30 секунд
   * Это гарантирует проверку даже если тикеры перестанут приходить
   */
  private _startProfitCheckTimer(): void {
    // Проверяем прибыль каждые 30 секунд независимо от тикеров
    this.profitCheckTimer = setInterval(() => {
      if (this.isStopping || this.globalState.getIsPaused() || this.globalState.getIsShuttingDown()) {
        return;
      }

      // Проверяем, не выполняется ли уже проверка
      if (this.isCheckingProfit) {
        this.logger.debug('(FastCycle) Проверка прибыли пропущена (уже выполняется)');
        return;
      }

      const now = Date.now();

      // Оптимизация: проверяем наличие позиций только раз в 5 секунд для экономии ресурсов
      const shouldCheckPositions = now - this.lastPositionCheckTime > 5000;
      if (shouldCheckPositions) {
        const accountState = this.accountState.getAccountState();
        this.hasOpenPositionsCache = accountState.open_positions.length > 0;
        this.lastPositionCheckTime = now;
      }

      // Используем кэшированное значение
      if (!this.hasOpenPositionsCache) {
        return; // Нет позиций, нечего проверять
      }

      // Проверяем, прошло ли достаточно времени с последней проверки
      const timeSinceLastCheck = now - this.lastProfitCheck;

      if (timeSinceLastCheck >= 30000) {
        // Устанавливаем флаг ДО асинхронного вызова для защиты от race condition
        // Дополнительная проверка на случай, если флаг установился между проверками
        if (this.isCheckingProfit) {
          this.logger.debug('(FastCycle) [Таймер] Проверка прибыли пропущена: уже выполняется');
          return;
        }
        this.isCheckingProfit = true;
        this.lastProfitCheck = now;
        this.logger.info(
          `(FastCycle) [Таймер] Запуск проверки прибыли (прошло ${Math.round(timeSinceLastCheck / 1000)} сек с последней проверки)`,
        );
        this._checkAndClosePositionsIfProfitable().catch((error) => {
          this.logger.error(`(FastCycle) [Таймер] Ошибка при проверке прибыли: ${String(error)}`, error);
        });
      } else {
        this.logger.debug(
          `(FastCycle) [Таймер] Проверка прибыли пропущена (прошло только ${Math.round(timeSinceLastCheck / 1000)} сек)`,
        );
      }
    }, 30000); // Проверяем каждые 30 секунд

    this.logger.info('(FastCycle) Независимый таймер проверки прибыли запущен (каждые 30 сек)');
  }

  /**
   * Вспомогательный метод для паузы
   */
  private async _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
