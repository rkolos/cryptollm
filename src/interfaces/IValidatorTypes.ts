import Decimal from 'decimal.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const decimalInstance = new (Decimal as any)(0);
export type DecimalValue = typeof decimalInstance;

export interface OpenPosition {
  pair: string;
  side: 'long' | 'short';
  amount: DecimalValue;
  average_entry_price: DecimalValue;
  stop_loss_price: DecimalValue | null;
}

export interface AssetBalance {
  asset: string;
  total: DecimalValue;
  available: DecimalValue;
}

export interface TSLRuleConfig {
  type: 'percentage';
  distance: number; // Процент (e.g., 2.5)
}

export interface TSLState {
  currentStopPrice: DecimalValue;
  currentStopOrderId: string;
  priceSeen: DecimalValue; // highestPrice для long, lowestPrice для short
}

export interface TSLRule {
  pair: string;
  position: OpenPosition;
  state: TSLState;
  rule: TSLRuleConfig;
}

export interface AccountState {
  total_portfolio_value_usdt: DecimalValue;
  available_quote_balance: DecimalValue;
  assets: AssetBalance[];
  open_positions: OpenPosition[];
  open_orders: unknown[];
  tslRules: Map<string, TSLRule>;
}

export interface MarketData {
  pair: string;
  current_price: DecimalValue;
}

export interface StrategyContext {
  risk_rules: {
    default_risk_per_trade_percent: number;
    max_allowed_risk_per_trade_percent: number;
    max_total_portfolio_risk_percent: number;
    desired_risk_reward_ratio: number;
  };
}

export interface SanityCheckResult {
  entryPrice: DecimalValue;
}

export interface CalculatedAmounts {
  rawAmountCoin: DecimalValue;
  rawAmountUsd: DecimalValue;
  roundedAmountCoin: DecimalValue;
  roundedAmountUsd: DecimalValue;
  roundedEntryPrice: DecimalValue;
  usdAtRisk: DecimalValue;
  entryPrice: DecimalValue;
}
