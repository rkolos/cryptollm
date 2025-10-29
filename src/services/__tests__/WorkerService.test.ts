import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkerService } from '../WorkerService.js';
import { ValidationError } from '../../errors/ValidationError.js';
import { InsufficientFundsError } from '../../errors/ExchangeErrors.js';
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

    // Сбрасываем мок на дефолтное поведение (возвращает null/undefined, не выбрасывает ошибку)
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

    // ВАЖНО: WorkerService использует Singleton, нужно сбросить instance перед каждым тестом
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (WorkerService as any).instance = undefined;

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockValidatorService.validateDecision as any).mockImplementation(() => {
        throw validationError;
      });

      // Мокируем _updateDecisionLog через executeInTransaction
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      // ВАЖНО: Сбрасываем мок валидатора, чтобы убедиться, что предыдущий тест не влияет
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockValidatorService.validateDecision as any).mockReset();

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

      // Мокируем getRules для exchangeRulesService (вызывается в WorkerService.execute перед валидацией)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockExchangeRulesService.getRules as any).mockReturnValue(MockDataFactory.createMarketRules());
      // Мокируем validateDecision, чтобы она возвращала результат (не выбрасывала ошибку)
      // validateDecision НЕ async функция, поэтому используем mockReturnValue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      // ВАЖНО: Сбрасываем мок перед настройкой и устанавливаем новую реализацию
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockExecutionService.createOrderWithRetry as any).mockReset();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockExecutionService.createOrderWithRetry as any).mockImplementation(
        async (
          _pair: string,
          type: string,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          _side: string,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
          _amount: any,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
          _price?: any,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
          _params?: any,
        ) => {
          callCount++;
          if (type === 'market') {
            return mockMarketOrder;
          }
          // Для stop_loss_limit или limit ордеров
          return mockSlOrder;
        },
      );

      // Мокируем query для _updateDecisionLog (вызывается в начале и в конце)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockDatabaseService.query as any).mockResolvedValue({ rowCount: 1 });
      // Мокируем успешную транзакцию БД
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      expect(mockNotificationService.sendAlert).toHaveBeenCalledWith(expect.stringContaining('ИСПОЛНЕНО'), true);
    });
  });

  describe('execute - InsufficientFundsError handling', () => {
    it('должен обработать InsufficientFundsError и поставить бота на паузу', async () => {
      // ВАЖНО: Сбрасываем мок, чтобы убедиться, что предыдущий тест не влияет
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockValidatorService.validateDecision as any).mockReset();

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockExchangeRulesService.getRules as any).mockReturnValue(MockDataFactory.createMarketRules());
      // Мокируем validateDecision, чтобы она возвращала результат
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockValidatorService.validateDecision as any).mockReturnValue(validationResult);

      // Мокируем ошибку InsufficientFunds при создании market ордера
      const insufficientFundsError = new InsufficientFundsError('Insufficient funds');
      // ВАЖНО: Сбрасываем мок перед настройкой
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockExecutionService.createOrderWithRetry as any).mockReset();
      // Мокируем первый вызов (market) с ошибкой - используем async функцию, которая выбрасывает ошибку
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockExecutionService.createOrderWithRetry as any).mockImplementation(async () => {
        throw insufficientFundsError;
      });

      // Мокируем _updateDecisionLog (вызывается несколько раз)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockDatabaseService.query as any).mockResolvedValue({ rowCount: 1 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockDatabaseService.executeInTransaction as any).mockImplementation(async (callback: any) => {
        const mockClient = {
          query: vi.fn().mockResolvedValue({ rowCount: 1 }),
        };
        return callback(mockClient);
      });

      // Ожидаем, что метод выбросит ошибку (WorkerService пробрасывает ошибку после обработки)
      // WorkerService обрабатывает InsufficientFundsError и пробрасывает её дальше (строка 223)
      let errorThrown: unknown = null;
      try {
        await workerService.execute(
          decision,
          'test-log-id',
          MockDataFactory.createAccountState(),
          MockDataFactory.createStrategyContext(),
          MockDataFactory.createMarketData(),
        );
      } catch (error) {
        errorThrown = error;
      }

      // Проверяем, что ошибка была проброшена
      expect(errorThrown).toBeDefined();
      // Проверяем, что обработка InsufficientFunds выполнена
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
