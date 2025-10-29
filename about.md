# Список данных для LLM-трейдера (Мульти-валютная Архитектура)

## Введение

Основная задача — превратить хаотичные рыночные данные в структурированный "отчет", который LLM может прочитать и проанализировать. Модель не умеет "видеть" графики, поэтому мы должны "описать" ей график и текущую ситуацию текстом и цифрами.

Формат передачи всех этих данных в LLM должен быть единым, например, большой JSON-объект.

## Категория 1: Данные о Рынке (Market Data)

Это "глаза" вашего бота. "Наблюдатель" будет получать эти данные для _каждой_ пары из своего `watchlist`.

При вызове LLM, "Наблюдатель" отправляет два типа данных:

1.  **Детальные данные** (стакан, лента, полный ТА) по той паре, которая инициировала вызов (`triggered_pair`).
2.  **Обзорные данные** (цена, RSI) по всем остальным парам в `watchlist`.

### 1.1. Исторические данные (Свечи / OHLCV)

"Наблюдатель" (ваш `node.js` скрипт) **ЗАГРУЖАЕТ** эти данные, но **НЕ ПЕРЕСЫЛАЕТ** их в LLM.

"Наблюдатель" использует эти массивы свечей (например, 100-200 последних свечей для каждого таймфрейма) как _сырье_ для расчета всех индикаторов и ключевых уровней из Категории 2. Это экономит тысячи токенов на каждом запросе.

### 1.2. Данные "Стакана" (Order Book)

_Для `triggered_pair`._ Показывает ближайший спрос и предложение. Эта информация _отправляется_ в LLM.

- **Данные:** "Наблюдатель" должен запросить глубокий срез стакана (например, `limit: 100` через `fetchOrderBook()`), чтобы агрегировать данные.
- **Ключевые показатели:**
  - `best_bid:` (лучшая цена покупки)
  - `best_ask:` (лучшая цена продажи)
  - `spread:` (разница между ними)
  - `aggregated_bid_volume_0.5_percent:` (Сумма _количества_ (amount) всех ордеров на покупку в пределах 0.5% от `best_bid`. _Единица измерения: базовая валюта, e.g., BTC_).
  - `aggregated_ask_volume_0.5_percent:` (Сумма _количества_ (amount) всех ордеров на продажу в пределах 0.5% от `best_ask`. _Единица измерения: базовая валюта, e.g., BTC_).

- **Как считать (Логика "Наблюдателя"):**
  1.  Получить `orderBook = await binance.fetchOrderBook(pair, 100)`.
  2.  `const best_bid = orderBook.bids[0][0];`
  3.  `const bid_limit_price = best_bid * 0.995;` (цена -0.5%)
  4.  `aggregated_bid_volume = orderBook.bids.filter(bid => bid[0] >= bid_limit_price).reduce((sum, bid) => sum + bid[1], 0);`
  5.  (Аналогично для `aggregated_ask_volume` с `best_ask` и `best_ask * 1.005`).

**ТРЕБОВАНИЕ К РЕАЛИЗАЦИИ:** Все расчеты (умножение, фильтрация, сложение) и сравнения цен **ДОЛЖНЫ** использовать библиотеку для десятичной арифметики (например, `decimal.js`) для обеспечения абсолютной точности.

### 1.3. Лента последних сделок (Recent Trades)

_Для `triggered_pair`._ Показывает "агрессию" рынка прямо сейчас. _Отправляется_ в LLM.

- **Данные:** Массив из N (например, 20) последних совершенных сделок.
- **Формат:** `[ {timestamp: ..., price: ..., amount: ..., side: 'buy'/'sell'}, ... ]`

### 1.4. Обзор Watchlist (Watchlist Overview)

Это "легкий" срез данных по _всем_ парам в `watchlist`, _кроме_ той, что уже детально описана (`triggered_pair`). Это дает LLM понимание общей корреляции рынка.

- **Данные:** Массив объектов.
- **Формат:** `[ { pair: 'ETH/USDT', current_price: 1850.5, rsi_1h: 62.1 }, { pair: 'SOL/USDT', current_price: 25.1, rsi_1h: 45.0 } ]`

## Категория 2: Технический Анализ (Technical Analysis)

_Для `triggered_pair`._ Это **сердце** данных, отправляемых в LLM. Это — _агрегированный результат_ анализа сотен свечей. Ваш `node.js` скрипт должен рассчитать все это и предоставить LLM готовые цифры.

### 2.1. Индикаторы (Technical Indicators) - "Базовый Пакет"

Эти данные отправляются **каждый раз** при вызове LLM (для `triggered_pair`).

- **Скользящие средние (Trend):** `EMA (50)`, `EMA (200)`
- **Осцилляторы (Momentum):** `RSI (14)`
- **Конвергенция/Дивергенция:** `MACD (12, 26, 9)` (значение гистограммы `histogram`)
- **Волатильность:** `Bollinger Bands (20, 2)`

### 2.2. Ключевые Уровни (Key Levels) - "Базовый Пакет"

Это замена текстовому описанию "цена пошла вверх/вниз". Рассчитывается простым перебором массива свечей, который мы _не_ отправляем в LLM.

- `high (N candles):` Максимальная цена (high) за N последних свечей.
- `low (N candles):` Минимальная цена (low) за N последних свечей.
- **Формат (Пример для 1h):**

      "analysis_1h": {
        "rsi": 45.12,
        "macd_histogram": -2.4,
        "ema_50": 30100,
        "ema_200": 29500,
        "bollinger": { "upper": 30500, "middle": 30000, "lower": 29500 },
        "key_levels": { "period": 100, "high": 31500, "low": 29800 }
      }

### 2.3. Дополнительные Индикаторы - "Расширенный Пакет" (По Запросу)

Эти данные (для `triggered_pair`) рассчитываются и отправляются **только** если LLM запросила их в _предыдущем_ ответе (См. Приложение Б).

- **Индикаторы Силы Тренда:** `ADX (14)`
- **Индикаторы Волатильности:** `ATR (14)`
- **Индикаторы Объема:** `OBV`, `VWAP`
- **Альтернативные Осцилляторы:** `Stochastic (14, 3, 3)`

## Категория 3: Состояние Счета (Account / Portfolio State)

Этот раздел описывает **весь портфель**. LLM получает этот блок **полностью** при _каждом_ вызове, независимо от того, какая пара его инициировала.

