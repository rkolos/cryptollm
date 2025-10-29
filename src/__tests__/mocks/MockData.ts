import Decimal from 'decimal.js';
import type { LLMDecision } from '../../interfaces/ILLMTypes.js';
import type {
  AccountState,
  MarketData,
  StrategyContext,
  OpenPosition,
  AssetBalance,
  DecimalValue,
} from '../../interfaces/IValidatorTypes.js';
import type { IMarketRules } from '../../interfaces/IMarketRules.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DecimalConstructor = Decimal as any;

/**
 * Фабрика для создания тестовых данных
 */
export class MockDataFactory {
  static createDecimal(value: number | string): DecimalValue {
    return new DecimalConstructor(value) as DecimalValue;
  }

  static createMarketRules(overrides?: Partial<IMarketRules>): IMarketRules {
    return {
      minNotional: this.createDecimal(10),
      takerFee: this.createDecimal(0.001),
      precision: {
        amount: this.createDecimal('0.00000001'),
        price: this.createDecimal('0.01'),
      },
      ...overrides,
    };
  }

  static createMarketData(overrides?: Partial<MarketData>): MarketData {
    return {
      pair: 'BTC/USDT',
      current_price: this.createDecimal(50000),
      ...overrides,
    };
  }

  static createStrategyContext(overrides?: Partial<StrategyContext>): StrategyContext {
    return {
      risk_rules: {
        default_risk_per_trade_percent: 1.0,
        max_allowed_risk_per_trade_percent: 2.0,
        max_total_portfolio_risk_percent: 10.0,
        desired_risk_reward_ratio: 2.0,
        ...overrides?.risk_rules,
      },
    };
  }

  static createAssetBalance(overrides?: Partial<AssetBalance>): AssetBalance {
    return {
      asset: 'USDT',
      total: this.createDecimal(10000),
      available: this.createDecimal(9000),
      ...overrides,
    };
  }

  static createOpenPosition(overrides?: Partial<OpenPosition>): OpenPosition {
    return {
      pair: 'BTC/USDT',
      side: 'long',
      amount: this.createDecimal(0.1),
      average_entry_price: this.createDecimal(50000),
      stop_loss_price: this.createDecimal(48000),
      ...overrides,
    };
  }

  static createAccountState(overrides?: Partial<AccountState>): AccountState {
    return {
      total_portfolio_value_usdt: this.createDecimal(10000),
      available_quote_balance: this.createDecimal(9000),
      assets: [this.createAssetBalance()],
      open_positions: [],
      open_orders: [],
      tslRules: new Map(),
      llmTriggers: new Map(),
      ...overrides,
    };
  }

  static createLLMDecision(overrides?: Partial<LLMDecision>): LLMDecision {
    return {
      action: 'OPEN_LONG',
      pair: 'BTC/USDT',
      parameters: {
        type: 'market',
        stop_loss_price: this.createDecimal(48000),
        take_profit_price: this.createDecimal(52000),
      },
      justification: 'Test decision',
      ...overrides,
    };
  }
}
