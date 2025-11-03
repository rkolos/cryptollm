import * as ccxt from 'ccxt';
import Decimal from 'decimal.js';
import WebSocket from 'ws';
import { ConfigService } from './ConfigService.js';
import { LoggingService } from './LoggingService.js';
import { GlobalStateService } from './GlobalStateService.js';
import type { IExchangeService, DecimalValue } from '../interfaces/IExchangeService.js';
import type {
  IDecimalOHLCV,
  IDecimalTicker,
  IDecimalOrderBook,
  IDecimalBalance,
  IDecimalOrder,
  IDecimalTrade,
} from '../interfaces/IExchangeService.js';
import {
  ExchangeError,
  ExchangeNetworkError,
  ExchangeApiError,
  ExchangeRateLimitError,
  InsufficientFundsError,
  OrderNotFoundError,
} from '../errors/ExchangeErrors.js';
import type winston from 'winston';

export class ProductionExchangeService implements IExchangeService {
  private readonly ccxtExchange: ccxt.binance;
  private readonly logger: winston.Logger;
  private timeSyncDone: boolean = false;
  private readonly appMode: string;
  private wsConnection: WebSocket | null = null;
  private wsReconnectAttempts: number = 0;
  private readonly maxReconnectAttempts: number = 10;

  constructor() {
    const config = ConfigService.getInstance();
    const binanceConfig = config.getBinanceConfig();
    this.appMode = config.getAppMode();

    this.ccxtExchange = new ccxt.binance({
      apiKey: binanceConfig.apiKey,
      secret: binanceConfig.secret,
      enableRateLimit: true,
      enableTimeSync: true, // Включаем автоматическую синхронизацию времени
      timeout: 30000, // Увеличиваем таймаут HTTP запросов до 30 секунд
      options: {
        defaultType: 'spot',
        recvWindow: 10000, // Увеличиваем окно времени до 10 секунд для надежности
      },
    });

    if (this.appMode === 'testnet') {
      this.ccxtExchange.setSandboxMode(true);
      const logger = LoggingService.getInstance().getLogger('Exchange');
      logger.warn('Binance Testnet mode enabled.');
    }

    this.logger = LoggingService.getInstance().getLogger('Exchange');
  }

  /**
   * Синхронизирует время с сервером Binance Testnet один раз
   */
  private async _syncTimeOnce(): Promise<void> {
    if (this.timeSyncDone) {
      return;
    }

    try {
      // Получаем время сервера через публичный endpoint (не требует авторизации)
      const baseUrl = this.appMode === 'testnet' ? 'https://testnet.binance.vision' : 'https://api.binance.com';
      const serverTimeResponse = await fetch(`${baseUrl}/api/v3/time`);
      const serverTimeData = (await serverTimeResponse.json()) as { serverTime: number };

      if (serverTimeData.serverTime) {
        const localTime = Date.now();
        const timeDiff = serverTimeData.serverTime - localTime;

        // CCXT автоматически синхронизирует время через loadTimeDifference
        // Но мы можем явно установить разницу через прямое обращение к API
        // Для этого используем встроенный механизм CCXT
        await this.ccxtExchange.loadTimeDifference();

        // Проверяем, что синхронизация прошла успешно
        // Используем timeDifference из CCXT, если доступен
        const ccxtTimeDiff = (this.ccxtExchange as unknown as { timeDifference?: number }).timeDifference || 0;
        this.logger.info(
          `Time synchronized: server=${serverTimeData.serverTime}, local=${localTime}, diff=${timeDiff}ms, CCXT diff=${ccxtTimeDiff}ms`,
        );

        this.timeSyncDone = true;
      }
    } catch (timeError) {
      this.logger.warn(
        `Time sync failed: ${timeError instanceof Error ? timeError.message : String(timeError)}. Will retry on next request.`,
      );
      // Не устанавливаем timeSyncDone = true, чтобы попробовать еще раз
    }
  }