- **Глобальные Балансы:**
  - `total_portfolio_value_usdt:` (Общая оценочная стоимость всего портфеля в USDT).
  - `available_quote_balance:` (e.g., `USDT: 10000` - свободные средства для новых сделок).

- **Активы в Портфеле (Asset Balances):**
  - Массив объектов, описывающий все, что у вас есть, _кроме_ `USDT`.
  - `assets: [ { asset: 'BTC', total: 0.5, available: 0.5 }, { asset: 'ETH', total: 10.0, available: 5.0 } ]`
  - (_`total` vs `available`_ важно, если 5.0 ETH заблокированы в ордере).

- **Текущие Открытые Позиции (Positions):**
  - Массив всех открытых позиций по _всем_ парам.
  - **Важно:** `average_entry_price` и `unrealized_pnl_percent` ДОЛЖНЫ рассчитываться "Наблюдателем" на основе _реальных_ цен исполнения и комиссий, полученных "Исполнителем" из `fetchMyTrades()` и **внутренней `TradeHistory` (БД)**.
  - **ТРЕБОВАНИЕ К РЕАЛИЗАЦИИ (Критично):** Это состояние **ДОЛЖНО** быть синхронизировано с постоянной базой данных (e.g., SQLite, таблица `ActivePositions`). Все расчеты PnL, средней цены и общей стоимости **ДОЛЖНЫ** использовать `decimal.js`.
  - `open_positions: [ { pair: 'ETH/USDT', side: 'long', amount: 5.0, average_entry_price: 1800.0, total_fee_cost: 1.80, unrealized_pnl_percent: 1.05, stop_loss_price: 1750.0 } ]`
  - (Если `open_positions: []`, значит, мы "в кэше").

- **Открытые Ордера (Orders):**
  - Массив _всех_ ожидающих ордеров (SL, TP, Limit) по _всем_ парам.
  - **ТРЕБОВАНИЕ К РЕАЛИЗАЦИИ (Критично):** Это состояние **ДОЛЖНО** быть синхронизировано с постоянной базой данных (e.g., SQLite, таблица `ActiveOrders`).
  - `open_orders: [ { id: ..., pair: 'ETH/USDT', type: 'stop_loss_limit', 'side': 'sell', price: 1750.0, amount: 5.0 } ]`

## Категория 4: Контекст и Стратегия (The "System Prompt")

Это не данные, а _инструкция_. Эту часть вы задаете сами и можете включать в каждый запрос, чтобы "напомнить" LLM о ее роли. _Отправляется_ в LLM.

- **Роль:** "Ты — профессиональный крипто-трейдер и риск-менеджер. Твоя задача — управлять портфелем в песочнице."
- **Стиль Торговли:** (Например: "Агрессивный скальпинг", "Консервативная свинг-торговля", "Торговля по тренду").
- **Управление Рисками (ОБЯЗАТЕЛЬНО):**
  - `default_risk_per_trade_percent:` (Например, 1.5%. Риск по умолчанию, который LLM должна стараться использовать).
  - `max_allowed_risk_per_trade_percent:` (Например, 3.0%. Абсолютный потолок риска на сделку, который Валидатор _никогда_ не пропустит).
  - `max_total_portfolio_risk_percent:` (Например, 10%. Запрещает открывать новые сделки, если _сумма рисков_ всех открытых позиций превысит этот лимит).
  - `desired_risk_reward_ratio:` (Например, 1:3)

- **Макро-контекст (Macro Context):**
  - Это поле **динамически заполняется "Наблюдателем"** раз в час.
  - `macro_context:`
    - `fear_and_greed_index:` (e.g., `25`)
    - `fear_and_greed_text:` (e.g., `"Extreme Fear"`)

- **Цель:** (Например: "Максимизация USDT", "Накопление BTC").

## Категория 5: Внешние Данные (External Data - V2)

Это продвинутая категория. Для начала можно обойтись без нее, но для более сложных решений она понадобится. _Опционально_.

- **Новости:** Заголовки последних 5 новостей по "BTC" или "Crypto" (требует API новостей).

## Итоговый Запрос и Формат Ответа LLM

### 1\. Пример ЗАПРОСА к LLM (Что МЫ отправляем)

    {
      "strategy_context": {
        "role": "Ты - риск-менеджер и свинг-трейдер. Твоя цель - максимизировать USDT портфеля.",
        "risk_rules": {
           "default_risk_per_trade_percent": 1.5,
           "max_allowed_risk_per_trade_percent": 3.0,
           "max_total_portfolio_risk_percent": 10.0,
           "desired_risk_reward_ratio": 3.0
        },
        "macro_context": {
          "fear_and_greed_index": 25,
          "fear_and_greed_text": "Extreme Fear"
        },
        "watchlist": ["BTC/USDT", "ETH/USDT", "SOL/USDT"]
      },
      "triggered_pair": "BTC/USDT",
      "market_data": {
        "pair": "BTC/USDT",
        "current_price": 30150.0,
        "order_book": {
          "best_bid": 30149.5,
          "best_ask": 30150.1,
          "spread": 0.6,
          "aggregated_bid_volume_0.5_percent": 15.2,
          "aggregated_ask_volume_0.5_percent": 45.8
        },
        "recent_trades": [ /* ... 20 последних сделок по BTC/USDT ... */ ],
        "watchlist_overview": [
          { "pair": "ETH/USDT", "current_price": 1818.0, "rsi_1h": 49.5 },
          { "pair": "SOL/USDT", "current_price": 22.4, "rsi_1h": 42.1 }
        ]
      },
      "technical_analysis": {
        "analysis_1h": {
          "rsi": 55.0,
          "macd_histogram": 12.5,
          /* ... прочие индикаторы для BTC/USDT ... */
          "key_levels": { "period": 100, "high": 30300, "low": 29500 }
        },
        "analysis_4h": { /* ... индикаторы 4H для BTC/USDT ... */ }
      },
      "account_state": {
        "total_portfolio_value_usdt": 19100.0,
        "available_quote_balance": 10000.0,
        "assets": [
          { "asset": "ETH", "total": 5.0, "available": 0.0 }
        ],
        "open_positions": [
          {
            "pair": "ETH/USDT",
            "side": "long",
            "amount": 5.0,
            "average_entry_price": 1800.0,
            "total_fee_cost": 1.80,
            "unrealized_pnl_percent": 1.05,
            "stop_loss_price": 1750.0
          }
        ],
        "open_orders": [
          { "id": "12345", "pair": "ETH/USDT", "type": "stop_loss_limit", "side": "sell", "price": 1750.0, "amount": 5.0 }
        ]
      },
      "question": "Триггер сработал для BTC/USDT. Рынок в 'Extreme Fear'. Проанализируй эту пару (включая order_book.aggregated_ask_volume) в контексте всего портфеля и прими решения. Твой ответ ДОЛЖЕН БЫТЬ в формате JSON..."
    }

