import Decimal from 'decimal.js';

export interface IDecimalOHLCV {
  timestamp: number;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: Decimal;
}

export interface IDecimalTicker {
  symbol: string;
  last: Decimal;
  bid: Decimal;
  ask: Decimal;
  baseVolume: Decimal;
  quoteVolume: Decimal;
  timestamp?: number;
}

export interface IDecimalOrderBook {
  symbol: string;
  bids: Array<[Decimal, Decimal]>;
  asks: Array<[Decimal, Decimal]>;
  timestamp?: number;
}

export interface IDecimalBalance {
  [currency: string]: {
    free: Decimal;
    used: Decimal;
    total: Decimal;
  };
}

export interface IDecimalOrder {
  id: string;
  clientOrderId?: string;
  symbol: string;
  type: string;
  side: 'buy' | 'sell';
  amount: Decimal;
  price?: Decimal;
  status: string;
  filled?: Decimal;
  remaining?: Decimal;
  cost?: Decimal;
  timestamp?: number;
}

export interface IDecimalTrade {
  id: string;
  order: string;
  symbol: string;
  side: 'buy' | 'sell';
  amount: Decimal;
  price: Decimal;
  cost: Decimal;
  fee: {
    cost: Decimal;
    currency: string;
  };
  timestamp: number;
}

export interface IExchangeService {
  loadMarkets(): Promise<void>;
  fetchOHLCV(symbol: string, timeframe: string, since?: number, limit?: number): Promise<IDecimalOHLCV[]>;
  fetchTicker(symbol: string): Promise<IDecimalTicker>;
  fetchOrderBook(symbol: string, limit?: number): Promise<IDecimalOrderBook>;
  fetchBalance(): Promise<IDecimalBalance>;
  createOrder(
    symbol: string,
    type: string,
    side: 'buy' | 'sell',
    amount: Decimal,
    price?: Decimal,
    params?: Record<string, unknown>,
  ): Promise<IDecimalOrder>;
  cancelOrder(orderId: string, symbol: string): Promise<void>;
  fetchOrder(orderId: string, symbol: string): Promise<IDecimalOrder>;
  fetchOpenOrders(symbol?: string): Promise<IDecimalOrder[]>;
  fetchMyTrades(symbol?: string, since?: number, limit?: number): Promise<IDecimalTrade[]>;
  watchTickers(symbols: string[], callback: (ticker: IDecimalTicker) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}