  private async execute<T>(fn: () => Promise<T>, maxRetries: number = 5): Promise<T> {
    // Для testnet: синхронизируем время один раз при первом запросе
    if (this.appMode === 'testnet' && !this.timeSyncDone) {
      await this._syncTimeOnce();
    }

    let lastError: unknown;
    const retryDelayMs = 2000; // Пауза между попытками: 2 секунды

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const result = await fn();
        // Если это повторная попытка и она успешна, логируем успех
        if (attempt > 0) {
          this.logger.info(
            `Request succeeded after ${attempt + 1} attempt(s). Previous attempt(s) failed with network error/timeout.`,
          );
        }
        return result;
      } catch (error) {
        lastError = error;

        // Если получили ошибку -1021 (timestamp), пробуем пересинхронизировать время и повторить запрос
        if (
          this.appMode === 'testnet' &&
          error instanceof ccxt.NetworkError &&
          error.message.includes('-1021') &&
          error.message.includes('Timestamp')
        ) {
          this.logger.warn(
            `Timestamp error detected (attempt ${attempt + 1}/${maxRetries}), re-syncing time and retrying...`,
          );
          this.timeSyncDone = false; // Сбрасываем флаг для повторной синхронизации
          await this._syncTimeOnce();
          // Повторяем запрос после синхронизации без задержки
          continue;
        }

        // Проверяем, является ли ошибка сетевой (timeout, network error) и можно ли повторить
        const isRetryableError =
          error instanceof ccxt.NetworkError ||
          (error instanceof Error && (error.message.includes('timeout') || error.message.includes('timed out')));

        if (isRetryableError && attempt < maxRetries - 1) {
          const delay = retryDelayMs * (attempt + 1); // Увеличиваем задержку с каждой попыткой
          this.logger.warn(
            `Network error/timeout detected (attempt ${attempt + 1}/${maxRetries}): ${error instanceof Error ? error.message : String(error)}. Retrying in ${delay}ms...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue; // Повторяем попытку
        }

        // Если это последняя попытка и ошибка retryable, логируем финальный провал
        if (isRetryableError && attempt === maxRetries - 1) {
          this.logger.error(
            `All ${maxRetries} retry attempts failed. Last error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        // Если это не retryable ошибка или исчерпаны попытки, обрабатываем ошибку как обычно
        if (error instanceof ccxt.RateLimitExceeded) {
          throw new ExchangeRateLimitError(`Rate limit exceeded: ${error.message}`, error);
        }

        if (error instanceof ccxt.InsufficientFunds) {
          throw new InsufficientFundsError(`Insufficient funds: ${error.message}`, undefined, error);
        }

        if (error instanceof ccxt.NetworkError) {
          throw new ExchangeNetworkError(`Network error: ${error.message}`, error);
        }

        if (error instanceof ccxt.OrderNotFound) {
          throw new OrderNotFoundError(`Order not found: ${error.message}`, undefined, error);
        }

        if (error instanceof ccxt.BaseError) {
          throw new ExchangeApiError(`Exchange API error: ${error.message}`, error);
        }

        throw new ExchangeError(`Unknown exchange error: ${String(error)}`, error);
      }
    }

    // Если дошли сюда, значит все попытки исчерпаны
    this.logger.error(
      `Request failed after ${maxRetries} attempts. Final error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );

    if (lastError instanceof ccxt.NetworkError) {
      throw new ExchangeNetworkError(`Network error after ${maxRetries} attempts: ${lastError.message}`, lastError);
    }

    throw new ExchangeError(`Failed after ${maxRetries} attempts: ${String(lastError)}`, lastError);
  }

  private toDecimal(value: number | string | undefined | null): DecimalValue {
    if (value === undefined || value === null) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return new (Decimal as any)(0);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new (Decimal as any)(String(value));
  }

  public async loadMarkets(): Promise<void> {
    await this.execute(async () => {
      await this.ccxtExchange.loadMarkets();
      this.logger.info('Markets loaded successfully.');
    });
  }

  public getRawMarkets(): Record<string, unknown> {
    return this.ccxtExchange.markets as Record<string, unknown>;
  }

  public async fetchOHLCV(symbol: string, timeframe: string, since?: number, limit?: number): Promise<IDecimalOHLCV[]> {
    return await this.execute(async () => {
      const ohlcv = await this.ccxtExchange.fetchOHLCV(symbol, timeframe, since, limit);
      return ohlcv.map((candle) => ({
        timestamp: candle[0] as number,
        open: this.toDecimal(candle[1]),
        high: this.toDecimal(candle[2]),
        low: this.toDecimal(candle[3]),
        close: this.toDecimal(candle[4]),
        volume: this.toDecimal(candle[5]),
      }));
    });
  }

  public async fetchTicker(symbol: string): Promise<IDecimalTicker> {
    return await this.execute(async () => {
      const ticker = await this.ccxtExchange.fetchTicker(symbol);
      return {
        symbol: ticker.symbol,
        last: this.toDecimal(ticker.last),
        bid: this.toDecimal(ticker.bid),
        ask: this.toDecimal(ticker.ask),
        baseVolume: this.toDecimal(ticker.baseVolume),
        quoteVolume: this.toDecimal(ticker.quoteVolume),
        timestamp: ticker.timestamp,
      };
    });
  }

  public async fetchOrderBook(symbol: string, limit?: number): Promise<IDecimalOrderBook> {
    return await this.execute(async () => {
      const orderBook = await this.ccxtExchange.fetchOrderBook(symbol, limit);
      return {
        symbol: String(orderBook.symbol || ''),
        bids: orderBook.bids.map((bid: unknown) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const [price, amount] = bid as any;
          return [this.toDecimal(price), this.toDecimal(amount)];
        }),
        asks: orderBook.asks.map((ask: unknown) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const [price, amount] = ask as any;
          return [this.toDecimal(price), this.toDecimal(amount)];
        }),
        timestamp: orderBook.timestamp,
      };
    });
  }

  public async fetchBalance(): Promise<IDecimalBalance> {
    return await this.execute(async () => {
      const balance = await this.ccxtExchange.fetchBalance();
      const result: IDecimalBalance = {};

      for (const [currency, funds] of Object.entries(balance)) {
        if (currency === 'info' || currency === 'free' || currency === 'used' || currency === 'total') {
          continue;
        }

        if (typeof funds === 'object' && funds !== null) {
          result[currency] = {
            free: this.toDecimal((funds as ccxt.Balance).free),
            used: this.toDecimal((funds as ccxt.Balance).used),
            total: this.toDecimal((funds as ccxt.Balance).total),
          };
        }
      }

      return result;
    });
  }

  public async createOrder(
    symbol: string,
    type: string,
    side: 'buy' | 'sell',
    amount: DecimalValue,
    price?: DecimalValue,
    params?: Record<string, unknown>,
  ): Promise<IDecimalOrder> {
    return await this.execute(async () => {
      const order = await this.ccxtExchange.createOrder(
        symbol,
        type as ccxt.OrderType,
        side as ccxt.OrderSide,
        amount.toNumber(),
        price?.toNumber(),
        params,
      );
      return {
        id: String(order.id),
        clientOrderId: order.clientOrderId ? String(order.clientOrderId) : undefined,
        symbol: String(order.symbol),
        type: String(order.type),
        side: order.side as 'buy' | 'sell',
        amount: this.toDecimal(order.amount),
        price: order.price ? this.toDecimal(order.price) : undefined,
        status: String(order.status),
        filled: order.filled ? this.toDecimal(order.filled) : undefined,
        remaining: order.remaining ? this.toDecimal(order.remaining) : undefined,
        cost: order.cost ? this.toDecimal(order.cost) : undefined,
        timestamp: order.timestamp,
      };
    });
  }

  public async cancelOrder(orderId: string, symbol: string): Promise<void> {
    await this.execute(async () => {
      await this.ccxtExchange.cancelOrder(orderId, symbol, {});
    });
  }

  public async fetchOrder(orderId: string, symbol: string): Promise<IDecimalOrder> {
    return await this.execute(async () => {
      const order = await this.ccxtExchange.fetchOrder(orderId, symbol);
      return {
        id: String(order.id),
        clientOrderId: order.clientOrderId ? String(order.clientOrderId) : undefined,
        symbol: String(order.symbol),
        type: String(order.type),
        side: order.side as 'buy' | 'sell',
        amount: this.toDecimal(order.amount),
        price: order.price ? this.toDecimal(order.price) : undefined,
        status: String(order.status),
        filled: order.filled ? this.toDecimal(order.filled) : undefined,
        remaining: order.remaining ? this.toDecimal(order.remaining) : undefined,
        cost: order.cost ? this.toDecimal(order.cost) : undefined,
        timestamp: order.timestamp,
      };
    });
  }

  public async fetchOpenOrders(symbol?: string): Promise<IDecimalOrder[]> {
    return await this.execute(async () => {
      const orders = await this.ccxtExchange.fetchOpenOrders(symbol);
      return orders.map((order) => ({
        id: String(order.id),
        clientOrderId: order.clientOrderId ? String(order.clientOrderId) : undefined,
        symbol: String(order.symbol),
        type: String(order.type),
        side: order.side as 'buy' | 'sell',
        amount: this.toDecimal(order.amount),
        price: order.price ? this.toDecimal(order.price) : undefined,
        status: String(order.status),
        filled: order.filled ? this.toDecimal(order.filled) : undefined,
        remaining: order.remaining ? this.toDecimal(order.remaining) : undefined,
        cost: order.cost ? this.toDecimal(order.cost) : undefined,
        timestamp: order.timestamp,
      }));
    });
  }

  public async fetchMyTrades(symbol?: string, since?: number, limit?: number): Promise<IDecimalTrade[]> {
    return await this.execute(async () => {
      const trades = await this.ccxtExchange.fetchMyTrades(symbol, since, limit);
      return trades.map((trade: unknown) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const t = trade as any;
        return {
          id: String(t.id || ''),
          order: t.order ? String(t.order) : '',
          symbol: String(t.symbol || ''),
          side: t.side as 'buy' | 'sell',
          amount: this.toDecimal(t.amount),
          price: this.toDecimal(t.price),
          cost: this.toDecimal(t.cost),
          fee: {
            cost: this.toDecimal(t.fee?.cost),
            currency: t.fee?.currency || '',
          },
          timestamp: t.timestamp || 0,
        };
      });
    });
  }

  /**
   * Строит WebSocket URL для Binance ticker streams
   */
  private _buildWebSocketUrl(symbols: string[]): string {
    // Преобразуем символы в формат для Binance streams (например, BTC/USDT -> btcusdt@ticker)
    const streams = symbols.map((symbol) => `${symbol.replace('/', '').toLowerCase()}@ticker`).join('/');

    if (this.appMode === 'testnet') {
      // Правильный URL для Binance Spot Testnet WebSocket streams
      // Документация: https://developers.binance.com/docs/binance-spot-api-docs/testnet/web-socket-streams
      return `wss://stream.testnet.binance.vision/stream?streams=${streams}`;
    }
    return `wss://stream.binance.com:9443/stream?streams=${streams}`;
  }