### 2\. Пример ОЖИДАЕМОГО ОТВЕТА от LLM (Что ОНА возвращает)

    {
      "decisions": [
        {
          "action": "OPEN_LONG",
          "pair": "BTC/USDT",
          "parameters": {
            "type": "limit",
            "price": 30050.0,
            "risk_percent": 0.5,
            "stop_loss_price": 29800.0,
            "take_profit_price": 31000.0,
            "trailing_stop_config": null
          },
          "justification": "ТА показывает хороший вход, но рынок в 'Extreme Fear' (25), поэтому я захожу с УМЕНЬШЕННЫМ риском (0.5% вместо 1.5%) и с близкой целью (TP). "
        }
      ],
      "update_triggers_for_pair": "BTC/USDT",
      "next_call_triggers": {
        "reason": "Отслеживаем новый Limit-ордер по BTC и следим за перепроданностью на 1H.",
        "trigger_conditions": [
          { "type": "price", "condition": "below", "value": 30050 },
          { "type": "indicator", "name": "rsi", "timeframe": "1h", "condition": "below", "value": 30 },
          { "type": "timeout", "condition": "minutes_passed", "value": 120 }
        ]
      },
      "request_additional_data": null
    }

### 3\. Расшифровка Секции `decisions` (Приказы для Воркера)

Секция `decisions` — это _массив_ прямых приказов для "Исполнителя". "Исполнитель" должен выполнить их поочередно.

- **`"action": "HOLD"`**: Ничего не делать (часто `decisions: []`).
- **`"action": "OPEN_LONG"`** (или `OPEN_SHORT`):
  - `pair:` "BTC/USDT"
  - `parameters:`
    - `type:` (Обязательно) **`'market'`** (для входа по рынку) или **`'limit'`** (для входа по указанной цене).
    - `price:` (Обязательно для `limit`, `null` для `market`) Цена входа.
    - `risk_percent:` (Опционально) (e.g., `1.5`. Процент от `total_portfolio_value_usdt` для риска. _Если `null`, "Исполнитель" использует `default_risk_per_trade_percent` из `strategy_context`_).
    - `stop_loss_price:` (Цена _начального_ стоп-лосса. **Обязательно** для `OPEN_LONG`).
    - `take_profit_price:` (Цена тейк-профита, _может быть `null`_, если используется TSL)
    - `trailing_stop_config:` (Опционально)
      - `type:` 'percentage'
      - `distance:` (e.g., `3.0` - держать стоп на 3% ниже пиковой цены)

- **`"action": "CLOSE_POSITION"`**:
  - `pair:` "ETH/USDT"
  - `parameters:`
    - `type:` (Обязательно) `'market'` (для закрытия по рынку) или `'limit'` (для тейк-профита).
    - `amount_percent:` (e.g., `100` - закрыть 100% позиции)

- **`"action": "MODIFY_POSITION"`**:
  - `pair:` "ETH/USDT"
  - `parameters:` (`new_stop_loss_price`, `new_take_profit_price`, `new_trailing_stop_config`)

- **`"action": "CANCEL_ORDERS"`**:
  - `pair:` "ETH/USDT"
  - `parameters:` (`order_id: null` - отменить все по этой паре)

## Архитектура: "Наблюдатель" (Watcher) и "Исполнитель" (Worker)

### 1\. "Наблюдатель" (Watcher) - (Гибридная Модель WS + Цикл)

- **Задача:** Мгновенно реагировать на `price` и `TSL` (через WS) и периодически проверять `indicator` / `timeout` триггеры (через `setInterval`), вызывать LLM и передавать приказы "Исполнителю".
- **Конфигурация (в памяти):**

      const watchlist = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];

      // Подключение к постоянной БД (критически важно)
      let db; // (e.g., new Database('trading_bot.sqlite') используя better-sqlite3)

      let triggerMap = { /* ... как в примере ... */ }; // ЗАГРУЖАЕТСЯ ИЗ БД ПРИ СТАРТЕ
      let requestedDataMap = { /* ... */ }; // ЗАГРУЖАЕТСЯ ИЗ БД ПРИ СТАРТЕ

      // Хранилище правил TSL. ЗАГРУЖАЕТСЯ ИЗ БД ПРИ СТАРТЕ.
      let trailingStopRules = {
        // 'BTC/USDT': {
        //    rule: { type: 'percentage', distance: 3.0 },
        //    position: { amount: 0.5, side: 'long' },
        //    state: { currentStopPrice: 29800, highestPrice: 30150, currentStopOrderId: '12345' }
        // }
      };

      // Глобальное состояние (кэш). Обновляется в "Медленном Цикле"
      let globalAccountState = {};

      // Глобальный макро-контекст. Обновляется раз в час.
      let globalMacroContext = { fear_and_greed_index: 50, fear_and_greed_text: "Neutral" };

      // Правила биржи (minNotional, fees).
      let exchangeRules = {}; // e.g. { 'BTC/USDT': { minNotional: 10, takerFee: 0.001 } }

      let isCallingLLM = { /* ... */ };

