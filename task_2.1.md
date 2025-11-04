# Техническое Задание (ТЗ): 2.1 Проектирование Схемы БД (Schema Design)

**Эпик:** 2. 🐘 Архитектура Базы Данных (PostgreSQL) **Задача:** 2.1 Проектирование Схемы БД (Schema Design) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать единый DDL-скрипт (`.sql`) для инициализации полной схемы базы данных PostgreSQL. Этот скрипт будет использован в первой миграции (Задача 2.2). Схема должна включать все таблицы, необходимые для отслеживания состояния, истории торгов и аудита LLM.

## 2\. Конечный Результат

Один файл: `migrations/schemas/001_initial_schema.sql` (Путь примерный, будет уточнен в Задаче 2.2).

## 3\. Общие Архитектурные Требования

1.  **Финансовая Точность (Критично):** Все, без исключения, столбцы, хранящие цены, суммы, комиссии, PnL или любые другие денежные/количественные значения, **ДОЛЖНЫ** использовать тип `NUMERIC`. Рекомендуется `NUMERIC(18, 8)` (18 знаков всего, 8 после запятой) для обеспечения достаточной точности в криптовалютных расчетах.
2.  **Временные Метки:** Все столбцы, хранящие время, **ДОЛЖНЫ** использовать тип `TIMESTAMPTZ` (timestamp with time zone) для избежания путаницы с часовыми поясами.
3.  **JSON Данные:** Все столбцы, предназначенные для хранения `JSON` (например, `..._json`), **ДОЛЖНЫ** использовать тип `JSONB` для эффективного хранения и возможности индексации в PostgreSQL.
4.  **Первичные Ключи:** Использовать `BIGSERIAL` для автоинкрементных ID.
5.  **Индексы:** Создать `INDEX` для всех столбцов, которые будут использоваться в `WHERE` (например, `pair`, `status`, `exchange_order_id`) и для внешних ключей (хотя мы не используем `FOREIGN KEY` constraints для TSL/Positions, мы все равно индексируем `pair`).

## 4\. Определение Схемы (DDL)

Разработчик должен создать `CREATE TABLE` скрипты для следующих 6 таблиц:

### 4.1. `ActivePositions`

