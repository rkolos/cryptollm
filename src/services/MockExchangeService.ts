import Decimal from 'decimal.js';
import { randomUUID } from 'crypto';
import { ConfigService } from './ConfigService.js';
import { LoggingService } from './LoggingService.js';
import { ExchangeRulesService } from './ExchangeRulesService.js';
import type { IExchangeService, DecimalValue } from '../interfaces/IExchangeService.js';
import type {
  IDecimalOHLCV,
  IDecimalTicker,
  IDecimalOrderBook,
  IDecimalBalance,
  IDecimalOrder,
  IDecimalTrade,
} from '../interfaces/IExchangeService.js';
import { InsufficientFundsError, OrderNotFoundError } from '../errors/ExchangeErrors.js';
import type winston from 'winston';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DecimalConstructor = Decimal as any;
type DecimalType = DecimalValue;

interface MockBalance {
  total: DecimalType;
  available: DecimalType;
}

interface MockOrder {
  id: string;
  clientOrderId?: string;
  symbol: string;
  type: string;
  side: 'buy' | 'sell';
  amount: DecimalType;
  price?: DecimalType;
  status: string;
  timestamp: number;
}

interface MockTrade {
  id: string;
  order: string;
  symbol: string;
  side: 'buy' | 'sell';
  amount: DecimalType;
  price: DecimalType;
  cost: DecimalType;
  fee: {
    cost: DecimalType;
    currency: string;
  };
  timestamp: number;
}

export class MockExchangeService implements IExchangeService {
  private readonly balances: Map<string, MockBalance> = new Map();
  private readonly openOrders: Map<string, MockOrder> = new Map();
  private readonly tradeHistory: MockTrade[] = [];
  private readonly currentPrices: Map<string, DecimalType> = new Map();
  private readonly markets: Record<string, unknown> = {};
  private readonly logger: winston.Logger;
  private readonly configService: ConfigService;
  private readonly exchangeRulesService: ExchangeRulesService;

  constructor(configService: ConfigService, exchangeRulesService: ExchangeRulesService) {
    this.configService = configService;
    this.exchangeRulesService = exchangeRulesService;
    this.logger = LoggingService.getInstance().getLogger('MockExchange');

    const initialUsdt = this.configService.getDryRunInitialBalance();
    this.balances.set('USDT', {
      total: new DecimalConstructor(initialUsdt),
      available: new DecimalConstructor(initialUsdt),
    });

    this.logger.warn(
      `MockExchangeService initialized. Using in-memory simulation. Initial USDT balance: ${initialUsdt}`,
    );
  }