- **Логика работы (Разделена на 4 части):**

  **(A) Инициализация (Запускается 1 раз):**
  1.  **Подключиться к БД (Критично):** `db = new Database(...)`. Создать таблицы (`ActivePositions`, `ActiveOrders`, `TSL_State`, `LLM_Triggers`, `TradeHistory`), если они не существуют.
  2.  **Загрузить Состояние из БД (Критично):**
      - `triggerMap` и `requestedDataMap` загружаются из `LLM_Triggers`.
      - `trailingStopRules = db.prepare('SELECT * FROM TSL_State').all()` (преобразовать в `Map`).

  3.  **Загрузить правила биржи:**
      - `exchangeRules = await loadExchangeRules(watchlist);` (Это _одноразовая_ функция, которая вызывает `ccxt.loadMarkets()` и извлекает `limits.cost.min` (`minNotional`) и `taker` (комиссия) для каждой пары в `watchlist`).

  **(A.1) Критическая Синхронизация Состояния (Boot Sequence):**
  - **Цель:** Убедиться, что наше сохраненное состояние в БД (`ActivePositions`, `ActiveOrders`) соответствует _реальному_ состоянию на бирже. Это предотвращает "ордера-зомби" и "потерянные позиции" после сбоя или перезапуска.
  - **Шаг 1: Получить реальное состояние с Биржи**
    - `const exchangePositions = await ccxt.fetchOpenPositions();`
    - `const exchangeOrders = await ccxt.fetchOpenOrders();`

  - **Шаг 2: Получить сохраненное состояние из БД**
    - `const dbPositions = db.prepare('SELECT * FROM ActivePositions').all();`
    - `const dbOrders = db.prepare('SELECT * FROM ActiveOrders').all();`

  - **Шаг 3: Сверка Позиций (Логика "Сверки")**
    - **Сценарий 1: Позиция на Бирже ЕСТЬ, в БД — НЕТ.**
      - _Причина:_ Сбой после `createOrder`, но _до_ `db.transaction.run()`, ИЛИ позиция открыта вручную.
      - _Действие:_ `WARN: "Обнаружена неуправляемая позиция по [pair]!"`. **(Рекомендуется):** Создать запись в `ActivePositions` и `TSL_State` (с "пустым" правилом), чтобы бот _хотя бы_ отслеживал ее PnL, даже если не будет ею управлять.

    - **Сценарий 2: Позиция в БД ЕСТЬ, на Бирже — НЕТ.**
      - _Причина:_ SL/TP сработал, пока бот был в офлайне.
      - _Действие:_ `INFO: "Позиция по [pair] была закрыта офлайн"`. Выполнить транзакцию по очистке: `DELETE FROM ActivePositions WHERE pair = ?`, `DELETE FROM ActiveOrders WHERE pair = ?`, `DELETE FROM TSL_State WHERE pair = ?`.

  - **Шаг 4: Сверка Ордеров (Логика "Сверки")**
    - **Сценарий 3: Ордер на Бирже ЕСТЬ, в БД — НЕТ.**
      - _Причина:_ "Ордер-зомби" от предыдущего сбоя (например, TSL не был отменен, а позиция закрылась).
      - _Действие:_ `WARN: "Обнаружен ордер-зомби [id] по [pair]!"`. **Немедленно отменить:** `await ccxt.cancelOrder(order.id, order.symbol)`.

    - **Сценарий 4: Ордер в БД ЕСТЬ, на Бирже — НЕТ.**
      - _Причина:_ Ордер (Limit, SL, TP) исполнился, пока бот был в офлайне.
      - _Действие:_ `INFO: "Ордер [id] по [pair] исполнился офлайн"`. **Действие:** Удалить ордер из `ActiveOrders` в БД.

  - _(Только после этой полной сверки можно продолжать)_

  **(A.2) Запуск Циклов:** 4. **Подписка на WebSocket:** \* Использовать `ccxt.watchTickers(watchlist)`. \* Назначить обработчик `onTickerData(ticker)` на получение данных. 5. **Запуск "Медленного Цикла":** \* `setInterval(checkIndicatorsAndOhlcv, 60000);` (Запускать `checkIndicatorsAndOhlcv` раз в 60 секунд). 6. **Запуск "Макро-Цикла":** \* `setInterval(updateMacroContext, 3600000);` // (Запускать `updateMacroContext` раз в 1 час) 7. Запустить `checkIndicatorsAndOhlcv()` и `updateMacroContext()` _один раз при старте_, чтобы заполнить `globalAccountState` и `globalMacroContext`.

  **(Б) Обработчик WebSocket (`async function onTickerData(ticker)`):**
  - **Задача №1: Обработка Trailing Stop Loss (TSL)**
    1.  `const { symbol: pair, last: current_price } = ticker;`
    2.  `const tsl = trailingStopRules[pair];`
    3.  `if (tsl && tsl.position.side === 'long' && current_price > tsl.state.highestPrice)`: a. `tsl.state.highestPrice = current_price;` b. `const newStopPrice = current_price * (1 - tsl.rule.distance / 100);` c. `if (newStopPrice > tsl.state.currentStopPrice)`: i. `console.log(`TSL UPDATE for ${pair}: Moving SL to ${newStopPrice}`);` ii. `try {` iii. `await binance.cancelOrder(tsl.state.currentStopOrderId, pair);` iv. `const newOrder = await binance.createOrder(pair, 'STOP_LOSS_LIMIT', 'sell', tsl.position.amount, newStopPrice, ...);` v. `tsl.state.currentStopPrice = newStopPrice;` vi. `tsl.state.currentStopOrderId = newOrder.id;` vii. `// КРИТИЧНО: немедленно сохранить это новое состояние в БД.` viii. `db.prepare('UPDATE TSL_State SET currentStopPrice = ?, highestPrice = ?, currentStopOrderId = ? WHERE pair = ?').run(newStopPrice, current_price, newOrder.id, pair);` ix. `} catch (e) { console.error('TSL Update Failed!', e); }`
    4.  `(Аналогичная логика для 'short' позиции, если current_price < tsl.state.lowestPrice)`

    **ТРЕБОВАНИЕ К РЕАЛИЗАЦИИ:** Все сравнения цен (`newStopPrice > tsl.state.currentStopPrice`) и расчеты (`* (1 - tsl.rule.distance / 100)`) **ДОЛЖНЫ** использовать библиотеку `decimal.js` для избежания ошибок с плавающей запятой.

  - **Задача №2: Проверка Price-триггеров** 5. `if (isCallingLLM[pair]) return;` // Игнорировать, если уже в процессе вызова 6. `const triggers = triggerMap[pair];` 7. `const priceTrigger = triggers.find(t => t.type === 'price' && ... (price condition matches) ...);` 8. **Если `priceTrigger` сработал:** \* `await executeLLMCall(pair, 'Price Trigger Hit');`

  **(В) Медленный Цикл (`async function checkIndicatorsAndOhlcv()`):**
  1.  **Обновить `globalAccountState`:**
      - `globalAccountState = await fetchFullAccountState();` (Функция, которая делает `fetchBalance`, `fetchOpenPositions`, `fetchOpenOrders`).
      - **Синхронизация `trailingStopRules`:** Проверить, что все TSL-правила в `trailingStopRules` соответствуют открытым позициям в `globalAccountState`. Если позиция закрыта (а бот это "проспал"), удалить TSL-правило из `trailingStopRules` (в памяти) и из `TSL_State` (в БД).

  2.  `for (const pair of watchlist)`
      - (Логика проверки `timeout` и `indicator` триггеров...)

  **(Г) Обновление Макро-Контекста (`async function updateMacroContext()`)**
  1.  `console.log('Fetching Fear & Greed Index...');`
  2.  `try {`
  3.  `// Используем API от alternative.me (требует 'node-fetch' или 'axios')`
  4.  `const response = await fetch('https://api.alternative.me/fng/?limit=1');`
  5.  `const data = await response.json();`
  6.  `globalMacroContext.fear_and_greed_index = parseInt(data.data[0].value, 10);`
  7.  `globalMacroContext.fear_and_greed_text = data.data[0].value_classification;`
  8.  `console.log('Macro Context Updated:', globalMacroContext);`
  9.  `} catch (e) { console.error('Failed to fetch F&G Index', e); }`

  **(Д) Основная Функция Вызова LLM (`async function executeLLMCall(pair, reason)`):**
  1.  ... (Логика блокировки) ...
  2.  **Подготовка данных:**
      - ... (Расчет ТА, `watchlist_overview` и т.д.) ...
      - **Получить** Глобальный Портфель:
        - `const account_state = globalAccountState;` (Взять свежие данные из "Медленного Цикла").

      - **Сформировать** `strategy_context`:
        - `const strategy_context = { ...static_rules, macro_context: globalMacroContext };`

  3.  ... (Собрать итоговый JSON, Отправить JSON в LLM, получить ответ) ...
  4.  **Обновить `triggerMap` и `requestedDataMap` (в памяти и в БД).**
      - `triggerMap[response.update_triggers_for_pair] = response.next_call_triggers.trigger_conditions;`
      - `requestedDataMap[response.update_triggers_for_pair] = response.request_additional_data;`
      - **Сохраняем обновленные данные в БД (атомарно - REPLACE/UPSERT)**
      - `db.prepare('INSERT INTO LLM_Triggers (pair, triggers_json, requested_data_json) VALUES (?, ?, ?) ON CONFLICT(pair) DO UPDATE SET triggers_json = excluded.triggers_json, requested_data_json = excluded.requested_data_json')`
        - `.run(`
        - `response.update_triggers_for_pair,`
        - `JSON.stringify(response.next_call_triggers.trigger_conditions),`
        - `JSON.stringify(response.request_additional_data)`
        - `);`

  5.  **Передать приказы Исполнителю:**
      - `for (const decision of response.decisions) {`
      - `const rules = exchangeRules[decision.pair] || {};` // Получить правила для этой пары
      - `await worker.execute(decision, globalAccountState, strategy_context, market_data, rules);`
      - `}`

  6.  ... (Логика разблокировки) ...

