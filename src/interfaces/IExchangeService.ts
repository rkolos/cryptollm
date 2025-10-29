import Decimal from 'decimal.js';

type DecimalType = InstanceType<typeof Decimal>;

export interface IDecimalOHLCV {
  timestamp: number;
  open: DecimalType;
  high: DecimalType;
  low: DecimalType;
  close: DecimalType;
  volume: DecimalType;
}

export interface IDecimalTicker {
  symbol: string;
  last: DecimalType;
  bid: DecimalType;
  ask: DecimalType;
  baseVolume: DecimalType;
  quoteVolume: DecimalType;
  timestamp?: number;
}

export interface IDecimalOrderBook {
  symbol: string;
  bids: Array<[DecimalType, DecimalType]>;
  asks: Array<[DecimalType, DecimalType]>;
  timestamp?: number;
}

export interface IDecimalBalance {
  [currency: string]: {
    free: DecimalType;
    used: DecimalType;
    total: DecimalType;
  };
}

export interface IDecimalOrder {
  id: string;
  clientOrderId?: string;
  symbol: string;
  type: string;
  side: 'buy' | 'sell';
  amount: DecimalType;
  price?: DecimalType;
  status: string;
  filled?: DecimalType;
  remaining?: DecimalType;
  cost?: DecimalType;
  timestamp?: number;
}

export interface IDecimalTrade {
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
    amount: DecimalType,
    price?: DecimalType,
    params?: Record<string, unknown>,
  ): Promise<IDecimalOrder>;
  cancelOrder(orderId: string, symbol: string): Promise<void>;
  fetchOrder(orderId: string, symbol: string): Promise<IDecimalOrder>;
  fetchOpenOrders(symbol?: string): Promise<IDecimalOrder[]>;
  fetchMyTrades(symbol?: string, since?: number, limit?: number): Promise<IDecimalTrade[]>;
  watchTickers(symbols: string[], callback: (ticker: IDecimalTicker) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}
