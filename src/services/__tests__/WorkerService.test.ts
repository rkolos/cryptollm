import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkerService } from '../WorkerService.js';
import { ValidationError } from '../../errors/ValidationError.js';
import { InsufficientFundsError } from '../../errors/ExchangeErrors.js';
import ccxt from 'ccxt';
import { MockDataFactory } from '../../__tests__/mocks/MockData.js';
import {
  createMockExchangeRulesService,
  createMockDatabaseService,
  createMockGuaranteedOrderExecutionService,
} from '../../__tests__/mocks/MockServices.js';
import type { ValidatorService } from '../ValidatorService.js';
import type { EventBusService } from '../EventBusService.js';
import type { NotificationService } from '../NotificationService.js';
import type { GlobalStateService } from '../GlobalStateService.js';
import type { AccountStateService } from '../AccountStateService.js';
import type { ConfigService } from '../ConfigService.js';

describe('WorkerService', () => {
  let workerService: WorkerService;
  let mockValidatorService: ValidatorService;
  let mockExecutionService: ReturnType<typeof createMockGuaranteedOrderExecutionService>;
  let mockDatabaseService: ReturnType<typeof createMockDatabaseService>;
  let mockEventBus: EventBusService;
  let mockNotificationService: NotificationService;
  let mockGlobalStateService: GlobalStateService;
  let mockAccountStateService: AccountStateService;
  let mockExchangeRulesService: ReturnType<typeof createMockExchangeRulesService>;
  let mockConfigService: ConfigService;

  beforeEach(() => {
    vi.clearAllMocks();

    mockValidatorService = {
      validateDecision: vi.fn(),
    } as unknown as ValidatorService;

    mockExecutionService = createMockGuaranteedOrderExecutionService();
    mockDatabaseService = createMockDatabaseService();
    mockExchangeRulesService = createMockExchangeRulesService();

    mockEventBus = {
      emitTradeExecuted: vi.fn(),
    } as unknown as EventBusService;

    mockNotificationService = {
      sendAlert: vi.fn(),
    } as unknown as NotificationService;

    mockGlobalStateService = {
      pause: vi.fn(),
      resume: vi.fn(),
      getIsPaused: vi.fn(() => false),
      getIsShuttingDown: vi.fn(() => false),
      isRunning: vi.fn(() => true),
    } as unknown as GlobalStateService;

    mockAccountStateService = {
      refreshNow: vi.fn(),
      getAccountState: vi.fn(() => MockDataFactory.createAccountState()),
    } as unknown as AccountStateService;

    mockConfigService = {} as unknown as ConfigService;

    workerService = WorkerService.getInstance(
      mockValidatorService,
      mockExecutionService,
      mockDatabaseService,
      mockEventBus,
      mockNotificationService,
      mockGlobalStateService,
      mockAccountStateService,
      mockExchangeRulesService,
      mockConfigService,
    );
  });

  describe('execute - Validation', () => {
    it('должен отклонить решение при ошибке валидации', async () => {
      const decision = MockDataFactory.createLLMDecision({
        action: 'OPEN_LONG',
      });

      const validationError = new ValidationError('Test validation error');
      (mockValidatorService.validateDecision as any).mockImplementation(() => {
        throw validationError;
      });

      // Мокируем _updateDecisionLog через executeInTransaction
      (mockDatabaseService.executeInTransaction as any).mockImplementation(async (callback: any) => {
        const mockClient = {
          query: vi.fn().mockResolvedValue({ rowCount: 1 }),
        };
        return callback(mockClient);
      });

      await workerService.execute(
        decision,
        'test-log-id',
        MockDataFactory.createAccountState(),
        MockDataFactory.createStrategyContext(),
        MockDataFactory.createMarketData(),
      );

      expect(mockNotificationService.sendAlert).toHaveBeenCalledWith(
        expect.stringContaining('РЕШЕНИЕ ОТКЛОНЕНО'),
        false,
      );
      expect(mockExecutionService.createOrderWithRetry).not.toHaveBeenCalled();
    });

    it('должен продолжить выполнение при успешной валидации', async () => {
      const decision = MockDataFactory.createLLMDecision({
        action: 'OPEN_LONG',
        parameters: {
          type: 'market',
          stop_loss_price: MockDataFactory.createDecimal(48000),
        },
      });

      const validationResult = {
        rawAmountCoin: MockDataFactory.createDecimal(0.1),
        rawAmountUsd: MockDataFactory.createDecimal(5000),
        roundedAmountCoin: MockDataFactory.createDecimal(0.1),
        roundedAmountUsd: MockDataFactory.createDecimal(5000),
        roundedEntryPrice: MockDataFactory.createDecimal(50000),
        usdAtRisk: MockDataFactory.createDecimal(100),
        entryPrice: MockDataFactory.createDecimal(50000),
      };

      // Мокируем getRules для exchangeRulesService
      (mockExchangeRulesService.getRules as any).mockReturnValue(MockDataFactory.createMarketRules());
      (mockValidatorService.validateDecision as any).mockReturnValue(validationResult);

      // Мокируем успешное создание ордера (вызывается несколько раз: market, SL, TP)
      const mockMarketOrder = {
        id: 'test-market-order-id',
        symbol: 'BTC/USDT',
        type: 'market',
        side: 'buy',
        amount: MockDataFactory.createDecimal(0.1),
        price: MockDataFactory.createDecimal(50000),
        status: 'closed',
        timestamp: Date.now(),
        filled: MockDataFactory.createDecimal(0.1),
        average: MockDataFactory.createDecimal(50000),
        cost: MockDataFactory.createDecimal(5000),
        fee: { cost: MockDataFactory.createDecimal(5), currency: 'USDT' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const mockSlOrder = {
        id: 'test-sl-order-id',
        symbol: 'BTC/USDT',
        type: 'stop_loss_limit',
        side: 'sell',
        amount: MockDataFactory.createDecimal(0.1),
        price: MockDataFactory.createDecimal(48000),
        stopPrice: MockDataFactory.createDecimal(48000),
        status: 'open',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      // Мокируем разные ответы для разных типов ордеров
      let callCount = 0;
      (mockExecutionService.createOrderWithRetry as any).mockImplementation(async (
        pair: string,
        type: string,
        side: string,
      ) => {
        callCount++;
        if (type === 'market') {
          return mockMarketOrder;
        }
        return mockSlOrder;
      });

      // Мокируем успешную транзакцию БД
      (mockDatabaseService.executeInTransaction as any).mockImplementation(async (callback: any) => {
        const mockClient = {
          query: vi.fn().mockResolvedValue({ rowCount: 1 }),
        };
        return callback(mockClient);
      });

      await workerService.execute(
        decision,
        'test-log-id',
        MockDataFactory.createAccountState(),
        MockDataFactory.createStrategyContext(),
        MockDataFactory.createMarketData(),
      );

      // Проверяем, что ордера были созданы (market + SL)
      expect(callCount).toBeGreaterThan(0); // Как минимум market ордер
      expect(mockEventBus.emitTradeExecuted).toHaveBeenCalledWith('BTC/USDT');
      expect(mockNotificationService.sendAlert).toHaveBeenCalledWith(
        expect.stringContaining('ИСПОЛНЕНО'),
        true,
      );
    });
  });

  describe('execute - InsufficientFundsError handling', () => {
    it('должен обработать InsufficientFundsError и поставить бота на паузу', async () => {
      const decision = MockDataFactory.createLLMDecision({
        action: 'OPEN_LONG',
        parameters: {
          type: 'market',
          stop_loss_price: MockDataFactory.createDecimal(48000),
        },
      });

      const validationResult = {
        rawAmountCoin: MockDataFactory.createDecimal(0.1),
        rawAmountUsd: MockDataFactory.createDecimal(5000),
        roundedAmountCoin: MockDataFactory.createDecimal(0.1),
        roundedAmountUsd: MockDataFactory.createDecimal(5000),
        roundedEntryPrice: MockDataFactory.createDecimal(50000),
        usdAtRisk: MockDataFactory.createDecimal(100),
        entryPrice: MockDataFactory.createDecimal(50000),
      };

      (mockValidatorService.validateDecision as any).mockReturnValue(validationResult);

      // Мокируем ошибку InsufficientFunds при создании market ордера
      const insufficientFundsError = new InsufficientFundsError('Insufficient funds');
      // Мокируем первый вызов (market) с ошибкой
      (mockExecutionService.createOrderWithRetry as any).mockRejectedValue(insufficientFundsError);

      // Мокируем _updateDecisionLog (вызывается несколько раз)
      (mockDatabaseService.query as any).mockResolvedValue({ rowCount: 1 });
      (mockDatabaseService.executeInTransaction as any).mockImplementation(async (callback: any) => {
        const mockClient = {
          query: vi.fn().mockResolvedValue({ rowCount: 1 }),
        };
        return callback(mockClient);
      });

      try {
        await workerService.execute(
          decision,
          'test-log-id',
          MockDataFactory.createAccountState(),
          MockDataFactory.createStrategyContext(),
          MockDataFactory.createMarketData(),
        );
        // Если не выбросило ошибку, тест должен упасть
        expect.fail('Ожидалась ошибка InsufficientFundsError');
      } catch (error) {
        // Ожидаем, что ошибка будет обработана и переброшена
        expect(error).toBeInstanceOf(InsufficientFundsError);
      }

      expect(mockGlobalStateService.pause).toHaveBeenCalled();
      expect(mockAccountStateService.refreshNow).toHaveBeenCalled();
      expect(mockNotificationService.sendAlert).toHaveBeenCalledWith(
        expect.stringContaining('НЕДОСТАТОЧНО СРЕДСТВ'),
        true,
      );
    });
  });

  describe('execute - HOLD action', () => {
    it('должен пропустить HOLD без валидации и исполнения', async () => {
      const decision = MockDataFactory.createLLMDecision({
        action: 'HOLD',
      });

      await workerService.execute(
        decision,
        'test-log-id',
        MockDataFactory.createAccountState(),
        MockDataFactory.createStrategyContext(),
        MockDataFactory.createMarketData(),
      );

      expect(mockValidatorService.validateDecision).not.toHaveBeenCalled();
      expect(mockExecutionService.createOrderWithRetry).not.toHaveBeenCalled();
    });
  });
});

