export interface LLMDecision {
  action: 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE_POSITION' | 'MODIFY_POSITION' | 'CANCEL_ORDERS' | 'HOLD';
  pair: string;
  parameters: {
    type?: 'market' | 'limit';
    price?: number | null;
    risk_percent?: number | null;
    stop_loss_price?: number | null;
    take_profit_price?: number | null;
    trailing_stop_config?: {
      type: 'percentage';
      distance: number;
    } | null;
    amount_percent?: number;
    order_id?: string | null;
    new_stop_loss_price?: number;
    new_take_profit_price?: number;
    new_trailing_stop_config?: {
      type: 'percentage';
      distance: number;
    } | null;
    [key: string]: unknown;
  };
  justification: string;
}

export interface MacroContext {
  fear_and_greed_index: number | null;
  fear_and_greed_text: string | null;
}

export interface LLMTriggerCondition {
  type: 'price' | 'indicator' | 'timeout';
  condition: string;
  value: number;
  name?: string;
  timeframe?: string;
}

export interface LLMResponse {
  decisions: LLMDecision[];
  update_triggers_for_pair: string;
  next_call_triggers: {
    reason: string;
    trigger_conditions: LLMTriggerCondition[];
  };
  request_additional_data: string[] | null;
}

export interface LLMRequest {
  strategy_context: {
    role: string;
    style: string;
    risk_rules: {
      default_risk_per_trade_percent: number;
      max_allowed_risk_per_trade_percent: number;
      max_total_portfolio_risk_percent: number;
      desired_risk_reward_ratio: number;
    };
    macro_context?: {
      fear_and_greed_index: number;
      fear_and_greed_text: string;
    };
    watchlist: string[];
  };
  triggered_pair: string;
  market_data: Record<string, unknown>;
  technical_analysis: Record<string, unknown>;
  account_state: Record<string, unknown>;
  question: string;
}