### 2\. "Исполнитель" (Worker) - с Модулем Валидации

- **Задача:** Валидировать и выполнять _один_ торговый приказ, **записывая реальный результат в БД (внутри транзакции)**.
- **ТРЕБОВАНИЕ К РЕАЛИЗАЦИИ:** "Исполнитель" и вызываемый им "Валидатор" — самые критичные к математике части системы. **Все** операции с ценами, суммами и процентами **ДОЛЖНЫ** использовать `decimal.js` для обеспечения точности и избежания ошибок с плавающей запятой.
- **Логика работы (активируется "Наблюдателем" в цикле):**
  1.  Получает `decision`, `account_state`, `strategy_context`, `market_data` и `exchange_rules`.
  2.  **(Шаг 0) Валидация:**

          let validationResult;
          try {
            // Валидатор также возвращает рассчитанный размер
            validationResult = Validator.validateDecision(decision, account_state, strategy_context, market_data, exchange_rules);
          } catch (error) {
            // Если валидация не пройдена, логируем ошибку и НЕ исполняем приказ
            console.error(`[Validation Failed] ${error.message}. Decision rejected: ${JSON.stringify(decision)}`);
            return; // Стоп!
          }

  3.  **(Шаг 1)** Извлекает `pair` и `parameters` из `decision`.
  4.  **(Шаг 2)** Использует `switch (decision.action)` для определения действия.

#### **Пример (`case "OPEN_LONG"`):**

- **Критично:** Вся логика `OPEN_LONG` должна быть обернута в **Транзакцию БД**.

а. **Расчеты:**

- `const { amount_coin, amount_usd } = validationResult;` б. **Отправка Ордера:**
- (Логика `createMarketBuyOrder` или `createLimitBuyOrder`) в. **Ожидание Исполнения (Критически Важно!):**
- ... (Логика `waitForOrderExecution`) ... г. **Получение Реальной Цены (fetchMyTrades):**
- (Логика: `realEntryPrice`, `realFee`, `realAmount`) д. **Установка** _**Начального**_ **SL/TP:**
- `let initialStopOrder;`
- `let takeProfitOrder;`
- (Логика `createOrder` для `STOP_LOSS_LIMIT` и `TAKE_PROFIT_LIMIT`) е. **Сохранение Состояния (Транзакция):**
- `const dbTransaction = db.transaction(() => {`
- `// 1. Сохранить Позицию`
- `db.prepare('INSERT INTO ActivePositions (...) VALUES (...)').run(pair, 'long', realAmount, realEntryPrice, ...);`
- `// 2. Сохранить Ордера SL/TP`
- `if (initialStopOrder) { db.prepare('INSERT INTO ActiveOrders (...)').run(initialStopOrder.id, pair, 'stop_loss', ...); }`
- `if (takeProfitOrder) { db.prepare('INSERT INTO ActiveOrders (...)').run(takeProfitOrder.id, pair, 'take_profit', ...); }`
- `// 3. Сохранить Правило TSL (если есть)`
- `if (params.trailing_stop_config && initialStopOrder) {`
- `db.prepare('INSERT INTO TSL_State (...)').run(pair, 'long', realAmount, params.stop_loss_price, realEntryPrice, initialStopOrder.id);`
- `// 4. Записать в 'TradeHistory' (Журнал Сделок)`
- `db.prepare('INSERT INTO TradeHistory (timestamp, pair, side, amount, price, fee_cost) VALUES (?, ?, ?, ?, ?, ?)')`
  - `.run(Date.now(), pair, 'long', realAmount, realEntryPrice, realFee);`