  /**
   * Парсит данные из Binance WebSocket ticker stream в формат IDecimalTicker
   */
  private _parseBinanceTicker(data: unknown): IDecimalTicker | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const message = data as any;

      // Проверяем формат сообщения (может быть объект с полем data или сам объект данных)
      let tickerData: unknown;
      if (message && typeof message === 'object') {
        // Формат: { stream: "btcusdt@ticker", data: {...} }
        if ('data' in message && message.data) {
          tickerData = message.data;
        } else if ('e' in message && message.e === '24hrTicker') {
          // Прямой формат данных
          tickerData = message;
        } else {
          this.logger.warn('Unknown WebSocket message format:', JSON.stringify(message).substring(0, 200));
          return null;
        }
      } else {
        return null;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ticker = tickerData as any;

      // Проверяем обязательные поля
      if (!ticker.s || !ticker.c) {
        this.logger.warn('Invalid ticker data: missing required fields');
        return null;
      }

      return {
        symbol: ticker.s, // symbol
        last: this.toDecimal(ticker.c), // close/last price
        bid: this.toDecimal(ticker.b || ticker.c), // best bid price (fallback to last)
        ask: this.toDecimal(ticker.a || ticker.c), // best ask price (fallback to last)
        baseVolume: this.toDecimal(ticker.v || '0'), // base volume
        quoteVolume: this.toDecimal(ticker.q || '0'), // quote volume
        timestamp: ticker.E || Date.now(), // event time
      };
    } catch (error) {
      this.logger.error(`Error parsing Binance ticker data: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  public async watchTickers(symbols: string[], callback: (ticker: IDecimalTicker) => Promise<void>): Promise<void> {
    if (symbols.length === 0) {
      this.logger.warn('watchTickers called with empty symbols array');
      return;
    }

    const wsUrl = this._buildWebSocketUrl(symbols);
    this.logger.info(`Connecting to Binance WebSocket for ${symbols.length} pairs: ${wsUrl}`);

    const reconnectDelay = (attempt: number): number => {
      // Экспоненциальная задержка: 1s, 2s, 4s, 8s, 16s, max 30s
      return Math.min(1000 * Math.pow(2, attempt), 30000);
    };

    // Основной цикл подключения и переподключения
    while (!GlobalStateService.getInstance().getIsShuttingDown()) {
      // Проверяем состояние перед подключением
      if (GlobalStateService.getInstance().getIsShuttingDown()) {
        break;
      }

      try {
        // Проверяем, не превышен ли лимит попыток переподключения
        if (this.wsReconnectAttempts >= this.maxReconnectAttempts) {
          this.logger.error(`Max reconnection attempts (${this.maxReconnectAttempts}) reached. Stopping watchTickers.`);
          break;
        }

        // Создаем новое WebSocket соединение
        const ws = await new Promise<WebSocket>((resolve, reject) => {
          try {
            const websocket = new WebSocket(wsUrl);
            let resolved = false;

            // Обработка таймаута подключения
            const connectionTimeout = setTimeout(() => {
              if (!resolved && websocket.readyState !== WebSocket.OPEN) {
                websocket.close();
                reject(new Error('WebSocket connection timeout'));
              }
            }, 10000); // 10 секунд таймаут

            websocket.on('open', () => {
              if (!resolved) {
                resolved = true;
                clearTimeout(connectionTimeout);
                this.logger.info(`WebSocket connected for ${symbols.length} ticker streams`);
                this.wsReconnectAttempts = 0; // Сбрасываем счетчик при успешном подключении
                this.wsConnection = websocket;
                resolve(websocket);
              }
            });

            websocket.on('error', (error: Error) => {
              if (!resolved) {
                this.logger.error(`WebSocket connection error: ${error.message}`);
                // Не reject здесь, ждем события close или таймаута
              }
            });

            websocket.on(
              'unexpected-response',
              (request: unknown, response: { statusCode: number; statusMessage: string }) => {
                if (!resolved) {
                  resolved = true;
                  clearTimeout(connectionTimeout);
                  this.logger.error(`WebSocket unexpected response: ${response.statusCode} ${response.statusMessage}`);
                  reject(new Error(`Unexpected response: ${response.statusCode} ${response.statusMessage}`));
                }
              },
            );
          } catch (error) {
            reject(error);
          }
        });

        // Настраиваем обработчики сообщений
        ws.on('message', async (data: WebSocket.Data) => {
          try {
            const message = JSON.parse(data.toString());
            const ticker = this._parseBinanceTicker(message);

            if (ticker) {
              // Вызываем callback асинхронно, но не блокируем обработку сообщений
              callback(ticker).catch((callbackError) => {
                this.logger.error(
                  `Error in ticker callback for ${ticker.symbol}: ${callbackError instanceof Error ? callbackError.message : String(callbackError)}`,
                );
              });
            }
          } catch (parseError) {
            this.logger.error(
              `Error parsing WebSocket message: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            );
          }
        });

        // Ждем закрытия соединения
        await new Promise<void>((resolve) => {
          ws.on('close', (code: number, reason: Buffer) => {
            this.wsConnection = null;
            const reasonStr = reason.toString();

            // Если это штатное закрытие или shutdown, завершаем
            if (GlobalStateService.getInstance().getIsShuttingDown() || code === 1000) {
              this.logger.info(`WebSocket closed normally (code: ${code}, reason: ${reasonStr})`);
              resolve();
              return;
            }

            // Неожиданное закрытие - логируем и разрешаем Promise для переподключения
            this.logger.warn(
              `WebSocket closed unexpectedly (code: ${code}, reason: ${reasonStr}). Will reconnect in next iteration.`,
            );
            resolve(); // Разрешаем Promise, чтобы цикл while мог переподключиться
          });

          ws.on('error', (error: Error) => {
            this.logger.error(`WebSocket error during operation: ${error.message}`);
            // Ошибка не закрывает соединение автоматически, ждем события close
          });
        });

        // Если дошли сюда и это не shutdown, значит соединение закрылось неожиданно
        // Цикл while продолжит и попытается переподключиться
        if (GlobalStateService.getInstance().getIsShuttingDown()) {
          break;
        }

        // Увеличиваем счетчик попыток перед переподключением
        this.wsReconnectAttempts++;
        const delay = reconnectDelay(this.wsReconnectAttempts - 1); // -1 потому что счетчик уже увеличен

        if (this.wsReconnectAttempts < this.maxReconnectAttempts) {
          this.logger.info(
            `Reconnecting in ${delay}ms (attempt ${this.wsReconnectAttempts}/${this.maxReconnectAttempts})...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          this.logger.error(`Max reconnection attempts (${this.maxReconnectAttempts}) reached. Stopping watchTickers.`);
          break;
        }
      } catch (error) {
        if (GlobalStateService.getInstance().getIsShuttingDown()) {
          break;
        }

        this.logger.error(
          `WebSocket connection failed: ${error instanceof Error ? error.message : String(error)}. Retrying...`,
        );

        // Увеличиваем счетчик попыток перед повтором
        const delay = reconnectDelay(this.wsReconnectAttempts);
        this.wsReconnectAttempts++;

        if (this.wsReconnectAttempts < this.maxReconnectAttempts) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          this.logger.error(`Max reconnection attempts reached. Stopping watchTickers.`);
          break;
        }
      }
    }

    this.logger.info('watchTickers stopped');
  }

  public async close(): Promise<void> {
    // Закрываем WebSocket соединение, если оно открыто
    if (this.wsConnection) {
      try {
        this.wsConnection.close(1000, 'Normal closure');
        this.wsConnection = null;
        this.logger.info('WebSocket connection closed.');
      } catch (error) {
        this.logger.error(`Error closing WebSocket: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Закрываем CCXT соединения
    await this.ccxtExchange.close();
    this.logger.info('Exchange connections closed.');
  }
}
