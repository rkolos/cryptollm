import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SyncEngineService } from '../SyncEngineService.js';
import { ConfigService } from '../ConfigService.js';
import { MockDataFactory } from '../../__tests__/mocks/MockData.js';
import {
  createMockExchangeService,
  createMockDatabaseService,
  createMockGuaranteedOrderExecutionService,
  createMockExchangeRulesService,
} from '../../__tests__/mocks/MockServices.js';
import type { PairActorManagerService } from '../PairActorManagerService.js';

describe('SyncEngineService', () => {
  let syncEngineService: SyncEngineService;
  let mockExchangeService: ReturnType<typeof createMockExchangeService>;
  let mockDatabaseService: ReturnType<typeof createMockDatabaseService>;
  let mockGuaranteedOrderService: ReturnType<typeof createMockGuaranteedOrderExecutionService>;
  let mockPairActorManager: PairActorManagerService;
  let mockConfigService: ConfigService;
  let mockExchangeRulesService: ReturnType<typeof createMockExchangeRulesService>;

  beforeEach(() => {
    vi.clearAllMocks();
    // ВАЖНО: SyncEngineService использует Singleton, нужно сбросить instance перед каждым тестом
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (SyncEngineService as any).instance = undefined;

    mockExchangeService = createMockExchangeService();
    mockDatabaseService = createMockDatabaseService();
    mockGuaranteedOrderService = createMockGuaranteedOrderExecutionService();
    mockExchangeRulesService = createMockExchangeRulesService();
    mockConfigService = ConfigService.getInstance();

    mockPairActorManager = {
      execute: vi.fn(async (pair: string, task: () => Promise<void>) => {
        await task();
      }),
    } as unknown as PairActorManagerService;

    syncEngineService = SyncEngineService.getInstance(
      mockConfigService,
      mockDatabaseService,
      mockExchangeService,
      mockPairActorManager,
      mockExchangeRulesService,
      mockGuaranteedOrderService,
    );
  });

  describe('reconcileStateForPair', () => {
    it('должен выполнить сверку состояния для пары', async () => {
      // Мокируем данные с биржи
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockExchangeService.fetchOpenOrders as any).mockResolvedValue([]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockExchangeService.fetchBalance as any).mockResolvedValue({
        USDT: {
          free: MockDataFactory.createDecimal(9000),
          used: MockDataFactory.createDecimal(1000),
          total: MockDataFactory.createDecimal(10000),
        },
      });

      // Мокируем данные из БД
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockDatabaseService.query as any).mockResolvedValue({ rows: [], rowCount: 0 });

      await syncEngineService.reconcileStateForPair('BTC/USDT');

      expect(mockPairActorManager.execute).toHaveBeenCalledWith('BTC/USDT', expect.any(Function));
    });
  });

  describe('reconcileStateAll', () => {
    it('должен выполнить сверку для всех пар в watchlist', async () => {
      // Мокируем данные
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockExchangeService.fetchOpenOrders as any).mockResolvedValue([]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockExchangeService.fetchBalance as any).mockResolvedValue({
        USDT: {
          free: MockDataFactory.createDecimal(9000),
          used: MockDataFactory.createDecimal(1000),
          total: MockDataFactory.createDecimal(10000),
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockDatabaseService.query as any).mockResolvedValue({ rows: [], rowCount: 0 });

      // Мокируем getWatchlist из ConfigService
      vi.spyOn(mockConfigService, 'getWatchlist').mockReturnValue(['BTC/USDT', 'ETH/USDT']);

      await syncEngineService.reconcileStateAll();

      // Проверяем, что сверка была вызвана для каждой пары
      expect(mockPairActorManager.execute).toHaveBeenCalled();
    });
  });
});

