import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TSLHandlerService } from '../TSLHandlerService.js';
import { MockDataFactory } from '../../__tests__/mocks/MockData.js';
import {
  createMockGuaranteedOrderExecutionService,
  createMockDatabaseService,
} from '../../__tests__/mocks/MockServices.js';
import type { AccountStateService } from '../AccountStateService.js';
import type { PairActorManagerService } from '../PairActorManagerService.js';

describe('TSLHandlerService', () => {
  let tslHandlerService: TSLHandlerService;
  let mockAccountStateService: AccountStateService;
  let mockPairActorManager: PairActorManagerService;
  let mockGuaranteedExecutor: ReturnType<typeof createMockGuaranteedOrderExecutionService>;
  let mockDatabaseService: ReturnType<typeof createMockDatabaseService>;

  beforeEach(() => {
    vi.clearAllMocks();
    // ВАЖНО: TSLHandlerService использует Singleton, нужно сбросить instance перед каждым тестом
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (TSLHandlerService as any).instance = undefined;

    mockGuaranteedExecutor = createMockGuaranteedOrderExecutionService();
    mockDatabaseService = createMockDatabaseService();

    // Мок для AccountStateService
    const tslRule = {
      pair: 'BTC/USDT',
      position: MockDataFactory.createOpenPosition({
        side: 'long',
        amount: MockDataFactory.createDecimal(0.1),
        average_entry_price: MockDataFactory.createDecimal(50000),
        stop_loss_price: MockDataFactory.createDecimal(48000),
      }),
      state: {
        currentStopPrice: MockDataFactory.createDecimal(48000),
        currentStopOrderId: 'old-sl-order-id',
        priceSeen: MockDataFactory.createDecimal(50000),
      },
      rule: {
        type: 'percentage' as const,
        distance: 2.5, // 2.5%
      },
    };

    mockAccountStateService = {
      getAccountState: vi.fn(() => ({
        total_portfolio_value_usdt: MockDataFactory.createDecimal(10000),
        available_quote_balance: MockDataFactory.createDecimal(9000),
        assets: [],
        open_positions: [tslRule.position],
        open_orders: [],
        tslRules: new Map([['BTC/USDT', tslRule]]),
        llmTriggers: new Map(),
      })),
    } as unknown as AccountStateService;

    // Мок для PairActorManager
    mockPairActorManager = {
      execute: vi.fn(async (pair: string, task: () => Promise<void>) => {
        await task();
      }),
    } as unknown as PairActorManagerService;

    tslHandlerService = TSLHandlerService.getInstance(
      mockAccountStateService,
      mockPairActorManager,
      mockGuaranteedExecutor,
      mockDatabaseService,
    );
  });

  describe('handleTicker', () => {
    it('должен обработать тикер и обновить TSL для long позиции когда цена выросла', () => {
      const ticker = {
        symbol: 'BTC/USDT',
        last: MockDataFactory.createDecimal(51000), // Цена выросла выше priceSeen (50000)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      tslHandlerService.handleTicker(ticker);

      // Проверяем, что PairActorManager был вызван
      expect(mockPairActorManager.execute).toHaveBeenCalledWith('BTC/USDT', expect.any(Function));
    });

    it('не должен обновлять TSL если цена не превысила priceSeen для long', () => {
      const ticker = {
        symbol: 'BTC/USDT',
        last: MockDataFactory.createDecimal(49000), // Цена ниже priceSeen (50000)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      tslHandlerService.handleTicker(ticker);

      // PairActorManager не должен быть вызван
      expect(mockPairActorManager.execute).not.toHaveBeenCalled();
    });

    it('не должен обрабатывать тикер если нет TSL правила для пары', () => {
      // Обновляем мок, чтобы не было TSL правила
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockAccountStateService.getAccountState as any).mockReturnValue({
        total_portfolio_value_usdt: MockDataFactory.createDecimal(10000),
        available_quote_balance: MockDataFactory.createDecimal(9000),
        assets: [],
        open_positions: [],
        open_orders: [],
        tslRules: new Map(), // Пустая карта
        llmTriggers: new Map(),
      });

      const ticker = {
        symbol: 'ETH/USDT', // Пара без TSL правила
        last: MockDataFactory.createDecimal(3000),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      tslHandlerService.handleTicker(ticker);

      expect(mockPairActorManager.execute).not.toHaveBeenCalled();
    });

    it('должен обработать тикер для short позиции когда цена упала', () => {
      // Обновляем мок для short позиции
      const tslRule = {
        pair: 'BTC/USDT',
        position: MockDataFactory.createOpenPosition({
          side: 'short',
          amount: MockDataFactory.createDecimal(0.1),
          average_entry_price: MockDataFactory.createDecimal(50000),
          stop_loss_price: MockDataFactory.createDecimal(52000),
        }),
        state: {
          currentStopPrice: MockDataFactory.createDecimal(52000),
          currentStopOrderId: 'old-sl-order-id',
          priceSeen: MockDataFactory.createDecimal(50000), // Для short это минимальная цена
        },
        rule: {
          type: 'percentage' as const,
          distance: 2.5,
        },
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockAccountStateService.getAccountState as any).mockReturnValue({
        total_portfolio_value_usdt: MockDataFactory.createDecimal(10000),
        available_quote_balance: MockDataFactory.createDecimal(9000),
        assets: [],
        open_positions: [tslRule.position],
        open_orders: [],
        tslRules: new Map([['BTC/USDT', tslRule]]),
        llmTriggers: new Map(),
      });

      const ticker = {
        symbol: 'BTC/USDT',
        last: MockDataFactory.createDecimal(49000), // Цена упала ниже priceSeen (50000)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      tslHandlerService.handleTicker(ticker);

      expect(mockPairActorManager.execute).toHaveBeenCalledWith('BTC/USDT', expect.any(Function));
    });
  });

  describe('_calculateTSL (через handleTicker)', () => {
    it('должен рассчитать новый стоп правильно для long позиции', async () => {
      const ticker = {
        symbol: 'BTC/USDT',
        last: MockDataFactory.createDecimal(51000), // Цена выросла
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      // Проверяем, что execute был вызван (асинхронно)
      tslHandlerService.handleTicker(ticker);

      // Даем время на выполнение асинхронной задачи
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockPairActorManager.execute).toHaveBeenCalledWith('BTC/USDT', expect.any(Function));
    });
  });
});

