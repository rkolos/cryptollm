import { LoggingService } from './LoggingService.js';
import { ConfigService } from './ConfigService.js';
import { GlobalStateService } from './GlobalStateService.js';
import type { IExchangeService, IDecimalTicker } from '../interfaces/IExchangeService.js';
import type winston from 'winston';

/**
 * Интерфейс для TSLHandlerService (реализован в задаче 5.4)
 */
export interface ITSLHandlerService {
  handleTicker(ticker: IDecimalTicker): void;
}

/**
 * Интерфейс для PriceTriggerHandler (будет реализован в задаче 5.5)
 */
export interface IPriceTriggerHandler {
  handleTicker(ticker: IDecimalTicker): void;
}

export class FastCycleService {
  private static instance: FastCycleService | undefined;
  private readonly logger: winston.Logger;
  private readonly configService: ConfigService;
  private readonly globalState: GlobalStateService;
  private readonly exchangeService: IExchangeService;
  private readonly tslHandler: ITSLHandlerService;
  private readonly priceTriggerHandler: IPriceTriggerHandler;

  private isStopping: boolean = false;

  private constructor(
    configService: ConfigService,
    globalState: GlobalStateService,
    exchangeService: IExchangeService,
    tslHandler: ITSLHandlerService,
    priceTriggerHandler: IPriceTriggerHandler,
  ) {
    this.configService = configService;
    this.globalState = globalState;
    this.exchangeService = exchangeService;
    this.tslHandler = tslHandler;
    this.priceTriggerHandler = priceTriggerHandler;
    this.logger = LoggingService.getInstance().getLogger('FastCycle');
    this.logger.info('FastCycleService initialized.');
  }

  public static getInstance(
    configService: ConfigService,
    globalState: GlobalStateService,
    exchangeService: IExchangeService,
    tslHandler: ITSLHandlerService,
    priceTriggerHandler: IPriceTriggerHandler,
  ): FastCycleService {
    if (!FastCycleService.instance) {
      FastCycleService.instance = new FastCycleService(
        configService,
        globalState,
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
    // Запускаем вечный цикл в фоновом режиме (без await)
    this._runWebSocketLoop().catch((error) => {
      this.logger.error('(FastCycle) Фатальная ошибка в _runWebSocketLoop:', error);
    });
  }

  /**
   * Останавливает быстрый цикл
   */
  public async stop(): Promise<void> {
    this.logger.warn('(FastCycle) Остановка...');
    this.isStopping = true;
    await this.exchangeService.close();
    this.logger.info('(FastCycle) Остановлен.');
  }

  /**
   * Вечный цикл WebSocket с автоматическим переподключением
   */
  private async _runWebSocketLoop(): Promise<void> {
    const watchlist = this.configService.getWatchlist();
    const reconnectDelayMs = 5000; // 5 секунд

    while (!this.isStopping) {
      try {
        this.logger.info(`(FastCycle) Подключение к watchTickers для ${watchlist.length} пар...`);

        // watchTickers возвращает Promise<void>, который завершается при закрытии соединения
        // Оборачиваем синхронный _handleTickerData в async функцию для соответствия интерфейсу
        await this.exchangeService.watchTickers(watchlist, async (ticker) => {
          this._handleTickerData(ticker);
        });

        // Если мы здесь, значит ccxt "отвалился" штатно (без ошибки)
        this.logger.info('(FastCycle) watchTickers завершился штатно. Переподключение...');
      } catch (error) {
        this.logger.error(`(FastCycle) Ошибка watchTickers: ${String(error)}. Переподключение через ${reconnectDelayMs} мс...`);

        // Если это не остановка, ждем перед переподключением
        if (!this.isStopping) {
          await this._sleep(reconnectDelayMs);
        }
      }
    }

    this.logger.info('(FastCycle) Вечный цикл завершен (isStopping = true).');
  }

  /**
   * Обработчик тика (вызывается на каждый обновленный тикер)
   * КРИТИЧНО: Метод НЕ async и НЕ содержит await
   */
  private _handleTickerData(ticker: IDecimalTicker): void {
    // Проверка состояния (критично)
    if (this.globalState.getIsPaused() || this.globalState.getIsShuttingDown() || this.isStopping) {
      return;
    }

    try {
      // (Задача 5.4) Делегирование TSL (без await)
      this.tslHandler.handleTicker(ticker);

      // (Задача 5.5) Делегирование Price Triggers (без await)
      this.priceTriggerHandler.handleTicker(ticker);
    } catch (error) {
      this.logger.error(
        `(FastCycle) [${ticker.symbol}] КРИТИЧЕСКИЙ СБОЙ обработчика "тика": ${String(error)}`,
        error,
      );
      // Не бросаем ошибку, чтобы не "убить" WS-цикл
    }
  }

  /**
   * Вспомогательный метод для паузы
   */
  private async _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

