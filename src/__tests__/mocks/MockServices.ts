import { vi } from 'vitest';
import Decimal from 'decimal.js';
import type { ExchangeRulesService } from '../../services/ExchangeRulesService.js';
import type { DatabaseService } from '../../services/DatabaseService.js';
import type { GuaranteedOrderExecutionService } from '../../services/GuaranteedOrderExecutionService.js';
import type { IExchangeService, IDecimalOrder, DecimalValue } from '../../interfaces/IExchangeService.js';
import type { IMarketRules } from '../../interfaces/IMarketRules.js';
import { MockDataFactory } from './MockData.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DecimalConstructor = Decimal as any;

/**
 * Мок для ExchangeRulesService
 */
export function createMockExchangeRulesService(): ExchangeRulesService {
  const mockService = {
    getRules: vi.fn(() => MockDataFactory.createMarketRules()),
  } as unknown as ExchangeRulesService;

  return mockService;
}

/**
 * Мок для DatabaseService
 */
export function createMockDatabaseService(): DatabaseService {
  const mockService = {
    query: vi.fn(),
    executeInTransaction: vi.fn(async (callback: (client: any) => Promise<any>) => {
      const mockClient = {
        query: vi.fn(),
      };
      return callback(mockClient);
    }),
    closePool: vi.fn(),
  } as unknown as DatabaseService;

  return mockService;
}

/**
 * Мок для GuaranteedOrderExecutionService
 */
export function createMockGuaranteedOrderExecutionService(): GuaranteedOrderExecutionService {
  const mockOrder: IDecimalOrder = {
    id: 'test-order-id',
    symbol: 'BTC/USDT',
    type: 'market',
    side: 'buy',
    amount: MockDataFactory.createDecimal(0.1),
    price: MockDataFactory.createDecimal(50000),
    status: 'closed',
    timestamp: Date.now(),
    filled: MockDataFactory.createDecimal(0.1),
    cost: MockDataFactory.createDecimal(5000),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const mockService = {
    initialize: vi.fn(),
    createOrderWithRetry: vi.fn(() => Promise.resolve(mockOrder)),
    cancelOrderWithRetry: vi.fn(() => Promise.resolve()),
  } as unknown as GuaranteedOrderExecutionService;

  return mockService;
}

/**
 * Мок для IExchangeService
 */
export function createMockExchangeService(): IExchangeService {
  const mockBalance = {
    USDT: {
      free: MockDataFactory.createDecimal(9000),
      used: MockDataFactory.createDecimal(1000),
      total: MockDataFactory.createDecimal(10000),
    },
  };

  const mockService = {
    fetchBalance: vi.fn(() => Promise.resolve(mockBalance)),
    fetchTicker: vi.fn(),
    fetchOHLCV: vi.fn(),
    fetchOrderBook: vi.fn(),
    createOrder: vi.fn(),
    cancelOrder: vi.fn(),
    fetchOrder: vi.fn(),
    fetchOpenOrders: vi.fn(),
    fetchMyTrades: vi.fn(),
    watchTickers: vi.fn(),
    close: vi.fn(),
    getRawMarkets: vi.fn(),
  } as unknown as IExchangeService;

  return mockService;
}