_Хранит текущие открытые позиции._

    CREATE TABLE ActivePositions (
        id BIGSERIAL PRIMARY KEY,
        pair VARCHAR(255) NOT NULL UNIQUE, -- Ключ: одна позиция на пару
        side VARCHAR(10) NOT NULL CHECK (side IN ('long', 'short')),
        amount NUMERIC(18, 8) NOT NULL, -- Количество базовой валюты (e.g., BTC)
        average_entry_price NUMERIC(18, 8) NOT NULL,
        total_fee_cost NUMERIC(18, 8) NOT NULL DEFAULT 0.0, -- Сумма комиссий в USDT
        stop_loss_price NUMERIC(18, 8), -- Текущая цена SL
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_activepositions_pair ON ActivePositions(pair);

### 4.2. `ActiveOrders`

_Хранит все ордера, которые, по нашему мнению, активны на бирже (SL, TP, Limit Open/Close)._

    CREATE TABLE ActiveOrders (
        id BIGSERIAL PRIMARY KEY,
        exchange_order_id VARCHAR(255) NOT NULL UNIQUE, -- ID ордера с биржи
        pair VARCHAR(255) NOT NULL,
        type VARCHAR(30) NOT NULL CHECK (type IN ('limit_open', 'limit_close', 'stop_loss_limit', 'take_profit_limit')),
        side VARCHAR(10) NOT NULL CHECK (side IN ('buy', 'sell')),
        status VARCHAR(20) NOT NULL DEFAULT 'open',
        price NUMERIC(18, 8) NOT NULL, -- Цена ордера
        amount NUMERIC(18, 8) NOT NULL, -- Количество
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        -- Поля для ордеров 'limit_open' (согласно Задаче 2.1)
        target_stop_loss_price NUMERIC(18, 8), -- (NULLABLE) SL, который нужно выставить ПОСЛЕ исполнения
        target_take_profit_price NUMERIC(18, 8), -- (NULLABLE) TP, который нужно выставить ПОСЛЕ исполнения
        target_trailing_stop_json JSONB -- (NULLABLE) Конфигурация TSL для выставления ПОСЛЕ исполнения
    );

    CREATE INDEX idx_activeorders_pair_status ON ActiveOrders(pair, status);
    CREATE INDEX idx_activeorders_exchange_id ON ActiveOrders(exchange_order_id);

### 4.3. `TSL_State`

_Хранит состояние Trailing Stop Loss для каждой активной позиции, у которой он включен._

    CREATE TABLE TSL_State (
        id BIGSERIAL PRIMARY KEY,
        pair VARCHAR(255) NOT NULL UNIQUE, -- Связь с ActivePositions.pair
        current_stop_price NUMERIC(18, 8) NOT NULL, -- Текущая цена SL
        current_stop_order_id VARCHAR(255) NOT NULL, -- ID ордера SL в ActiveOrders

        -- 'highest_price_seen' для long, 'lowest_price_seen' для short
        price_seen NUMERIC(18, 8) NOT NULL,

        rule_config_json JSONB NOT NULL, -- e.g., {"type": "percentage", "distance": 3.0}
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_tslstate_pair ON TSL_State(pair);

### 4.4. `LLM_Triggers`

_Хранит условия, по которым "Наблюдатель" должен вызвать LLM для каждой пары._

    CREATE TABLE LLM_Triggers (
        id BIGSERIAL PRIMARY KEY,
        pair VARCHAR(255) NOT NULL UNIQUE,
        reason TEXT, -- Последняя причина обновления триггеров
        trigger_conditions_json JSONB NOT NULL, -- Массив триггеров (price, indicator, timeout)
        requested_data_json JSONB, -- (NULLABLE) Массив доп. индикаторов (ADX, ATR...)
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_llmtriggers_pair ON LLM_Triggers(pair);

### 4.5. `TradeHistory`

*Неизменяемый лог всех *исполненных* сделок (не ордеров) с биржи.*

    CREATE TABLE TradeHistory (
        id BIGSERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ NOT NULL, -- Время исполнения сделки (с биржи)
        exchange_trade_id VARCHAR(255) NOT NULL UNIQUE, -- ID сделки (e.g., from fetchMyTrades)
        exchange_order_id VARCHAR(255) NOT NULL, -- ID ордера, к которому относится сделка
        pair VARCHAR(255) NOT NULL,
        side VARCHAR(10) NOT NULL CHECK (side IN ('buy', 'sell')),
        price NUMERIC(18, 8) NOT NULL,
        amount NUMERIC(18, 8) NOT NULL,
        fee_cost NUMERIC(18, 8) NOT NULL,
        fee_currency VARCHAR(20) NOT NULL,

        -- (NULLABLE) Заполняется только для 'sell' сделок, закрывающих позицию
        realized_pnl_usd NUMERIC(18, 8),

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_tradehistory_pair_timestamp ON TradeHistory(pair, timestamp);
    CREATE INDEX idx_tradehistory_exchange_trade_id ON TradeHistory(exchange_trade_id);

### 4.6. `LLM_Decision_Log`

_"Черный ящик" (аудит) для каждого вызова LLM (согласно Задаче 2.4)._

    CREATE TABLE LLM_Decision_Log (
        id BIGSERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        triggered_pair VARCHAR(255) NOT NULL,
        trigger_reason TEXT,

        request_payload_json JSONB NOT NULL, -- Полный JSON, отправленный в LLM
        response_payload_json JSONB, -- (NULLABLE) Полный JSON, полученный от LLM

        decision_result VARCHAR(50) NOT NULL DEFAULT 'pending',
        -- 'pending', 'accepted', 'rejected_by_validator', 'failed_by_worker', 'failed_by_llm'

        validator_error_message TEXT, -- (NULLABLE) Причина, если 'rejected_by_validator'
        worker_error_message TEXT, -- (NULLABLE) Причина, если 'failed_by_worker'
        llm_error_message TEXT -- (NULLABLE) Причина, если 'failed_by_llm' (e.g., API 500)
    );

    CREATE INDEX idx_llmdecisionlog_timestamp ON LLM_Decision_Log(timestamp);
    CREATE INDEX idx_llmdecisionlog_pair_result ON LLM_Decision_Log(triggered_pair, decision_result);

## 5\. Критерии Приемки (Acceptance Criteria)

1.  **\[Результат\]** Создан один `.sql` файл, содержащий `CREATE TABLE` и `CREATE INDEX` операторы для всех 6 перечисленных таблиц.
2.  **\[Точность\]** Все столбцы, связанные с финансами/количеством (`price`, `amount`, `fee_cost`, `pnl_usd` и т.д.), используют тип `NUMERIC`.
3.  **\[JSON\]** Все столбцы `..._json` используют тип `JSONB`.
4.  **\[Время\]** Все столбцы `..._at` или `timestamp` используют тип `TIMESTAMPTZ`.
5.  **\[Спецификация 2.1\]** Таблица `ActiveOrders` содержит `nullable` столбцы: `target_stop_loss_price`, `target_take_profit_price` и `target_trailing_stop_json`.
6.  **\[Спецификация 2.4\]** Таблица `LLM_Decision_Log` реализована в соответствии со схемой, описанной в п. 4.6.
7.  **\[Индексы\]** Для таблицы `TradeHistory` создан дополнительный индекс `idx_tradehistory_exchange_trade_id` на поле `exchange_trade_id` для быстрого поиска по ID сделки с биржи.
8.  **\[Корректность\]** DDL-скрипт синтаксически корректен для PostgreSQL и выполняется без ошибок.
