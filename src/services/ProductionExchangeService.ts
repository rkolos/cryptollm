import * as ccxt from 'ccxt';
import Decimal from 'decimal.js';
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

  constructor() {
    const config = ConfigService.getInstance();
    const binanceConfig = config.getBinanceConfig();

    this.ccxtExchange = new ccxt.binance({
      apiKey: binanceConfig.apiKey,
      secret: binanceConfig.secret,
      enableRateLimit: true,
      options: {
        defaultType: 'spot',
      },
    });

    const appMode = config.getAppMode();
    if (appMode === 'testnet') {
      this.ccxtExchange.setSandboxMode(true);
      const logger = LoggingService.getInstance().getLogger('Exchange');
      logger.warn('Binance Testnet mode enabled.');
    }

    this.logger = LoggingService.getInstance().getLogger('Exchange');
  }

  private async execute<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
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

  public async watchTickers(symbols: string[], callback: (ticker: IDecimalTicker) => Promise<void>): Promise<void> {
    while (!GlobalStateService.getInstance().getIsShuttingDown()) {
      try {
        const tickers = await this.ccxtExchange.watchTickers(symbols);

        for (const ticker of Object.values(tickers)) {
          const decimalTicker: IDecimalTicker = {
            symbol: ticker.symbol,
            last: this.toDecimal(ticker.last),
            bid: this.toDecimal(ticker.bid),
            ask: this.toDecimal(ticker.ask),
            baseVolume: this.toDecimal(ticker.baseVolume),
            quoteVolume: this.toDecimal(ticker.quoteVolume),
            timestamp: ticker.timestamp,
          };

          await callback(decimalTicker);
        }
      } catch (error) {
        if (error instanceof ccxt.RateLimitExceeded) {
          this.logger.error('Rate limit exceeded in watchTickers:', error);
          await new Promise((resolve) => setTimeout(resolve, 5000));
          continue;
        }

        if (error instanceof ccxt.NetworkError) {
          this.logger.error('Network error in watchTickers:', error);
          await new Promise((resolve) => setTimeout(resolve, 5000));
          continue;
        }

        if (error instanceof ccxt.BaseError) {
          this.logger.error('Exchange API error in watchTickers:', error);
          await new Promise((resolve) => setTimeout(resolve, 5000));
          continue;
        }

        this.logger.error('Unknown error in watchTickers:', error);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }

    this.logger.info('watchTickers loop stopped (shutdown detected).');
  }

  public async close(): Promise<void> {
    await this.ccxtExchange.close();
    this.logger.info('Exchange connections closed.');
  }
}