- `});`
- `dbTransaction.run();` ж. **Обновление Кэша:**
- (Обновить `trailingStopRules` и `globalAccountState` в памяти).

#### Пример (`case "CLOSE_POSITION"`):

- **Критично:** Вся логика `CLOSE_POSITION` (включая очистку ордеров) должна быть обернута в **Транзакцию БД**.

а. **Извлечение данных:** `const pair = decision.pair;`

б. **Закрытие позиции (Market):**

- (Логика `createMarketSellOrder` для `amount`, соответствующего позиции)

в. **Ожидание Исполнения и Получение PnL:**

- (Логика `fetchMyTrades` для `closeAmount`, `closePrice`, `closeFee` и расчета итоговой прибыли/убытка).
- **Важно:** Убедиться, что позиция действительно закрыта, получив реальные данные о сделках.

г. **Сохранение Состояния и Очистка (Атомарная Транзакция):**

- `const dbTransaction = db.transaction(() => {`
- `// 1. (Опционально, но рекомендуется) Отменить "осиротевшие" ордера SL/TP`
- `// await binance.cancelAllOrders(pair); // ВАЖНО: Делается ПОСЛЕ закрытия, а не до.`
- `// 2. Удалить Позицию`
- `db.prepare('DELETE FROM ActivePositions WHERE pair = ?').run(pair);`
- `// 3. Удалить Ордера SL/TP из нашей БД`
- `db.prepare('DELETE FROM ActiveOrders WHERE pair = ?').run(pair);`
- `// 4. Удалить Правило TSL`
- `db.prepare('DELETE FROM TSL_State WHERE pair = ?').run(pair);`
- `// 5. Записать итоговую сделку в 'TradeHistory' (Журнал Сделок)`
- `db.prepare('INSERT INTO TradeHistory (timestamp, pair, side, amount, price, fee_cost) VALUES (?, ?, ?, ?, ?, ?)')`
  - `.run(Date.now(), pair, 'sell', closeAmount, closePrice, closeFee);`

- `});`
- `dbTransaction.run();`

д. **Обновление Кэша:**

- (Удалить `trailingStopRules[pair]` и обновить `globalAccountState` в памяти).

### 2.1. Модуль Валидации (Validator) - Техзадание

Это техзадание для разработчика `node.js` по созданию модуля `Validator`. Это простой класс или объект с функцией `validateDecision(decision, account_state, strategy_context, market_data, exchange_rules)`.

**ВАЖНОЕ ТРЕБОВАНИЕ К РЕАЛИЗАЦИИ:** Во избежание ошибок с плавающей запятой (например, `0.1 + 0.2 != 0.3`), все без исключения расчеты и сравнения в этом модуле (цены, суммы, проценты) **ДОЛЖНЫ** выполняться с использованием библиотеки для десятичной арифметики (например, `decimal.js`). **ЗАПРЕЩЕНО** использовать нативный тип `Number` для финансовых вычислений. Все примеры кода в `Проверках Риска` (ниже) должны быть реализованы с учетом этого.

Он должен проверять следующее и **выбрасывать (throw) ошибку**, если проверка не пройдена. **Если проверка пройдена,** он **возвращает** объект `{ amount_coin, amount_usd, usd_at_risk }`.

#### 1\. Проверки "Здравого Смысла" (Sanity Checks)

- `if (!decision.pair)` -> `throw new Error("Pair not specified")`
- `if (decision.action === 'OPEN_LONG' && !decision.parameters.stop_loss_price)` -> `throw new Error("OPEN_LONG action requires a 'stop_loss_price'")`
- `if (decision.action === 'OPEN_LONG')`:
  - `if (!decision.parameters.type)` -> `throw new Error("Order type (market/limit) not specified")`
  - `if (decision.parameters.type === 'limit' && !decision.parameters.price)` -> `throw new Error("Limit order must have a price")`

- `if (decision.action === 'CLOSE_POSITION')`:
  - `if (decision.parameters.amount_percent <= 0 || decision.parameters.amount_percent > 100)` -> `throw new Error("Close Amount percent is invalid")`
  - `if (!account_state.open_positions.find(p => p.pair === decision.pair))` -> `throw new Error("Attempt to close position that does not exist")`

- `if (decision.parameters.trailing_stop_config && !decision.parameters.stop_loss_price)` -> `throw new Error("Trailing Stop (TSL) requires an initial 'stop_loss_price' to be set.")`

#### 2\. Проверки Логики SL/TP (SL/TP Logic Checks)

- `const current_price = market_data.current_price;`
- `if (decision.action === 'OPEN_LONG')`:
  - `const entry_price = (decision.parameters.price || current_price);`
  - `if (decision.parameters.stop_loss_price >= entry_price)` -> `throw new Error("Long Stop Loss is above or at entry price")`
  - `if (decision.parameters.take_profit_price && (decision.parameters.take_profit_price <= entry_price))` -> `throw new Error("Long Take Profit is below or at entry price")`
  - `if (decision.parameters.take_profit_price && (decision.parameters.stop_loss_price >= decision.parameters.take_profit_price))` -> `throw new Error("Long Stop Loss is above Take Profit")`
  - `if (decision.parameters.type === 'limit' && decision.parameters.price > current_price)` -> `throw new Error("Limit Buy price is above current price (will execute as Taker)")`

- **Для `OPEN_SHORT`:** (Аналогичные проверки...)

#### 3\. Проверки Риска и Расчет Размера

- `if (decision.action !== 'OPEN_LONG' && decision.action !== 'OPEN_SHORT') { return; }` // Эти проверки только для открытия
- `const rules = strategy_context.risk_rules;`
- `const total_value = account_state.total_portfolio_value_usdt;`
- `const risk_percent_to_use = decision.parameters.risk_percent || rules.default_risk_per_trade_percent;`
- `if (risk_percent_to_use > rules.max_allowed_risk_per_trade_percent)` -> `throw new Error(`Risk percent ${risk_percent_to_use}% exceeds max allowed ${rules.max_allowed_risk_per_trade_percent}%`)`
- **Расчет размера позиции (Volatility-Based Position Sizing):**
  - `const usd_at_risk = total_value * (risk_percent_to_use / 100);`
  - `const entry_price = (decision.parameters.price || market_data.current_price);`
  - `const stop_price = decision.parameters.stop_loss_price;`
  - `const distance_to_stop_usd_per_coin = Math.abs(entry_price - stop_price);`
  - `if (distance_to_stop_usd_per_coin === 0)` -> `throw new Error("Entry price and Stop Loss price are identical")`
  - `const amount_coin = usd_at_risk / distance_to_stop_usd_per_coin;`
  - `const amount_usd = amount_coin * entry_price;`

