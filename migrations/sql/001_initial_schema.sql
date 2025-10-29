-- Initial Schema for CryptoLLM Trading Bot
-- Все финансовые значения используют NUMERIC(18, 8) для точности
-- Все временные метки используют TIMESTAMPTZ для корректной работы с часовыми поясами
-- Все JSON данные используют JSONB для эффективного хранения и индексации

-- 1. ActivePositions: Хранит текущие открытые позиции
CREATE TABLE ActivePositions (
    id BIGSERIAL PRIMARY KEY,
    pair VARCHAR(255) NOT NULL UNIQUE,
    side VARCHAR(10) NOT NULL CHECK (side IN ('long', 'short')),
    amount NUMERIC(18, 8) NOT NULL,
    average_entry_price NUMERIC(18, 8) NOT NULL,
    total_fee_cost NUMERIC(18, 8) NOT NULL DEFAULT 0.0,
    stop_loss_price NUMERIC(18, 8),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_activepositions_pair ON ActivePositions(pair);

-- 2. ActiveOrders: Хранит все активные ордера (SL, TP, Limit Open/Close)
CREATE TABLE ActiveOrders (
    id BIGSERIAL PRIMARY KEY,
    exchange_order_id VARCHAR(255) NOT NULL UNIQUE,
    pair VARCHAR(255) NOT NULL,
    type VARCHAR(30) NOT NULL CHECK (type IN ('limit_open', 'limit_close', 'stop_loss_limit', 'take_profit_limit')),
    side VARCHAR(10) NOT NULL CHECK (side IN ('buy', 'sell')),
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    price NUMERIC(18, 8) NOT NULL,
    amount NUMERIC(18, 8) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Поля для ордеров 'limit_open' (заполняются ПОСЛЕ исполнения limit_open)
    target_stop_loss_price NUMERIC(18, 8),
    target_take_profit_price NUMERIC(18, 8),
    target_trailing_stop_json JSONB
);

CREATE INDEX idx_activeorders_pair_status ON ActiveOrders(pair, status);
CREATE INDEX idx_activeorders_exchange_id ON ActiveOrders(exchange_order_id);

-- 3. TSL_State: Хранит состояние Trailing Stop Loss для активных позиций
CREATE TABLE TSL_State (
    id BIGSERIAL PRIMARY KEY,
    pair VARCHAR(255) NOT NULL UNIQUE,
    current_stop_price NUMERIC(18, 8) NOT NULL,
    current_stop_order_id VARCHAR(255) NOT NULL,
    price_seen NUMERIC(18, 8) NOT NULL,
    rule_config_json JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tslstate_pair ON TSL_State(pair);

-- 4. LLM_Triggers: Хранит условия триггеров для вызова LLM по каждой паре
CREATE TABLE LLM_Triggers (
    id BIGSERIAL PRIMARY KEY,
    pair VARCHAR(255) NOT NULL UNIQUE,
    reason TEXT,
    trigger_conditions_json JSONB NOT NULL,
    requested_data_json JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_llmtriggers_pair ON LLM_Triggers(pair);

-- 5. TradeHistory: Неизменяемый лог всех исполненных сделок
CREATE TABLE TradeHistory (
    id BIGSERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL,
    exchange_trade_id VARCHAR(255) NOT NULL UNIQUE,
    exchange_order_id VARCHAR(255) NOT NULL,
    pair VARCHAR(255) NOT NULL,
    side VARCHAR(10) NOT NULL CHECK (side IN ('buy', 'sell')),
    price NUMERIC(18, 8) NOT NULL,
    amount NUMERIC(18, 8) NOT NULL,
    fee_cost NUMERIC(18, 8) NOT NULL,
    fee_currency VARCHAR(20) NOT NULL,
    realized_pnl_usd NUMERIC(18, 8),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tradehistory_pair_timestamp ON TradeHistory(pair, timestamp);
CREATE INDEX idx_tradehistory_exchange_trade_id ON TradeHistory(exchange_trade_id);

-- 6. LLM_Decision_Log: Аудит всех вызовов LLM (черный ящик)
CREATE TABLE LLM_Decision_Log (
    id BIGSERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    triggered_pair VARCHAR(255) NOT NULL,
    trigger_reason TEXT,
    request_payload_json JSONB NOT NULL,
    response_payload_json JSONB,
    decision_result VARCHAR(50) NOT NULL DEFAULT 'pending',
    validator_error_message TEXT,
    worker_error_message TEXT,
    llm_error_message TEXT
);

CREATE INDEX idx_llmdecisionlog_timestamp ON LLM_Decision_Log(timestamp);
CREATE INDEX idx_llmdecisionlog_pair_result ON LLM_Decision_Log(triggered_pair, decision_result);

