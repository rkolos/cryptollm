import Decimal from 'decimal.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const decimalInstance = new (Decimal as any)(0);
export type DecimalValue = typeof decimalInstance;

export interface IDecimalOHLCV {
  timestamp: number;
  open: DecimalValue;
  high: DecimalValue;
  low: DecimalValue;
  close: DecimalValue;
  volume: DecimalValue;
}

export interface IDecimalTicker {
  symbol: string;
  last: DecimalValue;
  bid: DecimalValue;
  ask: DecimalValue;
  baseVolume: DecimalValue;
  quoteVolume: DecimalValue;
  timestamp?: number;
}

export interface IDecimalOrderBook {
  symbol: string;
  bids: Array<[DecimalValue, DecimalValue]>;
  asks: Array<[DecimalValue, DecimalValue]>;
  timestamp?: number;
}

export interface IDecimalBalance {
  [currency: string]: {
    free: DecimalValue;
    used: DecimalValue;
    total: DecimalValue;
  };
}

export interface IDecimalOrder {
  id: string;
  clientOrderId?: string;
  symbol: string;
  type: string;
  side: 'buy' | 'sell';
  amount: DecimalValue;
  price?: DecimalValue;
  status: string;
  filled?: DecimalValue;
  remaining?: DecimalValue;
  cost?: DecimalValue;
  timestamp?: number;
}

export interface IDecimalTrade {
  id: string;
  order: string;
  symbol: string;
  side: 'buy' | 'sell';
  amount: DecimalValue;
  price: DecimalValue;
  cost: DecimalValue;
  fee: {
    cost: DecimalValue;
    currency: string;
  };
  timestamp: number;
}

export interface IExchangeService {
  loadMarkets(): Promise<void>;
  getRawMarkets(): Record<string, unknown>;
  fetchOHLCV(symbol: string, timeframe: string, since?: number, limit?: number): Promise<IDecimalOHLCV[]>;
  fetchTicker(symbol: string): Promise<IDecimalTicker>;
  fetchOrderBook(symbol: string, limit?: number): Promise<IDecimalOrderBook>;
  fetchBalance(): Promise<IDecimalBalance>;
  createOrder(
    symbol: string,
    type: string,
    side: 'buy' | 'sell',
    amount: DecimalValue,
    price?: DecimalValue,
    params?: Record<string, unknown>,
  ): Promise<IDecimalOrder>;
  cancelOrder(orderId: string, symbol: string): Promise<void>;
  fetchOrder(orderId: string, symbol: string): Promise<IDecimalOrder>;
  fetchOpenOrders(symbol?: string): Promise<IDecimalOrder[]>;
  fetchMyTrades(symbol?: string, since?: number, limit?: number): Promise<IDecimalTrade[]>;
  watchTickers(symbols: string[], callback: (ticker: IDecimalTicker) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}