- **Проверка Общего Риска Портфеля:**
  - `let total_current_risk_percent = 0;`
  - `for (const pos of account_state.open_positions)`
    - `const pos_risk_usd = Math.abs(pos.average_entry_price - pos.stop_loss_price) * pos.amount;`
    - `total_current_risk_percent += (pos_risk_usd / total_value) * 100;`

  - `const new_trade_risk_percent = (usd_at_risk / total_value) * 100;`
  - `if (total_current_risk_percent + new_trade_risk_percent > rules.max_total_portfolio_risk_percent)` -> `throw new Error("This trade exceeds max_total_portfolio_risk_percent")`

- **Проверка Доступного Баланса:**
  - `if (amount_usd > account_state.available_quote_balance)` -> `throw new Error(`Calculated order cost $${amount\_usd} exceeds available balance $${account_state.available_quote_balance}`)`

- **Возвращаем рассчитанные значения для Исполнителя:**
  - `const validationResult = { amount_coin, amount_usd, usd_at_risk };`

#### 4\. Проверки Исполнимости (Биржа и Комиссии)

- `const minNotional = exchange_rules.minNotional || 10.0;` // (например, $10)
- `const takerFee = exchange_rules.takerFee || 0.001;` // (например, 0.1%)
- `const { amount_usd, usd_at_risk } = validationResult;`
- **Проверка Минимального Размера Ордера:**
  - `if (amount_usd < minNotional)` -> `throw new Error(`Calculated order value $${amount\_usd.toFixed(2)} is below exchange minimum $${minNotional}. Risk % or Stop Distance is too small.`)`

- **Проверка Комиссии против Риска:**
  - `const round_trip_fee_usd = (amount_usd * takerFee) * 2;` // (Комиссия за вход и выход)
  - `if (usd_at_risk < round_trip_fee_usd)` -> `throw new Error(`Potential loss (risk) $${usd\_at\_risk.toFixed(2)} is less than estimated round-trip fee $${round_trip_fee_usd.toFixed(2)}. Trade is not profitable.`)`

- **Все проверки пройдены:**
  - `return validationResult;`

# Приложение А: Техзадание для "Наблюдателя" (Базовый Пакет)

## Тема: Расчет и Интерпретация Параметров для LLM

**ТРЕБОВАНИЕ К РЕАЛИЗАЦИИ:** Все расчеты индикаторов, возвращающие `float` (EMA, RSI, MACD и т.д.), **ДОЛЖНЫ** использовать библиотеку `decimal.js` для обеспечения точности, либо их результат должен быть немедленно преобразован в `Decimal` перед использованием в других расчетах (например, в Валидаторе).

**Инструменты:** `technicalindicators` (NPM-пакет). **Исходные данные:** Массив цен закрытия `closePrices = ohlcv_data.map(k => k.close)`.

### 1\. EMA (Exponential Moving Average)

- **Параметры:** `ema_50`, `ema_200`
- **Расчет (npm: `technicalindicators`):**

      const { EMA } = require('technicalindicators');
      const ema50 = EMA.calculate({period : 50, values : closePrices});
      const ema200 = EMA.calculate({period : 200, values : closePrices});
      // Берем последнее значение из массива:
      const last_ema50 = ema50[ema50.length - 1];
      const last_ema200 = ema200[ema200.length - 1];

- **Что это говорит LLM (Интерпретация):**
  - **`ema_50`:** Среднесрочный тренд.
  - **`ema_200`:** Долгосрочный тренд.
  - **Логика:**
    - `current_price > ema_50` и `ema_50 > ema_200` = "Сильный бычий (восходящий) тренд".
    - `current_price < ema_50` и `ema_50 < ema_200` = "Сильный медвежий (нисходящий) тренд".

### 2\. RSI (Relative Strength Index)

- **Параметр:** `rsi` (период 14)
- **Расчет (npm: `technicalindicators`):**

      const { RSI } = require('technicalindicators');
      const rsi = RSI.calculate({period : 14, values : closePrices});
      const last_rsi = rsi[rsi.length - 1];

- **Что это говорит LLM (Интерпретация):**
  - **Логика:** Показывает "импульс" или "силу" рынка (0-100).
    - `rsi > 70` = "Рынок ПЕРЕКУПЛЕН" (возможен разворот вниз).
    - `rsi < 30` = "Рынок ПЕРЕПРОДАН" (возможен отскок вверх).

### 3\. MACD (Moving Average Convergence Divergence)

- **Параметр:** `macd_histogram` (периоды 12, 26, 9)
- **Расчет (npm: `technicalindicators`):**

      const { MACD } = require('technicalindicators');
      const macdInput = { values: closePrices, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 };
      const macd = MACD.calculate(macdInput);
      // Нас интересует ТОЛЬКО гистограмма
      const last_macd_hist = macd[macd.length - 1].histogram;

- **Что это говорит LLM (Интерпретация):**
  - **Логика:** Гистограмма показывает _ускорение_ тренда.
    - `histogram > 0` и _растет_: "Бычий тренд УСКОРЯЕТСЯ".
    - `histogram < 0` и _падает_: "Медвежий тренд УСКОРЯЕТСЯ".
    - Пересечение 0 = возможная смена тренда.

### 4\. Bollinger Bands (Полосы Боллинджера)

- **Параметры:** `bollinger: { upper, middle, lower }` (период 20, отклонение 2)
- **Расчет (npm: `technicalindicators`):**

      const { BollingerBands } = require('technicalindicators');
      const bbInput = { period: 20, values: closePrices, stdDev: 2 };
      const bb = BollingerBands.calculate(bbInput);
      const last_bb = bb[bb.length - 1]; // { upper: ..., middle: ..., lower: ... }

- **Что это говорит LLM (Интерпретация):**
  - **Логика:** Показывает "коридор" волатильности.
    - `upper` и `lower` далеко друг от друга: "Высокая волатильность".
    - `upper` и `lower` близко: "Низкая волатильность, рынок 'сжался'".
    - `upper` / `lower` — это динамические цели.

