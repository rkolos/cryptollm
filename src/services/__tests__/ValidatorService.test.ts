import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ValidatorService } from '../ValidatorService.js';
import { ValidationError } from '../../errors/ValidationError.js';
import { MockDataFactory } from '../../__tests__/mocks/MockData.js';
import { createMockExchangeRulesService } from '../../__tests__/mocks/MockServices.js';

describe('ValidatorService', () => {
  let validatorService: ValidatorService;
  let mockExchangeRulesService: ReturnType<typeof createMockExchangeRulesService>;

  beforeEach(() => {
    vi.clearAllMocks();
    // ВАЖНО: ValidatorService использует Singleton, нужно сбросить instance перед каждым тестом
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ValidatorService as any).instance = undefined;
    mockExchangeRulesService = createMockExchangeRulesService();
    validatorService = ValidatorService.getInstance(mockExchangeRulesService);
  });

  describe('validateDecision - OPEN_LONG (Market)', () => {
    it('должен успешно валидировать корректное решение OPEN_LONG', () => {
      const decision = MockDataFactory.createLLMDecision({
        action: 'OPEN_LONG',
        parameters: {
          type: 'market',
          stop_loss_price: MockDataFactory.createDecimal(48000),
          take_profit_price: MockDataFactory.createDecimal(52000),
        },
      });

      const accountState = MockDataFactory.createAccountState();
      const strategyContext = MockDataFactory.createStrategyContext();
      const marketData = MockDataFactory.createMarketData({
        current_price: MockDataFactory.createDecimal(50000),
      });
      const exchangeRules = MockDataFactory.createMarketRules();

      const result = validatorService.validateDecision(
        decision,
        accountState,
        strategyContext,
        marketData,
        exchangeRules,
      );

      expect(result).toBeDefined();
      expect(result.roundedAmountCoin).toBeDefined();
      expect(result.roundedAmountUsd).toBeDefined();
      expect(result.usdAtRisk).toBeDefined();
    });

    it('должен выбросить ошибку если stop_loss_price не указан', () => {
      const decision = MockDataFactory.createLLMDecision({
        action: 'OPEN_LONG',
        parameters: {
          type: 'market',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stop_loss_price: null as any,
        },
      });

      const accountState = MockDataFactory.createAccountState();
      const strategyContext = MockDataFactory.createStrategyContext();
      const marketData = MockDataFactory.createMarketData();
      const exchangeRules = MockDataFactory.createMarketRules();

      expect(() => {
        validatorService.validateDecision(decision, accountState, strategyContext, marketData, exchangeRules);
      }).toThrow(ValidationError);
    });

    it('должен выбросить ошибку если SL >= entry price для LONG', () => {
      const decision = MockDataFactory.createLLMDecision({
        action: 'OPEN_LONG',
        parameters: {
          type: 'market',
          stop_loss_price: MockDataFactory.createDecimal(51000), // Выше entry price
        },
      });

      const accountState = MockDataFactory.createAccountState();
      const strategyContext = MockDataFactory.createStrategyContext();
      const marketData = MockDataFactory.createMarketData({
        current_price: MockDataFactory.createDecimal(50000),
      });
      const exchangeRules = MockDataFactory.createMarketRules();

      expect(() => {
        validatorService.validateDecision(decision, accountState, strategyContext, marketData, exchangeRules);
      }).toThrow(/Stop loss price.*must be strictly less than entry price/);
    });

    it('должен выбросить ошибку если TP <= entry price для LONG', () => {
      const decision = MockDataFactory.createLLMDecision({
        action: 'OPEN_LONG',
        parameters: {
          type: 'market',
          stop_loss_price: MockDataFactory.createDecimal(48000),
          take_profit_price: MockDataFactory.createDecimal(49000), // Меньше entry price
        },
      });

      const accountState = MockDataFactory.createAccountState();
      const strategyContext = MockDataFactory.createStrategyContext();
      const marketData = MockDataFactory.createMarketData({
        current_price: MockDataFactory.createDecimal(50000),
      });
      const exchangeRules = MockDataFactory.createMarketRules();

      expect(() => {
        validatorService.validateDecision(decision, accountState, strategyContext, marketData, exchangeRules);
      }).toThrow(/Take profit price.*must be strictly greater than entry price/);
    });

    it('должен выбросить ошибку если entry price = stop loss price', () => {
      const decision = MockDataFactory.createLLMDecision({
        action: 'OPEN_LONG',
        parameters: {
          type: 'market',
          stop_loss_price: MockDataFactory.createDecimal(50000), // Равно entry price
        },
      });

      const accountState = MockDataFactory.createAccountState();
      const strategyContext = MockDataFactory.createStrategyContext();
      const marketData = MockDataFactory.createMarketData({
        current_price: MockDataFactory.createDecimal(50000),
      });
      const exchangeRules = MockDataFactory.createMarketRules();

      // При SL = Entry для LONG сначала сработает проверка "SL must be strictly less than entry"
      // которая происходит ДО проверки нулевой дистанции
      expect(() => {
        validatorService.validateDecision(decision, accountState, strategyContext, marketData, exchangeRules);
      }).toThrow(/Stop loss price.*must be strictly less than entry price.*for LONG/);
    });
  });

  describe('validateDecision - OPEN_SHORT', () => {
    it('должен успешно валидировать корректное решение OPEN_SHORT', () => {
      const decision = MockDataFactory.createLLMDecision({
        action: 'OPEN_SHORT',
        parameters: {
          type: 'market',
          stop_loss_price: MockDataFactory.createDecimal(52000), // Выше entry для SHORT
          take_profit_price: MockDataFactory.createDecimal(48000), // Ниже entry для SHORT
        },
      });

      const accountState = MockDataFactory.createAccountState();
      const strategyContext = MockDataFactory.createStrategyContext();
      const marketData = MockDataFactory.createMarketData({
        current_price: MockDataFactory.createDecimal(50000),
      });
      const exchangeRules = MockDataFactory.createMarketRules();

      const result = validatorService.validateDecision(
        decision,
        accountState,
        strategyContext,
        marketData,
        exchangeRules,
      );

      expect(result).toBeDefined();
      expect(result.roundedAmountCoin).toBeDefined();
    });

    it('должен выбросить ошибку если SL <= entry price для SHORT', () => {
      const decision = MockDataFactory.createLLMDecision({
        action: 'OPEN_SHORT',
        parameters: {
          type: 'market',
          stop_loss_price: MockDataFactory.createDecimal(49000), // Ниже entry price
        },
      });

      const accountState = MockDataFactory.createAccountState();
      const strategyContext = MockDataFactory.createStrategyContext();
      const marketData = MockDataFactory.createMarketData({
        current_price: MockDataFactory.createDecimal(50000),
      });
      const exchangeRules = MockDataFactory.createMarketRules();

      expect(() => {
        validatorService.validateDecision(decision, accountState, strategyContext, marketData, exchangeRules);
      }).toThrow(/Stop loss price.*must be strictly greater than entry price.*SHORT/);
    });
  });

  describe('validateDecision - OPEN_LONG (Limit)', () => {
    it('должен успешно валидировать корректное решение OPEN_LONG limit', () => {
      const decision = MockDataFactory.createLLMDecision({
        action: 'OPEN_LONG',
        parameters: {
          type: 'limit',
          price: MockDataFactory.createDecimal(49000),
          stop_loss_price: MockDataFactory.createDecimal(48000),
          take_profit_price: MockDataFactory.createDecimal(52000),
        },
      });

      const accountState = MockDataFactory.createAccountState();
      const strategyContext = MockDataFactory.createStrategyContext();
      const marketData = MockDataFactory.createMarketData({
        current_price: MockDataFactory.createDecimal(50000),
      });
      const exchangeRules = MockDataFactory.createMarketRules();

      const result = validatorService.validateDecision(
        decision,
        accountState,
        strategyContext,
        marketData,
        exchangeRules,
      );

      expect(result).toBeDefined();
      expect(result.roundedEntryPrice.toString()).toBe('49000');
    });

    it('должен выбросить ошибку если price не указан для limit ордера', () => {
      const decision = MockDataFactory.createLLMDecision({
        action: 'OPEN_LONG',
        parameters: {
          type: 'limit',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          price: null as any,
          stop_loss_price: MockDataFactory.createDecimal(48000),
        },
      });

      const accountState = MockDataFactory.createAccountState();
      const strategyContext = MockDataFactory.createStrategyContext();
      const marketData = MockDataFactory.createMarketData();
      const exchangeRules = MockDataFactory.createMarketRules();

      expect(() => {
        validatorService.validateDecision(decision, accountState, strategyContext, marketData, exchangeRules);
      }).toThrow(/Price is required for limit order/);
    });
  });

  describe('validateDecision - Position Sizing Calculation', () => {
    it('должен корректно рассчитать размер позиции на основе риска', () => {
      const decision = MockDataFactory.createLLMDecision({
        action: 'OPEN_LONG',
        parameters: {
          type: 'market',
          stop_loss_price: MockDataFactory.createDecimal(48000), // 2000 USDT дистанция
          risk_percent: MockDataFactory.createDecimal(1.0), // 1% риска
        },
      });

      const accountState = MockDataFactory.createAccountState({
        total_portfolio_value_usdt: MockDataFactory.createDecimal(10000), // 100 USDT в риске
      });
      const strategyContext = MockDataFactory.createStrategyContext();
      const marketData = MockDataFactory.createMarketData({
        current_price: MockDataFactory.createDecimal(50000),
      });
      const exchangeRules = MockDataFactory.createMarketRules();

      const result = validatorService.validateDecision(
        decision,
        accountState,
        strategyContext,
        marketData,
        exchangeRules,
      );

      // Проверяем расчет: 100 USDT риска / 2000 USDT дистанции = 0.05 BTC
      expect(result.usdAtRisk.toString()).toBe('100');
      expect(result.rawAmountCoin).toBeDefined();
      expect(result.rawAmountUsd).toBeDefined();
    });

    it('должен выбросить ошибку если risk_percent превышает максимум', () => {
      const decision = MockDataFactory.createLLMDecision({
        action: 'OPEN_LONG',
        parameters: {
          type: 'market',
          stop_loss_price: MockDataFactory.createDecimal(48000),
          risk_percent: MockDataFactory.createDecimal(5.0), // Превышает max_allowed_risk_per_trade_percent (2.0)
        },
      });

      const accountState = MockDataFactory.createAccountState();
      const strategyContext = MockDataFactory.createStrategyContext({
        risk_rules: {
          default_risk_per_trade_percent: 1.0,
          max_allowed_risk_per_trade_percent: 2.0,
          max_total_portfolio_risk_percent: 10.0,
          desired_risk_reward_ratio: 2.0,
        },
      });
      const marketData = MockDataFactory.createMarketData();
      const exchangeRules = MockDataFactory.createMarketRules();

      expect(() => {
        validatorService.validateDecision(decision, accountState, strategyContext, marketData, exchangeRules);
      }).toThrow(/Risk percent.*exceeds max allowed/);
    });
  });

  describe('validateDecision - CLOSE_POSITION', () => {
    it('должен успешно валидировать корректное решение CLOSE_POSITION', () => {
      const decision = MockDataFactory.createLLMDecision({
        action: 'CLOSE_POSITION',
        parameters: {
          type: 'market',
          amount_percent: MockDataFactory.createDecimal(100),
        },
      });

      const accountState = MockDataFactory.createAccountState({
        open_positions: [MockDataFactory.createOpenPosition({ pair: 'BTC/USDT' })],
      });
      const strategyContext = MockDataFactory.createStrategyContext();
      const marketData = MockDataFactory.createMarketData();
      const exchangeRules = MockDataFactory.createMarketRules();

      const result = validatorService.validateDecision(
        decision,
        accountState,
        strategyContext,
        marketData,
        exchangeRules,
      );

      expect(result).toBeDefined();
    });

    it('должен выбросить ошибку если amount_percent не указан', () => {
      const decision = MockDataFactory.createLLMDecision({
        action: 'CLOSE_POSITION',
        parameters: {
          type: 'market',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          amount_percent: null as any,
        },
      });

      const accountState = MockDataFactory.createAccountState({
        open_positions: [MockDataFactory.createOpenPosition({ pair: 'BTC/USDT' })],
      });
      const strategyContext = MockDataFactory.createStrategyContext();
      const marketData = MockDataFactory.createMarketData();
      const exchangeRules = MockDataFactory.createMarketRules();

      expect(() => {
        validatorService.validateDecision(decision, accountState, strategyContext, marketData, exchangeRules);
      }).toThrow(/amount_percent is required for CLOSE_POSITION/);
    });

    it('должен выбросить ошибку если amount_percent > 100', () => {
      const decision = MockDataFactory.createLLMDecision({
        action: 'CLOSE_POSITION',
        parameters: {
          type: 'market',
          amount_percent: MockDataFactory.createDecimal(150),
        },
      });

      const accountState = MockDataFactory.createAccountState({
        open_positions: [MockDataFactory.createOpenPosition({ pair: 'BTC/USDT' })],
      });
      const strategyContext = MockDataFactory.createStrategyContext();
      const marketData = MockDataFactory.createMarketData();
      const exchangeRules = MockDataFactory.createMarketRules();

      expect(() => {
        validatorService.validateDecision(decision, accountState, strategyContext, marketData, exchangeRules);
      }).toThrow(/amount_percent must be in range/);
    });
  });

  describe('validateDecision - MODIFY_POSITION', () => {
    it('должен успешно валидировать корректное решение MODIFY_POSITION', () => {
      const decision = MockDataFactory.createLLMDecision({
        action: 'MODIFY_POSITION',
        parameters: {
          new_stop_loss_price: MockDataFactory.createDecimal(48000),
        },
      });

      const accountState = MockDataFactory.createAccountState();
      const strategyContext = MockDataFactory.createStrategyContext();
      const marketData = MockDataFactory.createMarketData();
      const exchangeRules = MockDataFactory.createMarketRules();

      const result = validatorService.validateDecision(
        decision,
        accountState,
        strategyContext,
        marketData,
        exchangeRules,
      );

      expect(result).toBeDefined();
    });

    it('должен выбросить ошибку если нет параметров модификации', () => {
      const decision = MockDataFactory.createLLMDecision({
        action: 'MODIFY_POSITION',
        parameters: {},
      });

      const accountState = MockDataFactory.createAccountState();
      const strategyContext = MockDataFactory.createStrategyContext();
      const marketData = MockDataFactory.createMarketData();
      const exchangeRules = MockDataFactory.createMarketRules();

      expect(() => {
        validatorService.validateDecision(decision, accountState, strategyContext, marketData, exchangeRules);
      }).toThrow(/MODIFY_POSITION must have at least one modification parameter/);
    });
  });

  describe('validateDecision - HOLD', () => {
    it('должен выбросить специальную ошибку для HOLD', () => {
      const decision = MockDataFactory.createLLMDecision({
        action: 'HOLD',
      });

      const accountState = MockDataFactory.createAccountState();
      const strategyContext = MockDataFactory.createStrategyContext();
      const marketData = MockDataFactory.createMarketData();
      const exchangeRules = MockDataFactory.createMarketRules();

      expect(() => {
        validatorService.validateDecision(decision, accountState, strategyContext, marketData, exchangeRules);
      }).toThrow(ValidationError);
    });
  });

  describe('validateDecision - Exchange and Balance Rules', () => {
    it('должен выбросить ошибку если стоимость ордера < minNotional', () => {
      // Используем большую дистанцию и маленький риск, чтобы получить маленькую стоимость ордера
      // Но при этом риск должен быть больше fee для прохождения проверки Fee vs Risk
      // Расчет: 15 USDT / 1000 = 0.015 BTC, размер позиции = 0.015 * 50000 = 750 USDT
      // Round-trip fee = 750 * 0.001 * 2 = 1.5 USDT, что МЕНЬШЕ риска (15), так что пройдет Fee vs Risk
      // minNotional 1000 больше чем 750, так что проверка minNotional упадет
      const decision = MockDataFactory.createLLMDecision({
        action: 'OPEN_LONG',
        parameters: {
          type: 'market',
          stop_loss_price: MockDataFactory.createDecimal(49000), // Дистанция 1000 (больше)
          risk_percent: MockDataFactory.createDecimal(0.15), // 0.15% риска = 15 USDT (явно больше чем fee ~1.5)
        },
      });

      const accountState = MockDataFactory.createAccountState({
        total_portfolio_value_usdt: MockDataFactory.createDecimal(10000), // 15 USDT в риске
        available_quote_balance: MockDataFactory.createDecimal(20000), // ОЧЕНЬ большой баланс
      });
      const strategyContext = MockDataFactory.createStrategyContext();
      const marketData = MockDataFactory.createMarketData({
        current_price: MockDataFactory.createDecimal(50000),
      });
      const exchangeRules = MockDataFactory.createMarketRules({
        minNotional: MockDataFactory.createDecimal(1000), // Очень высокий минимум (больше чем стоимость ордера после округления)
        precision: {
          amount: MockDataFactory.createDecimal('0.00000001'),
          price: MockDataFactory.createDecimal('0.01'),
        },
      });

      // ВАЖНО: Мокируем exchangeRulesService.getRules, чтобы он возвращал правила из теста
      // ValidatorService вызывает getRules для пары несколько раз через this.exchangeRulesService.getRules(pair)
      // validatorService хранит ссылку на mockExchangeRulesService (установлен в beforeEach)
      // Сбрасываем мок и устанавливаем mockReturnValue для множественных вызовов
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockExchangeRulesService.getRules as any).mockReset();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockExchangeRulesService.getRules as any).mockReturnValue(exchangeRules);

      expect(() => {
        validatorService.validateDecision(decision, accountState, strategyContext, marketData, exchangeRules);
      }).toThrow(/Рассчитанная стоимость ордера.*ниже биржевого минимума/);

      // Проверяем, что getRules был вызван
      expect(mockExchangeRulesService.getRules).toHaveBeenCalledWith(decision.pair);
    });

    it('должен выбросить ошибку если недостаточно баланса', () => {
      const decision = MockDataFactory.createLLMDecision({
        action: 'OPEN_LONG',
        parameters: {
          type: 'market',
          stop_loss_price: MockDataFactory.createDecimal(40000), // Дистанция 10000 для большого размера
          risk_percent: MockDataFactory.createDecimal(5.0), // 5% риска = 500 USDT
        },
      });

      const accountState = MockDataFactory.createAccountState({
        total_portfolio_value_usdt: MockDataFactory.createDecimal(10000), // 500 USDT в риске
        available_quote_balance: MockDataFactory.createDecimal(100), // Меньше чем нужно (нужно ~2500 USDT)
      });
      const strategyContext = MockDataFactory.createStrategyContext({
        risk_rules: {
          default_risk_per_trade_percent: 1.0,
          max_allowed_risk_per_trade_percent: 10.0, // Разрешаем большой риск
          max_total_portfolio_risk_percent: 50.0,
          desired_risk_reward_ratio: 2.0,
        },
      });
      const marketData = MockDataFactory.createMarketData({
        current_price: MockDataFactory.createDecimal(50000),
      });
      const exchangeRules = MockDataFactory.createMarketRules({
        precision: {
          amount: MockDataFactory.createDecimal('0.00000001'),
          price: MockDataFactory.createDecimal('0.01'),
        },
        minNotional: MockDataFactory.createDecimal(5),
      });

      expect(() => {
        validatorService.validateDecision(decision, accountState, strategyContext, marketData, exchangeRules);
      }).toThrow(/превышает доступный баланс/);
    });
  });

  describe('validateDecision - Precision Rounding', () => {
    it('должен корректно округлять значения по precision биржи', () => {
      const decision = MockDataFactory.createLLMDecision({
        action: 'OPEN_LONG',
        parameters: {
          type: 'market',
          stop_loss_price: MockDataFactory.createDecimal(30000), // Дистанция 20000 (большая для большого размера)
          risk_percent: MockDataFactory.createDecimal(5.0), // 5% риска = 500 USDT
        },
      });

      const accountState = MockDataFactory.createAccountState({
        total_portfolio_value_usdt: MockDataFactory.createDecimal(10000), // 500 USDT в риске
        available_quote_balance: MockDataFactory.createDecimal(5000), // Достаточно баланса
      });
      const strategyContext = MockDataFactory.createStrategyContext({
        risk_rules: {
          default_risk_per_trade_percent: 1.0,
          max_allowed_risk_per_trade_percent: 10.0, // Разрешаем большой риск
          max_total_portfolio_risk_percent: 50.0,
          desired_risk_reward_ratio: 2.0,
        },
      });
      const marketData = MockDataFactory.createMarketData({
        current_price: MockDataFactory.createDecimal(50000),
      });
      const exchangeRules = MockDataFactory.createMarketRules({
        precision: {
          amount: MockDataFactory.createDecimal('0.00000001'), // Стандартная точность BTC
          price: MockDataFactory.createDecimal('0.01'),
        },
        minNotional: MockDataFactory.createDecimal(5), // Низкий минимум для теста
      });

      const result = validatorService.validateDecision(
        decision,
        accountState,
        strategyContext,
        marketData,
        exchangeRules,
      );

      expect(result.roundedAmountCoin).toBeDefined();
      expect(result.roundedAmountUsd).toBeDefined();
      expect(result.roundedEntryPrice).toBeDefined();
      // Проверяем, что округленные значения не равны нулю
      expect(result.roundedAmountCoin.toString()).not.toBe('0');
      expect(result.roundedAmountUsd.toString()).not.toBe('0');
    });
  });
});
