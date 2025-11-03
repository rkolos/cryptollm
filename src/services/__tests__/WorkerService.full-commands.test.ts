import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkerService } from '../WorkerService.js';
import { MockDataFactory } from '../../__tests__/mocks/MockData.js';
import {
  createMockExchangeRulesService,
  createMockDatabaseService,
  createMockGuaranteedOrderExecutionService,
  createMockExchangeService,
} from '../../__tests__/mocks/MockServices.js';
import type { ValidatorService } from '../ValidatorService.js';
import type { EventBusService } from '../EventBusService.js';
import type { NotificationService } from '../NotificationService.js';
import type { GlobalStateService } from '../GlobalStateService.js';
import type { AccountStateService } from '../AccountStateService.js';
import type { ConfigService } from '../ConfigService.js';
import type { LLMDecision } from '../../interfaces/ILLMTypes.js';
import type { PoolClient } from 'pg';

describe('WorkerService - Полные тесты всех команд модели', () => {
  let workerService: WorkerService;
  let mockValidatorService: ValidatorService;
  let mockExecutionService: ReturnType<typeof createMockGuaranteedOrderExecutionService>;
  let mockDatabaseService: ReturnType<typeof createMockDatabaseService>;
  let mockEventBus: EventBusService;
  let mockNotificationService: NotificationService;
  let mockGlobalStateService: GlobalStateService;
  let mockAccountStateService: AccountStateService;
  let mockExchangeRulesService: ReturnType<typeof createMockExchangeRulesService>;
  let mockExchangeService: ReturnType<typeof createMockExchangeService>;
  let mockConfigService: ConfigService;

  // Вспомогательная функция для создания мокового клиента транзакции
  const createMockTransactionClient = (): PoolClient => {
    return {
      query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
    } as unknown as PoolClient;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockValidatorService = {
      validateDecision: vi.fn(),
    } as unknown as ValidatorService;

    mockExecutionService = createMockGuaranteedOrderExecutionService();
    mockDatabaseService = createMockDatabaseService();
    mockExchangeRulesService = createMockExchangeRulesService();
    mockExchangeService = createMockExchangeService();

    mockEventBus = {
      emitTradeExecuted: vi.fn(),
    } as unknown as EventBusService;

    mockNotificationService = {
      sendAlert: vi.fn(),
      sendTradingSummary: vi.fn(),
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

    // Сбрасываем singleton instance
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
      mockExchangeService,
      mockConfigService,
    );

    // Настраиваем базовые моки для БД
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDatabaseService.query as any).mockResolvedValue({ rowCount: 1, rows: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDatabaseService.executeInTransaction as any).mockImplementation(async (callback: any) => {
      const mockClient = createMockTransactionClient();
      return callback(mockClient);
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockExchangeRulesService.getRules as any).mockReturnValue(MockDataFactory.createMarketRules());
  });

  describe('OPEN_LONG (Market) - Полный цикл покупки', () => {
    it('должен успешно открыть LONG позицию через market ордер с SL и TP', async () => {
      const decision: LLMDecision = MockDataFactory.createLLMDecision({
        action: 'OPEN_LONG',
        parameters: {
          type: 'market',
          stop_loss_price: MockDataFactory.createDecimal(48000),
          take_profit_price: MockDataFactory.createDecimal(52000),
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockValidatorService.validateDecision as any).mockReturnValue(validationResult);

      // Мокируем ордера на бирже
      const mockMarketOrder = {
        id: 'market-order-123',
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
        id: 'sl-order-123',
        symbol: 'BTC/USDT',
        type: 'stop_loss_limit',
        side: 'sell',
        amount: MockDataFactory.createDecimal(0.1),
        price: MockDataFactory.createDecimal(48000),
        stopPrice: MockDataFactory.createDecimal(48000),
        status: 'open',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const mockTpOrder = {
        id: 'tp-order-123',
        symbol: 'BTC/USDT',
        type: 'limit',
        side: 'sell',
        amount: MockDataFactory.createDecimal(0.1),
        price: MockDataFactory.createDecimal(52000),
        status: 'open',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      let callCount = 0;
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
          } else if (type === 'stop_loss_limit') {
            return mockSlOrder;
          } else {
            return mockTpOrder;
          }
        },
      );

      // Мокируем транзакцию БД
      const mockClient = createMockTransactionClient();
      let dbCallCount = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockClient.query as any).mockImplementation(async (query: string) => {
        dbCallCount++;
        // Проверяем правильность SQL запросов
        if (query.includes('INSERT INTO ActivePositions')) {
          expect(query).toContain('pair');
          expect(query).toContain('side');
          expect(query).toContain('amount');
          expect(query).toContain('average_entry_price');
        } else if (query.includes('INSERT INTO TradeHistory')) {
          expect(query).toContain('exchange_trade_id');
          expect(query).toContain('side');
          expect(query).toContain('price');
        } else if (query.includes('INSERT INTO ActiveOrders')) {
          expect(query).toContain('exchange_order_id');
        }
        return { rowCount: 1, rows: [] };
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockDatabaseService.executeInTransaction as any).mockImplementation(async (callback: any) => {
        return callback(mockClient);
      });

      await workerService.execute(
        decision,
        'test-log-id',
        MockDataFactory.createAccountState(),
        MockDataFactory.createStrategyContext(),
        MockDataFactory.createMarketData(),
      );

      // Проверяем, что валидация была вызвана
      expect(mockValidatorService.validateDecision).toHaveBeenCalled();

      // Проверяем, что были созданы все ордера (market + SL + TP)
      expect(callCount).toBe(3);

      // Проверяем, что были вызваны правильные методы создания ордеров
      expect(mockExecutionService.createOrderWithRetry).toHaveBeenCalledWith(
        'BTC/USDT',
        'market',
        'buy',
        validationResult.roundedAmountCoin,
      );
      expect(mockExecutionService.createOrderWithRetry).toHaveBeenCalledWith(
        'BTC/USDT',
        'stop_loss_limit',
        'sell',
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ stopPrice: 48000 }),
      );
      expect(mockExecutionService.createOrderWithRetry).toHaveBeenCalledWith(
        'BTC/USDT',
        'limit',
        'sell',
        expect.anything(),
        expect.anything(),
      );

      // Проверяем, что баланс был обновлен
      expect(mockAccountStateService.refreshNow).toHaveBeenCalled();

      // Проверяем, что событие было отправлено
      expect(mockEventBus.emitTradeExecuted).toHaveBeenCalledWith('BTC/USDT');

      // Проверяем, что уведомление было отправлено
      expect(mockNotificationService.sendTradingSummary).toHaveBeenCalledWith(
        'OPEN_LONG',
        'BTC/USDT',
        expect.any(String),
      );

      // Проверяем, что БД операции были выполнены
      expect(dbCallCount).toBeGreaterThan(0);
    });

    it('должен успешно открыть LONG позицию с TSL', async () => {
      const decision: LLMDecision = MockDataFactory.createLLMDecision({
        action: 'OPEN_LONG',
        parameters: {
          type: 'market',
          stop_loss_price: MockDataFactory.createDecimal(48000),
          trailing_stop_config: {
            type: 'percentage',
            distance: 2,
          },
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockValidatorService.validateDecision as any).mockReturnValue(validationResult);

      const mockMarketOrder = {
        id: 'market-order-123',
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
        id: 'sl-order-123',
        symbol: 'BTC/USDT',
        type: 'stop_loss_limit',
        side: 'sell',
        amount: MockDataFactory.createDecimal(0.1),
        price: MockDataFactory.createDecimal(48000),
        stopPrice: MockDataFactory.createDecimal(48000),
        status: 'open',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

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
          if (type === 'market') {
            return mockMarketOrder;
          }
          return mockSlOrder;
        },
      );

      const mockClient = createMockTransactionClient();
      let tslInserted = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockClient.query as any).mockImplementation(async (query: string) => {
        if (query.includes('INSERT INTO TSL_State') || (query.includes('TSL_State') && query.includes('ON CONFLICT'))) {
          tslInserted = true;
          expect(query).toContain('rule_config_json');
        }
        return { rowCount: 1, rows: [] };
      });

      // Мокируем executeInTransaction для этого теста
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockDatabaseService.executeInTransaction as any).mockImplementation(async (callback: any) => {
        return callback(mockClient);
      });

      await workerService.execute(
        decision,
        'test-log-id',
        MockDataFactory.createAccountState(),
        MockDataFactory.createStrategyContext(),
        MockDataFactory.createMarketData(),
      );

      expect(tslInserted).toBe(true);
      expect(mockEventBus.emitTradeExecuted).toHaveBeenCalledWith('BTC/USDT');
    });
  });

  describe('OPEN_SHORT (Market) - Полный цикл продажи', () => {
    it('должен успешно открыть SHORT позицию через market ордер с SL и TP', async () => {
      const decision: LLMDecision = MockDataFactory.createLLMDecision({
        action: 'OPEN_SHORT',
        pair: 'BTC/USDT',
        parameters: {
          type: 'market',
          stop_loss_price: MockDataFactory.createDecimal(52000),
          take_profit_price: MockDataFactory.createDecimal(48000),
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockValidatorService.validateDecision as any).mockReturnValue(validationResult);

      const mockMarketOrder = {
        id: 'market-order-short-123',
        symbol: 'BTC/USDT',
        type: 'market',
        side: 'sell',
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
        id: 'sl-order-short-123',
        symbol: 'BTC/USDT',
        type: 'stop_loss_limit',
        side: 'buy',
        amount: MockDataFactory.createDecimal(0.1),
        price: MockDataFactory.createDecimal(52000),
        stopPrice: MockDataFactory.createDecimal(52000),
        status: 'open',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const mockTpOrder = {
        id: 'tp-order-short-123',
        symbol: 'BTC/USDT',
        type: 'limit',
        side: 'buy',
        amount: MockDataFactory.createDecimal(0.1),
        price: MockDataFactory.createDecimal(48000),
        status: 'open',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

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
          if (type === 'market') {
            return mockMarketOrder;
          } else if (type === 'stop_loss_limit') {
            return mockSlOrder;
          } else {
            return mockTpOrder;
          }
        },
      );

      await workerService.execute(
        decision,
        'test-log-id',
        MockDataFactory.createAccountState(),
        MockDataFactory.createStrategyContext(),
        MockDataFactory.createMarketData(),
      );

      // Проверяем, что был создан market ордер на продажу
      expect(mockExecutionService.createOrderWithRetry).toHaveBeenCalledWith(
        'BTC/USDT',
        'market',
        'sell',
        validationResult.roundedAmountCoin,
      );

      // Проверяем, что SL ордер создан на покупку (противоположная сторона)
      expect(mockExecutionService.createOrderWithRetry).toHaveBeenCalledWith(
        'BTC/USDT',
        'stop_loss_limit',
        'buy',
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ stopPrice: 52000 }),
      );

      // Проверяем, что TP ордер создан на покупку
      expect(mockExecutionService.createOrderWithRetry).toHaveBeenCalledWith(
        'BTC/USDT',
        'limit',
        'buy',
        expect.anything(),
        expect.anything(),
      );

      expect(mockEventBus.emitTradeExecuted).toHaveBeenCalledWith('BTC/USDT');
      expect(mockNotificationService.sendTradingSummary).toHaveBeenCalledWith(
        'OPEN_SHORT',
        'BTC/USDT',
        expect.any(String),
      );
    });
  });

  describe('OPEN_LONG (Limit) - Отложенная покупка', () => {
    it('должен успешно создать limit ордер на открытие LONG позиции', async () => {
      const decision: LLMDecision = MockDataFactory.createLLMDecision({
        action: 'OPEN_LONG',
        parameters: {
          type: 'limit',
          price: MockDataFactory.createDecimal(49000),
          stop_loss_price: MockDataFactory.createDecimal(48000),
          take_profit_price: MockDataFactory.createDecimal(52000),
        },
      });

      const validationResult = {
        rawAmountCoin: MockDataFactory.createDecimal(0.1),
        rawAmountUsd: MockDataFactory.createDecimal(4900),
        roundedAmountCoin: MockDataFactory.createDecimal(0.1),
        roundedAmountUsd: MockDataFactory.createDecimal(4900),
        roundedEntryPrice: MockDataFactory.createDecimal(49000),
        usdAtRisk: MockDataFactory.createDecimal(100),
        entryPrice: MockDataFactory.createDecimal(49000),
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockValidatorService.validateDecision as any).mockReturnValue(validationResult);

      const mockLimitOrder = {
        id: 'limit-order-123',
        symbol: 'BTC/USDT',
        type: 'limit',
        side: 'buy',
        amount: MockDataFactory.createDecimal(0.1),
        price: MockDataFactory.createDecimal(49000),
        status: 'open',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockExecutionService.createOrderWithRetry as any).mockResolvedValue(mockLimitOrder);

      const mockClient = createMockTransactionClient();
      let limitOrderInserted = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockClient.query as any).mockImplementation(async (query: string) => {
        if (query.includes('INSERT INTO ActiveOrders')) {
          // Проверяем наличие target полей в запросе
          if (query.includes('target_stop_loss_price') || query.includes('target_take_profit_price')) {
            limitOrderInserted = true;
          }
        }
        return { rowCount: 1, rows: [] };
      });

      // Мокируем executeInTransaction для этого теста
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockDatabaseService.executeInTransaction as any).mockImplementation(async (callback: any) => {
        return callback(mockClient);
      });

      await workerService.execute(
        decision,
        'test-log-id',
        MockDataFactory.createAccountState(),
        MockDataFactory.createStrategyContext(),
        MockDataFactory.createMarketData(),
      );

      // Проверяем, что был создан limit ордер
      expect(mockExecutionService.createOrderWithRetry).toHaveBeenCalledWith(
        'BTC/USDT',
        'limit',
        'buy',
        validationResult.roundedAmountCoin,
        expect.anything(),
      );

      // Проверяем, что limit ордер сохранен в БД с target полями
      expect(limitOrderInserted).toBe(true);

      expect(mockEventBus.emitTradeExecuted).toHaveBeenCalledWith('BTC/USDT');
    });
  });

  describe('CLOSE_POSITION (Market) - Полное закрытие', () => {
    it('должен успешно закрыть LONG позицию полностью через market ордер', async () => {
      const decision: LLMDecision = MockDataFactory.createLLMDecision({
        action: 'CLOSE_POSITION',
        parameters: {
          type: 'market',
          amount_percent: MockDataFactory.createDecimal(100),
        },
      });

      const validationResult = {
        rawAmountCoin: MockDataFactory.createDecimal(0.1),
        rawAmountUsd: MockDataFactory.createDecimal(5000),
        roundedAmountCoin: MockDataFactory.createDecimal(0.1),
        roundedAmountUsd: MockDataFactory.createDecimal(5000),
        roundedEntryPrice: MockDataFactory.createDecimal(50000),
        usdAtRisk: MockDataFactory.createDecimal(0),
        entryPrice: MockDataFactory.createDecimal(50000),
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockValidatorService.validateDecision as any).mockReturnValue(validationResult);

      const mockCloseOrder = {
        id: 'close-order-123',
        symbol: 'BTC/USDT',
        type: 'market',
        side: 'sell',
        amount: MockDataFactory.createDecimal(0.1),
        price: MockDataFactory.createDecimal(51000),
        status: 'closed',
        timestamp: Date.now(),
        filled: MockDataFactory.createDecimal(0.1),
        average: MockDataFactory.createDecimal(51000),
        cost: MockDataFactory.createDecimal(5100),
        fee: { cost: MockDataFactory.createDecimal(5.1), currency: 'USDT' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockExecutionService.createOrderWithRetry as any).mockResolvedValue(mockCloseOrder);

      const mockClient = createMockTransactionClient();
      let positionDeleted = false;
      let ordersDeleted = false;
      let historyInserted = false;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockClient.query as any).mockImplementation(async (query: string) => {
        if (query.includes('SELECT') && query.includes('ActivePositions') && query.includes('FOR UPDATE')) {
          // Возвращаем существующую позицию
          return {
            rowCount: 1,
            rows: [
              {
                amount: 0.1,
                side: 'long',
                average_entry_price: 50000,
                total_fee_cost: 5,
              },
            ],
          };
        } else if (query.includes('DELETE FROM ActivePositions')) {
          positionDeleted = true;
          return { rowCount: 1, rows: [] };
        } else if (query.includes('DELETE FROM ActiveOrders')) {
          ordersDeleted = true;
          return { rowCount: 1, rows: [] };
        } else if (query.includes('INSERT INTO TradeHistory')) {
          historyInserted = true;
          expect(query).toContain('realized_pnl_usd');
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 1, rows: [] };
      });

      // Мокируем executeInTransaction для этого теста
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockDatabaseService.executeInTransaction as any).mockImplementation(async (callback: any) => {
        return callback(mockClient);
      });

      await workerService.execute(
        decision,
        'test-log-id',
        MockDataFactory.createAccountState({
          open_positions: [MockDataFactory.createOpenPosition()],
        }),
        MockDataFactory.createStrategyContext(),
        MockDataFactory.createMarketData(),
      );

      // Проверяем, что был создан market ордер на закрытие (продажа для LONG)
      expect(mockExecutionService.createOrderWithRetry).toHaveBeenCalledWith(
        'BTC/USDT',
        'market',
        'sell',
        expect.anything(),
      );

      // Проверяем, что позиция была удалена из БД
      expect(positionDeleted).toBe(true);
      expect(ordersDeleted).toBe(true);
      expect(historyInserted).toBe(true);

      expect(mockEventBus.emitTradeExecuted).toHaveBeenCalledWith('BTC/USDT');
      expect(mockNotificationService.sendTradingSummary).toHaveBeenCalledWith(
        'CLOSE_POSITION',
        'BTC/USDT',
        expect.any(String),
      );
    });

    it('должен успешно закрыть SHORT позицию полностью через market ордер', async () => {
      const decision: LLMDecision = MockDataFactory.createLLMDecision({
        action: 'CLOSE_POSITION',
        parameters: {
          type: 'market',
          amount_percent: MockDataFactory.createDecimal(100),
        },
      });

      const validationResult = {
        rawAmountCoin: MockDataFactory.createDecimal(0.1),
        rawAmountUsd: MockDataFactory.createDecimal(5000),
        roundedAmountCoin: MockDataFactory.createDecimal(0.1),
        roundedAmountUsd: MockDataFactory.createDecimal(5000),
        roundedEntryPrice: MockDataFactory.createDecimal(50000),
        usdAtRisk: MockDataFactory.createDecimal(0),
        entryPrice: MockDataFactory.createDecimal(50000),
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockValidatorService.validateDecision as any).mockReturnValue(validationResult);

      const mockCloseOrder = {
        id: 'close-order-short-123',
        symbol: 'BTC/USDT',
        type: 'market',
        side: 'buy',
        amount: MockDataFactory.createDecimal(0.1),
        price: MockDataFactory.createDecimal(49000),
        status: 'closed',
        timestamp: Date.now(),
        filled: MockDataFactory.createDecimal(0.1),
        average: MockDataFactory.createDecimal(49000),
        cost: MockDataFactory.createDecimal(4900),
        fee: { cost: MockDataFactory.createDecimal(4.9), currency: 'USDT' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockExecutionService.createOrderWithRetry as any).mockResolvedValue(mockCloseOrder);

      const mockClient = createMockTransactionClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockClient.query as any).mockImplementation(async (query: string) => {
        if (query.includes('SELECT') && query.includes('ActivePositions') && query.includes('FOR UPDATE')) {
          return {
            rowCount: 1,
            rows: [
              {
                amount: 0.1,
                side: 'short',
                average_entry_price: 50000,
                total_fee_cost: 5,
              },
            ],
          };
        }
        return { rowCount: 1, rows: [] };
      });

      // Мокируем executeInTransaction для этого теста
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockDatabaseService.executeInTransaction as any).mockImplementation(async (callback: any) => {
        return callback(mockClient);
      });

      await workerService.execute(
        decision,
        'test-log-id',
        MockDataFactory.createAccountState({
          open_positions: [MockDataFactory.createOpenPosition({ side: 'short' })],
        }),
        MockDataFactory.createStrategyContext(),
        MockDataFactory.createMarketData(),
      );

      // Проверяем, что был создан market ордер на закрытие (покупка для SHORT)
      expect(mockExecutionService.createOrderWithRetry).toHaveBeenCalledWith(
        'BTC/USDT',
        'market',
        'buy',
        expect.anything(),
      );
    });
  });

  describe('CLOSE_POSITION (Market) - Частичное закрытие', () => {
    it('должен успешно закрыть 50% LONG позиции', async () => {
      const decision: LLMDecision = MockDataFactory.createLLMDecision({
        action: 'CLOSE_POSITION',
        parameters: {
          type: 'market',
          amount_percent: MockDataFactory.createDecimal(50),
        },
      });

      const validationResult = {
        rawAmountCoin: MockDataFactory.createDecimal(0.05),
        rawAmountUsd: MockDataFactory.createDecimal(2500),
        roundedAmountCoin: MockDataFactory.createDecimal(0.05),
        roundedAmountUsd: MockDataFactory.createDecimal(2500),
        roundedEntryPrice: MockDataFactory.createDecimal(50000),
        usdAtRisk: MockDataFactory.createDecimal(0),
        entryPrice: MockDataFactory.createDecimal(50000),
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockValidatorService.validateDecision as any).mockReturnValue(validationResult);

      const mockCloseOrder = {
        id: 'close-order-partial-123',
        symbol: 'BTC/USDT',
        type: 'market',
        side: 'sell',
        amount: MockDataFactory.createDecimal(0.05),
        price: MockDataFactory.createDecimal(51000),
        status: 'closed',
        timestamp: Date.now(),
        filled: MockDataFactory.createDecimal(0.05),
        average: MockDataFactory.createDecimal(51000),
        cost: MockDataFactory.createDecimal(2550),
        fee: { cost: MockDataFactory.createDecimal(2.55), currency: 'USDT' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockExecutionService.createOrderWithRetry as any).mockResolvedValue(mockCloseOrder);

      const mockClient = createMockTransactionClient();
      let positionUpdated = false;
      let ordersUpdated = false;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockClient.query as any).mockImplementation(async (query: string) => {
        if (query.includes('SELECT') && query.includes('ActivePositions') && query.includes('FOR UPDATE')) {
          return {
            rowCount: 1,
            rows: [
              {
                amount: 0.1,
                side: 'long',
                average_entry_price: 50000,
                total_fee_cost: 5,
              },
            ],
          };
        } else if (query.includes('UPDATE ActivePositions')) {
          positionUpdated = true;
          expect(query).toContain('amount');
          expect(query).toContain('total_fee_cost');
          return { rowCount: 1, rows: [] };
        } else if (query.includes('UPDATE ActiveOrders') && query.includes('amount')) {
          ordersUpdated = true;
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 1, rows: [] };
      });

      // Мокируем executeInTransaction для этого теста
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockDatabaseService.executeInTransaction as any).mockImplementation(async (callback: any) => {
        return callback(mockClient);
      });

      await workerService.execute(
        decision,
        'test-log-id',
        MockDataFactory.createAccountState({
          open_positions: [MockDataFactory.createOpenPosition()],
        }),
        MockDataFactory.createStrategyContext(),
        MockDataFactory.createMarketData(),
      );

      expect(positionUpdated).toBe(true);
      expect(ordersUpdated).toBe(true);
      expect(mockEventBus.emitTradeExecuted).toHaveBeenCalledWith('BTC/USDT');
    });
  });

  describe('CLOSE_POSITION (Limit) - Отложенное закрытие', () => {
    it('должен успешно создать limit ордер на закрытие позиции', async () => {
      const decision: LLMDecision = MockDataFactory.createLLMDecision({
        action: 'CLOSE_POSITION',
        parameters: {
          type: 'limit',
          price: MockDataFactory.createDecimal(52000),
        },
      });

      const validationResult = {
        rawAmountCoin: MockDataFactory.createDecimal(0.1),
        rawAmountUsd: MockDataFactory.createDecimal(5200),
        roundedAmountCoin: MockDataFactory.createDecimal(0.1),
        roundedAmountUsd: MockDataFactory.createDecimal(5200),
        roundedEntryPrice: MockDataFactory.createDecimal(52000),
        usdAtRisk: MockDataFactory.createDecimal(0),
        entryPrice: MockDataFactory.createDecimal(52000),
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockValidatorService.validateDecision as any).mockReturnValue(validationResult);

      const mockLimitCloseOrder = {
        id: 'limit-close-order-123',
        symbol: 'BTC/USDT',
        type: 'limit',
        side: 'sell',
        amount: MockDataFactory.createDecimal(0.1),
        price: MockDataFactory.createDecimal(52000),
        status: 'open',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockExecutionService.createOrderWithRetry as any).mockResolvedValue(mockLimitCloseOrder);

      const mockClient = createMockTransactionClient();
      let limitCloseInserted = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockClient.query as any).mockImplementation(async (query: string, params?: any[]) => {
        if (query.includes('SELECT') && query.includes('ActivePositions') && query.includes('FOR UPDATE')) {
          return {
            rowCount: 1,
            rows: [
              {
                amount: 0.1,
                side: 'long',
              },
            ],
          };
        } else if (query.includes('INSERT INTO ActiveOrders')) {
          // Проверяем наличие limit_close в запросе или в параметрах
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (query.includes('limit_close') || (params && (params as any[]).includes('limit_close'))) {
            limitCloseInserted = true;
          }
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 1, rows: [] };
      });

      // Мокируем executeInTransaction для этого теста
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockDatabaseService.executeInTransaction as any).mockImplementation(async (callback: any) => {
        return callback(mockClient);
      });

      await workerService.execute(
        decision,
        'test-log-id',
        MockDataFactory.createAccountState({
          open_positions: [MockDataFactory.createOpenPosition()],
        }),
        MockDataFactory.createStrategyContext(),
        MockDataFactory.createMarketData(),
      );

      expect(mockExecutionService.createOrderWithRetry).toHaveBeenCalledWith(
        'BTC/USDT',
        'limit',
        'sell',
        expect.anything(),
        expect.anything(),
      );

      expect(limitCloseInserted).toBe(true);
      expect(mockEventBus.emitTradeExecuted).toHaveBeenCalledWith('BTC/USDT');
    });
  });

  describe('MODIFY_POSITION - Изменение SL/TP', () => {
    it('должен успешно изменить SL и TP позиции', async () => {
      const decision: LLMDecision = MockDataFactory.createLLMDecision({
        action: 'MODIFY_POSITION',
        parameters: {
          new_stop_loss_price: MockDataFactory.createDecimal(47000),
          new_take_profit_price: MockDataFactory.createDecimal(53000),
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockValidatorService.validateDecision as any).mockReturnValue(validationResult);

      const mockNewSlOrder = {
        id: 'new-sl-order-123',
        symbol: 'BTC/USDT',
        type: 'stop_loss_limit',
        side: 'sell',
        amount: MockDataFactory.createDecimal(0.1),
        price: MockDataFactory.createDecimal(47000),
        stopPrice: MockDataFactory.createDecimal(47000),
        status: 'open',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const mockNewTpOrder = {
        id: 'new-tp-order-123',
        symbol: 'BTC/USDT',
        type: 'limit',
        side: 'sell',
        amount: MockDataFactory.createDecimal(0.1),
        price: MockDataFactory.createDecimal(53000),
        status: 'open',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      let cancelCallCount = 0;
      let createCallCount = 0;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockExecutionService.cancelOrderWithRetry as any).mockImplementation(async () => {
        cancelCallCount++;
      });

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
          createCallCount++;
          if (type === 'stop_loss_limit') {
            return mockNewSlOrder;
          }
          return mockNewTpOrder;
        },
      );

      // Мокируем запросы к БД
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockDatabaseService.query as any).mockImplementation(async (query: string) => {
        if (query.includes('SELECT') && query.includes('ActivePositions')) {
          return {
            rowCount: 1,
            rows: [
              {
                side: 'long',
                amount: 0.1,
                current_sl_id: 'old-sl-order-123',
                current_tp_id: 'old-tp-order-123',
                current_tsl_sl_id: null,
              },
            ],
          };
        } else if (query.includes('SELECT') && query.includes('ActiveOrders') && query.includes('price')) {
          return {
            rowCount: 1,
            rows: [
              {
                price: 48000,
                amount: 0.1,
              },
            ],
          };
        }
        return { rowCount: 1, rows: [] };
      });

      const mockClient = createMockTransactionClient();
      let slUpdated = false;
      let tpInserted = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockClient.query as any).mockImplementation(async (query: string, params?: any[]) => {
        if (query.includes('UPDATE ActivePositions') && query.includes('stop_loss_price')) {
          slUpdated = true;
          return { rowCount: 1, rows: [] };
        } else if (query.includes('INSERT INTO ActiveOrders')) {
          // Проверяем наличие take_profit_limit в запросе или в параметрах
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (query.includes('take_profit_limit') || (params && (params as any[]).includes('take_profit_limit'))) {
            tpInserted = true;
          }
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 1, rows: [] };
      });

      // Мокируем executeInTransaction для этого теста
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockDatabaseService.executeInTransaction as any).mockImplementation(async (callback: any) => {
        return callback(mockClient);
      });

      await workerService.execute(
        decision,
        'test-log-id',
        MockDataFactory.createAccountState({
          open_positions: [MockDataFactory.createOpenPosition()],
        }),
        MockDataFactory.createStrategyContext(),
        MockDataFactory.createMarketData(),
      );

      // Проверяем, что старые ордера были отменены
      expect(cancelCallCount).toBe(2); // SL + TP

      // Проверяем, что новые ордера были созданы
      expect(createCallCount).toBe(2); // SL + TP

      // Проверяем, что БД была обновлена
      expect(slUpdated).toBe(true);
      expect(tpInserted).toBe(true);

      expect(mockEventBus.emitTradeExecuted).toHaveBeenCalledWith('BTC/USDT');
      expect(mockNotificationService.sendAlert).toHaveBeenCalledWith(expect.stringContaining('MODIFY_POSITION'), false);
    });

    it('должен успешно изменить SL с включением TSL', async () => {
      const decision: LLMDecision = MockDataFactory.createLLMDecision({
        action: 'MODIFY_POSITION',
        parameters: {
          new_stop_loss_price: MockDataFactory.createDecimal(47000),
          new_trailing_stop_config: {
            type: 'percentage',
            distance: 2,
          },
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockValidatorService.validateDecision as any).mockReturnValue(validationResult);

      const mockNewSlOrder = {
        id: 'new-sl-order-tsl-123',
        symbol: 'BTC/USDT',
        type: 'stop_loss_limit',
        side: 'sell',
        amount: MockDataFactory.createDecimal(0.1),
        price: MockDataFactory.createDecimal(47000),
        stopPrice: MockDataFactory.createDecimal(47000),
        status: 'open',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockExecutionService.cancelOrderWithRetry as any).mockResolvedValue(undefined);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockExecutionService.createOrderWithRetry as any).mockResolvedValue(mockNewSlOrder);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockDatabaseService.query as any).mockImplementation(async (query: string) => {
        if (query.includes('SELECT') && query.includes('ActivePositions')) {
          return {
            rowCount: 1,
            rows: [
              {
                side: 'long',
                amount: 0.1,
                current_sl_id: 'old-sl-order-123',
                current_tp_id: null,
                current_tsl_sl_id: null,
              },
            ],
          };
        } else if (query.includes('SELECT') && query.includes('ActiveOrders') && query.includes('price')) {
          return {
            rowCount: 1,
            rows: [
              {
                price: 48000,
                amount: 0.1,
              },
            ],
          };
        }
        return { rowCount: 1, rows: [] };
      });

      const mockClient = createMockTransactionClient();
      let tslInserted = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockClient.query as any).mockImplementation(async (query: string) => {
        if (query.includes('TSL_State') && (query.includes('INSERT') || query.includes('ON CONFLICT'))) {
          tslInserted = true;
          expect(query).toContain('rule_config_json');
        }
        return { rowCount: 1, rows: [] };
      });

      // Мокируем executeInTransaction для этого теста
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockDatabaseService.executeInTransaction as any).mockImplementation(async (callback: any) => {
        return callback(mockClient);
      });

      await workerService.execute(
        decision,
        'test-log-id',
        MockDataFactory.createAccountState({
          open_positions: [MockDataFactory.createOpenPosition()],
        }),
        MockDataFactory.createStrategyContext(),
        MockDataFactory.createMarketData(),
      );

      expect(tslInserted).toBe(true);
      expect(mockEventBus.emitTradeExecuted).toHaveBeenCalledWith('BTC/USDT');
    });
  });

  describe('CANCEL_ORDERS - Отмена ордеров', () => {
    it('должен успешно отменить конкретный ордер', async () => {
      const decision: LLMDecision = MockDataFactory.createLLMDecision({
        action: 'CANCEL_ORDERS',
        parameters: {
          order_id: 'order-to-cancel-123',
        },
      });

      const validationResult = {
        rawAmountCoin: MockDataFactory.createDecimal(0),
        rawAmountUsd: MockDataFactory.createDecimal(0),
        roundedAmountCoin: MockDataFactory.createDecimal(0),
        roundedAmountUsd: MockDataFactory.createDecimal(0),
        roundedEntryPrice: MockDataFactory.createDecimal(50000),
        usdAtRisk: MockDataFactory.createDecimal(0),
        entryPrice: MockDataFactory.createDecimal(50000),
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockValidatorService.validateDecision as any).mockReturnValue(validationResult);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockExecutionService.cancelOrderWithRetry as any).mockResolvedValue(undefined);

      const mockClient = createMockTransactionClient();
      let orderDeleted = false;
      let tslDeleted = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockClient.query as any).mockImplementation(async (query: string) => {
        if (query.includes('DELETE FROM ActiveOrders') && query.includes('exchange_order_id')) {
          orderDeleted = true;
          return { rowCount: 1, rows: [] };
        } else if (query.includes('DELETE FROM TSL_State') && query.includes('current_stop_order_id')) {
          tslDeleted = true;
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 1, rows: [] };
      });

      // Мокируем executeInTransaction для этого теста
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockDatabaseService.executeInTransaction as any).mockImplementation(async (callback: any) => {
        return callback(mockClient);
      });

      await workerService.execute(
        decision,
        'test-log-id',
        MockDataFactory.createAccountState(),
        MockDataFactory.createStrategyContext(),
        MockDataFactory.createMarketData(),
      );

      // Проверяем, что ордер был отменен на бирже
      expect(mockExecutionService.cancelOrderWithRetry).toHaveBeenCalledWith('order-to-cancel-123', 'BTC/USDT');

      // Проверяем, что ордер был удален из БД
      expect(orderDeleted).toBe(true);
      expect(tslDeleted).toBe(true);

      expect(mockEventBus.emitTradeExecuted).toHaveBeenCalledWith('BTC/USDT');
      expect(mockNotificationService.sendAlert).toHaveBeenCalledWith(expect.stringContaining('CANCEL_ORDERS'), false);
    });

    it('должен успешно отменить все ордера по паре', async () => {
      const decision: LLMDecision = MockDataFactory.createLLMDecision({
        action: 'CANCEL_ORDERS',
        parameters: {},
      });

      const validationResult = {
        rawAmountCoin: MockDataFactory.createDecimal(0),
        rawAmountUsd: MockDataFactory.createDecimal(0),
        roundedAmountCoin: MockDataFactory.createDecimal(0),
        roundedAmountUsd: MockDataFactory.createDecimal(0),
        roundedEntryPrice: MockDataFactory.createDecimal(50000),
        usdAtRisk: MockDataFactory.createDecimal(0),
        entryPrice: MockDataFactory.createDecimal(50000),
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockValidatorService.validateDecision as any).mockReturnValue(validationResult);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockExecutionService.cancelOrderWithRetry as any).mockResolvedValue(undefined);

      // Мокируем запрос для получения всех ордеров
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockDatabaseService.query as any).mockImplementation(async (query: string) => {
        if (query.includes('SELECT') && query.includes('exchange_order_id') && query.includes('ActiveOrders')) {
          return {
            rowCount: 2,
            rows: [{ exchange_order_id: 'order-1' }, { exchange_order_id: 'order-2' }],
          };
        }
        return { rowCount: 1, rows: [] };
      });

      const mockClient = createMockTransactionClient();
      let allOrdersDeleted = false;
      let allTslDeleted = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockClient.query as any).mockImplementation(async (query: string) => {
        if (query.includes('DELETE FROM ActiveOrders') && query.includes('pair')) {
          allOrdersDeleted = true;
          return { rowCount: 2, rows: [] };
        } else if (query.includes('DELETE FROM TSL_State') && query.includes('pair')) {
          allTslDeleted = true;
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 1, rows: [] };
      });

      // Мокируем executeInTransaction для этого теста
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockDatabaseService.executeInTransaction as any).mockImplementation(async (callback: any) => {
        return callback(mockClient);
      });

      await workerService.execute(
        decision,
        'test-log-id',
        MockDataFactory.createAccountState(),
        MockDataFactory.createStrategyContext(),
        MockDataFactory.createMarketData(),
      );

      // Проверяем, что все ордера были отменены на бирже
      expect(mockExecutionService.cancelOrderWithRetry).toHaveBeenCalledTimes(2);

      // Проверяем, что все ордера были удалены из БД
      expect(allOrdersDeleted).toBe(true);
      expect(allTslDeleted).toBe(true);

      expect(mockEventBus.emitTradeExecuted).toHaveBeenCalledWith('BTC/USDT');
    });
  });

  describe('HOLD - Бездействие', () => {
    it('должен пропустить HOLD без валидации и исполнения', async () => {
      const decision: LLMDecision = MockDataFactory.createLLMDecision({
        action: 'HOLD',
      });

      await workerService.execute(
        decision,
        'test-log-id',
        MockDataFactory.createAccountState(),
        MockDataFactory.createStrategyContext(),
        MockDataFactory.createMarketData(),
      );

      // Проверяем, что валидация не была вызвана
      expect(mockValidatorService.validateDecision).not.toHaveBeenCalled();

      // Проверяем, что ордера не были созданы
      expect(mockExecutionService.createOrderWithRetry).not.toHaveBeenCalled();

      // Проверяем, что событие было отправлено
      expect(mockEventBus.emitTradeExecuted).toHaveBeenCalledWith('BTC/USDT');

      // Проверяем, что уведомление было отправлено
      expect(mockNotificationService.sendAlert).toHaveBeenCalledWith(expect.stringContaining('HOLD'), false);
    });
  });
});