### 5\. Key Levels (Ключевые Уровни)

- **Параметры:** `key_levels: { period, high, low }`
- **Расчет (Чистый JS):**

      const period = 100; // N последних свечей
      const relevantCandles = ohlcv_data.slice(-period);
      const highs = relevantCandles.map(k => k.high);
      const lows = relevantCandles.map(k => k.low);
      const key_levels = {
        period: period,
        high: Math.max(...highs),
        low: Math.min(...lows)
      };

- **Что это говорит LLM (Интерпретация):**
  - **Логика:** Это самые очевидные уровни "поддержки" и "сопротивления".
    - `high`: "Потолок".
    - `low`: "Пол".

  - **Задача LLM:** Использовать их для SL/TP или для входа на "пробой" / "отскок".

# Приложение Б: Техзадание для "Наблюдателя" (Расширенный Пакет)

## Тема: Расчет Дополнительных (On-Demand) Индикаторов

**ТРЕБОВАНИЕ К РЕАЛИЗАЦИИ:** Аналогично Приложению А, все расчеты индикаторов (ADX, ATR и т.д.) **ДОЛЖНЫ** использовать библиотеку `decimal.js` для обеспечения точности.

**Инструменты:** `technicalindicators` (NPM-пакет), `tulind` (NPM-пакет, часто быстрее). **Исходные данные:** Полные `ohlcv_data` (массив `[ {open, high, low, close, volume} ]`).

### 1\. ADX (Average Directional Index)

- **Запрос LLM:** `"ADX_1h"`
- **Расчет (npm: `technicalindicators`):**

      const { ADX } = require('technicalindicators');
      // ADX требует high, low, close, а не только close
      const adxInput = {
        high: ohlcv_data.map(k => k.high),
        low: ohlcv_data.map(k => k.low),
        close: ohlcv_data.map(k => k.close),
        period: 14
      };
      const adxResult = ADX.calculate(adxInput);
      const last_adx = adxResult[adxResult.length - 1].adx;
      // { adx: ..., pdi: ..., mdi: ... } - берем только adx

- **Зачем это Модели (Интерпретация):**
  - **Проблема:** "Базовый Пакет" (EMA, MACD) показывает _направление_ тренда, но не его _силу_.
  - **Решение:** ADX — это "измеритель силы тренда" (от 0 до 100).
    - `ADX < 20`: **Нет тренда (флэт).** Модель будет игнорировать сигналы EMA/MACD.
    - `ADX > 25`: **Есть тренд.** Модель будет доверять EMA/MACD.

### 2\. ATR (Average True Range)

- **Запрос LLM:** `"ATR_4h"`
- **Расчет (npm: `technicalindicators`):**

      const { ATR } = require('technicalindicators');
      const atrInput = {
        high: ohlcv_data.map(k => k.high),
        low: ohlcv_data.map(k => k.low),
        close: ohlcv_data.map(k => k.close),
        period: 14
      };
      const atrResult = ATR.calculate(atrInput);
      const last_atr = atrResult[atrResult.length - 1];

- **Зачем это Модели (Интерпретация):**
  - **Проблема:** LLM должна указать `stop_loss_price`. Как его выбрать?
  - **Решение:** ATR — это _показатель волатильности в $_.
  - **Задача LLM:** Модель будет использовать `ATR` для установки _динамического_ стоп-лосса.
    - `stop_loss_price = average_entry_price - (last_atr * 1.5)` (вместо фиксированного уровня).

### 3\. OBV (On-Balance Volume)

- **Запрос LLM:** `"OBV_1h"`
- **Расчет (npm: `technicalindicators`):**

      const { OBV } = require('technicalindicators');
      const obvInput = {
        close: ohlcv_data.map(k => k.close),
        volume: ohlcv_data.map(k => k.volume)
      };
      const obvResult = OBV.calculate(obvInput);
      const last_obv = obvResult[obvResult.length - 1];

- **Зачем это Модели (Интерпретация):**
  - **Проблема:** Цена растет, но на каких объемах?
  - **Решение:** OBV связывает цену и объем.
  - **Задача LLM:** Модель будет искать _дивергенции_ (расхождения):
    - "Цена (`key_levels.high`) делает новый максимум, а `OBV` — нет". ЭТО СИГНАЛ К ПРОДАЖЕ (Short).
    - "Цена делает новый минимум, а `OBV` — нет". ЭТО СИГНАЛ К ПОКУПКЕ (Long).

### 4\. VWAP (Volume-Weighted Average Price)

- **Запрос LLM:** `"VWAP_1h"`
- **Расчет (npm: `technicalindicators`):**

      const { VWAP } = require('technicalindicators');
      const vwapInput = {
        open: ohlcv_data.map(k => k.open),
        high: ohlcv_data.map(k => k.high),
        low: ohlcv_data.map(k => k.low),
        close: ohlcv_data.map(k => k.close),
        volume: ohlcv_data.map(k => k.volume)
      };
      const vwapResult = VWAP.calculate(vwapInput);
      const last_vwap = vwapResult[vwapResult.length - 1];

- **Зачем это Модели (Интерпретация):**
  - **Проблема:** EMA — это средняя цена по _времени_. VWAP — по _объему_.
  - **Решение:** VWAP — это "справедливая" цена, которую видят "умные деньги".
  - **Задача LLM:**
    - `current_price > last_vwap`: "Покупатели в выигрыше" (Бычий сигнал).
    - `current_price < last_vwap`: "Продавцы в выигрыше" (Медвежий сигнал).

### 5\. Stochastic Oscillator (Стохастик)

- **Запрос LLM:** `"Stochastic_15m"`
- **Расчет (npm: `technicalindicators`):**

      const { Stochastic } = require('technicalindicators');
      const stochInput = {
        high: ohlcv_data.map(k => k.high),
        low: ohlcv_data.map(k => k.low),
        close: ohlcv_data.map(k => k.close),
        period: 14,
        signalPeriod: 3
      };
      const stochResult = Stochastic.calculate(stochInput);
      const last_stoch = stochResult[stochResult.length - 1]; // { k: ..., d: ... }

- **Зачем это Модели (Интерпретация):**
  - **Проблема:** RSI (из "Базового Пакета") стал "шумным".
  - **Решение:** Стохастик — альтернативный осциллятор.
  - **Задача LLM:** Искать _пересечения_ линий K и D в зонах перекупленности (>80) / перепроданности (<20).