  public setMockPrice(pair: string, price: number | DecimalType): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const priceDecimal = (price as any).e !== undefined ? price : new DecimalConstructor(price);
    this.currentPrices.set(pair, priceDecimal);
    this.logger.debug(`Mock price set for ${pair}: ${priceDecimal.toString()}`);
  }

  private amountToPrecision(pair: string, amount: DecimalType): DecimalType {
    const rules = this.exchangeRulesService.getRules(pair);
    const precision = rules.precision.amount;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const precisionDecimal = precision as any;
    const multiplier = new DecimalConstructor(10).pow(precisionDecimal.e || 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const amountDecimal = amount as any;
    const rounded = amountDecimal.mul(multiplier).floor().div(multiplier);
    return rounded as DecimalType;
  }

  private priceToPrecision(pair: string, price: DecimalType): DecimalType {
    const rules = this.exchangeRulesService.getRules(pair);
    const precision = rules.precision.price;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const precisionDecimal = precision as any;
    const multiplier = new DecimalConstructor(10).pow(precisionDecimal.e || 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const priceDecimal = price as any;
    const rounded = priceDecimal.mul(multiplier).floor().div(multiplier);
    return rounded as DecimalType;
  }

  private lockFunds(currency: string, amount: DecimalType): void {
    const balance = this.balances.get(currency);
    if (!balance) {
      throw new InsufficientFundsError(`Currency ${currency} not found in balance`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const availableDecimal = balance.available as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const amountDecimal = amount as any;
    if (availableDecimal.lt(amountDecimal)) {
      throw new InsufficientFundsError(
        `Insufficient ${currency} available: ${availableDecimal}, required: ${amountDecimal}`,
      );
    }
    balance.available = availableDecimal.sub(amountDecimal) as DecimalType;
  }

  private unlockFunds(currency: string, amount: DecimalType): void {
    const balance = this.balances.get(currency);
    if (!balance) {
      throw new Error(`Currency ${currency} not found in balance`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const availableDecimal = balance.available as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const amountDecimal = amount as any;
    balance.available = availableDecimal.add(amountDecimal) as DecimalType;
  }

  public async loadMarkets(): Promise<void> {
    const watchlist = this.configService.getWatchlist();
    for (const pair of watchlist) {
      const rules = this.exchangeRulesService.getRules(pair);
      this.markets[pair] = {
        id: pair,
        symbol: pair,
        precision: {
          amount: rules.precision.amount.toNumber(),
          price: rules.precision.price.toNumber(),
        },
        limits: {
          cost: {
            min: rules.minNotional.toNumber(),
          },
        },
        fees: {
          taker: rules.takerFee.toNumber(),
        },
      };
    }
    this.logger.info('Mock markets loaded.');
  }

  public getRawMarkets(): Record<string, unknown> {
    return this.markets;
  }

  public async fetchOHLCV(symbol: string, timeframe: string, since?: number, limit?: number): Promise<IDecimalOHLCV[]> {
    this.logger.debug(`Mock fetchOHLCV: ${symbol}, ${timeframe}`);
    const currentPrice = this.currentPrices.get(symbol) || (new DecimalConstructor(30000) as DecimalType);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentPriceDecimal = currentPrice as any;
    return [
      {
        timestamp: Date.now(),
        open: currentPrice,
        high: currentPriceDecimal.mul(1.01) as DecimalType,
        low: currentPriceDecimal.mul(0.99) as DecimalType,
        close: currentPrice,
        volume: new DecimalConstructor(100) as DecimalType,
      },
    ];
  }

  public async fetchTicker(symbol: string): Promise<IDecimalTicker> {
    const currentPrice = this.currentPrices.get(symbol) || (new DecimalConstructor(30000) as DecimalType);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentPriceDecimal = currentPrice as any;
    return {
      symbol,
      last: currentPrice,
      bid: currentPriceDecimal.mul(0.9999) as DecimalType,
      ask: currentPriceDecimal.mul(1.0001) as DecimalType,
      baseVolume: new DecimalConstructor(1000) as DecimalType,
      quoteVolume: new DecimalConstructor(30000000) as DecimalType,
      timestamp: Date.now(),
    };
  }

  public async fetchOrderBook(symbol: string, limit?: number): Promise<IDecimalOrderBook> {
    const currentPrice = this.currentPrices.get(symbol) || (new DecimalConstructor(30000) as DecimalType);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentPriceDecimal = currentPrice as any;
    return {
      symbol,
      bids: [[currentPriceDecimal.mul(0.999) as DecimalType, new DecimalConstructor(1) as DecimalType]],
      asks: [[currentPriceDecimal.mul(1.001) as DecimalType, new DecimalConstructor(1) as DecimalType]],
      timestamp: Date.now(),
    };
  }

  public async fetchBalance(): Promise<IDecimalBalance> {
    const result: IDecimalBalance = {};
    for (const [currency, balance] of this.balances.entries()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const totalDecimal = balance.total as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const availableDecimal = balance.available as any;
      result[currency] = {
        free: balance.available,
        used: totalDecimal.sub(availableDecimal) as DecimalType,
        total: balance.total,
      };
    }
    return result;
  }

  public async createOrder(
    symbol: string,
    type: string,
    side: 'buy' | 'sell',
    amount: DecimalValue,
    price?: DecimalValue,
    params?: Record<string, unknown>,
  ): Promise<IDecimalOrder> {
    const rules = this.exchangeRulesService.getRules(symbol);
    const roundedAmount = this.amountToPrecision(symbol, amount as DecimalType);
    const orderPrice = price ? this.priceToPrecision(symbol, price as DecimalType) : undefined;

    let executionPrice: DecimalType;
    if (type === 'market') {
      const currentPrice = this.currentPrices.get(symbol) || new DecimalConstructor(30000);
      executionPrice = currentPrice;
    } else if (orderPrice) {
      executionPrice = orderPrice;
    } else {
      throw new Error('Price is required for limit orders');
    }

    const cost = roundedAmount.mul(executionPrice);

    if (cost.lt(rules.minNotional)) {
      throw new Error(`Order cost ${cost} is less than minNotional ${rules.minNotional}`);
    }

    const parts = symbol.split('/');
    const baseCurrency = parts[0];
    const quoteCurrency = parts[1];
    if (!baseCurrency || !quoteCurrency) {
      throw new Error(`Invalid symbol format: ${symbol}`);
    }
    const requiredCurrency = side === 'buy' ? quoteCurrency : baseCurrency;
    const requiredAmount = side === 'buy' ? cost : roundedAmount;

    const balance = this.balances.get(requiredCurrency);
    if (!balance || balance.available.lt(requiredAmount)) {
      throw new InsufficientFundsError(
        `Insufficient ${requiredCurrency} available: ${balance?.available || 0}, required: ${requiredAmount}`,
      );
    }

    const orderId = randomUUID();
    const timestamp = Date.now();

    if (type === 'market') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const costDecimal = cost as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const takerFeeDecimal = rules.takerFee as any;
      const fee = costDecimal.mul(takerFeeDecimal) as DecimalType;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const feeDecimal = fee as any;
      const netCost = (side === 'buy' ? costDecimal.add(feeDecimal) : costDecimal.sub(feeDecimal)) as DecimalType;

      if (side === 'buy') {
        this.lockFunds(quoteCurrency, netCost);
        const quoteBalance = this.balances.get(quoteCurrency)!;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const quoteTotalDecimal = quoteBalance.total as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const quoteAvailableDecimal = quoteBalance.available as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const netCostDecimal = netCost as any;
        quoteBalance.total = quoteTotalDecimal.sub(netCostDecimal) as DecimalType;
        quoteBalance.available = quoteAvailableDecimal.sub(netCostDecimal) as DecimalType;

        const baseBalance = this.balances.get(baseCurrency as string) || {
          total: new DecimalConstructor(0) as DecimalType,
          available: new DecimalConstructor(0) as DecimalType,
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const baseTotalDecimal = baseBalance.total as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const baseAvailableDecimal = baseBalance.available as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const roundedAmountDecimal = roundedAmount as any;
        baseBalance.total = baseTotalDecimal.add(roundedAmountDecimal) as DecimalType;
        baseBalance.available = baseAvailableDecimal.add(roundedAmountDecimal) as DecimalType;
        this.balances.set(baseCurrency as string, baseBalance);
      } else {
        this.lockFunds(baseCurrency as string, roundedAmount);
        const baseBalance = this.balances.get(baseCurrency as string)!;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const baseTotalDecimal = baseBalance.total as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const baseAvailableDecimal = baseBalance.available as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const roundedAmountDecimal = roundedAmount as any;
        baseBalance.total = baseTotalDecimal.sub(roundedAmountDecimal) as DecimalType;
        baseBalance.available = baseAvailableDecimal.sub(roundedAmountDecimal) as DecimalType;

        const quoteBalance = this.balances.get(quoteCurrency as string) || {
          total: new DecimalConstructor(0) as DecimalType,
          available: new DecimalConstructor(0) as DecimalType,
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const quoteTotalDecimal = quoteBalance.total as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const quoteAvailableDecimal = quoteBalance.available as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const netCostDecimal = netCost as any;
        quoteBalance.total = quoteTotalDecimal.add(netCostDecimal) as DecimalType;
        quoteBalance.available = quoteAvailableDecimal.add(netCostDecimal) as DecimalType;
        this.balances.set(quoteCurrency as string, quoteBalance);
      }

      const trade: MockTrade = {
        id: randomUUID(),
        order: orderId,
        symbol,
        side,
        amount: roundedAmount,
        price: executionPrice,
        cost,
        fee: {
          cost: fee as DecimalType,
          currency: quoteCurrency as string,
        },
        timestamp,
      };

      this.tradeHistory.push(trade);

      return {
        id: orderId,
        clientOrderId: params?.clientOrderId as string | undefined,
        symbol,
        type,
        side,
        amount: roundedAmount,
        price: executionPrice,
        status: 'closed',
        filled: roundedAmount,
        remaining: new DecimalConstructor(0),
        cost,
        timestamp,
      };
    } else {
      this.lockFunds(requiredCurrency, requiredAmount);

      const order: MockOrder = {
        id: orderId,
        clientOrderId: params?.clientOrderId as string | undefined,
        symbol,
        type,
        side,
        amount: roundedAmount,
        price: orderPrice,
        status: 'open',
        timestamp,
      };

      this.openOrders.set(orderId, order);

      return {
        id: orderId,
        clientOrderId: params?.clientOrderId as string | undefined,
        symbol,
        type,
        side,
        amount: roundedAmount,
        price: orderPrice,
        status: 'open',
        filled: new DecimalConstructor(0),
        remaining: roundedAmount,
        cost: cost,
        timestamp,
      };
    }
  }

  public async cancelOrder(orderId: string, symbol: string): Promise<void> {
    const order = this.openOrders.get(orderId);
    if (!order) {
      throw new OrderNotFoundError(`Order ${orderId} not found`);
    }

    if (order.status !== 'open') {
      return;
    }

    const [baseCurrency, quoteCurrency] = symbol.split('/');
    const requiredCurrency = order.side === 'buy' ? quoteCurrency : baseCurrency;
    const requiredAmount = order.side === 'buy' ? order.amount.mul(order.price || 0) : order.amount;

    this.unlockFunds(requiredCurrency as string, requiredAmount);
    this.openOrders.delete(orderId);

    this.logger.info(`Mock order ${orderId} cancelled.`);
  }

  public async fetchOrder(orderId: string, symbol: string): Promise<IDecimalOrder> {
    const order = this.openOrders.get(orderId);
    if (!order) {
      const trade = this.tradeHistory.find((t) => t.order === orderId);
      if (trade) {
        return {
          id: orderId,
          symbol: trade.symbol,
          type: 'market',
          side: trade.side,
          amount: trade.amount,
          price: trade.price,
          status: 'closed',
          filled: trade.amount,
          remaining: new DecimalConstructor(0),
          cost: trade.cost,
          timestamp: trade.timestamp,
        };
      }
      throw new OrderNotFoundError(`Order ${orderId} not found`);
    }

    return {
      id: order.id,
      clientOrderId: order.clientOrderId || undefined,
      symbol: order.symbol,
      type: order.type,
      side: order.side,
      amount: order.amount,
      price: order.price,
      status: order.status,
      filled: new DecimalConstructor(0) as DecimalType,
      remaining: order.amount,
      timestamp: order.timestamp,
    };
  }

  public async fetchOpenOrders(symbol?: string): Promise<IDecimalOrder[]> {
    const orders: IDecimalOrder[] = [];
    for (const order of this.openOrders.values()) {
      if (!symbol || order.symbol === symbol) {
        orders.push({
          id: order.id,
          clientOrderId: order.clientOrderId,
          symbol: order.symbol,
          type: order.type,
          side: order.side,
          amount: order.amount,
          price: order.price,
          status: order.status,
          filled: new DecimalConstructor(0),
          remaining: order.amount,
          timestamp: order.timestamp,
        });
      }
    }
    return orders;
  }

  public async fetchMyTrades(symbol?: string, since?: number, limit?: number): Promise<IDecimalTrade[]> {
    let trades = this.tradeHistory;
    if (symbol) {
      trades = trades.filter((t) => t.symbol === symbol);
    }
    if (since) {
      trades = trades.filter((t) => t.timestamp >= since);
    }
    if (limit) {
      trades = trades.slice(-limit);
    }
    return trades.map((trade) => ({
      id: trade.id,
      order: trade.order,
      symbol: trade.symbol,
      side: trade.side,
      amount: trade.amount,
      price: trade.price,
      cost: trade.cost,
      fee: trade.fee,
      timestamp: trade.timestamp,
    }));
  }

  public async watchTickers(symbols: string[], callback: (ticker: IDecimalTicker) => Promise<void>): Promise<void> {
    this.logger.warn('MockExchangeService.watchTickers() called. This is a stub method and does nothing.');
  }

  public async close(): Promise<void> {
    this.logger.info('MockExchangeService closed.');
  }
}
