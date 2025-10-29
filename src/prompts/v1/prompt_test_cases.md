# Тест-Кейсы для Промптов V1

Этот документ содержит набор сценариев для ручного тестирования промптов. Каждый тест-кейс включает:
- Описание ситуации
- Пример JSON-входа (ключевые части)
- Ожидаемый `justification` (логика)
- Ожидаемый `decisions` (действие)

## Тест-кейс 1: "Контр-тренд на перепроданности" (Long)

**Сценарий:** Рынок в панике, BTC сильно упал и достиг ключевого уровня поддержки. RSI показывает глубокую перепроданность. Fear & Greed Index в зоне "Extreme Fear".

**Пример JSON-входа (Ключевые части):**

```json
{
  "strategy_context": {
    "role": "Профессиональный риск-менеджер и помощник трейдера",
    "style": "Консервативный свинг-трейдинг",
    "risk_rules": {
      "default_risk_per_trade_percent": 1.5,
      "max_allowed_risk_per_trade_percent": 2.0,
      "max_total_portfolio_risk_percent": 10.0,
      "desired_risk_reward_ratio": 2.0
    },
    "macro_context": {
      "fear_and_greed_text": "Extreme Fear",
      "fear_and_greed_index": 25
    },
    "watchlist": ["BTC/USDT", "ETH/USDT"]
  },
  "triggered_pair": "BTC/USDT",
  "technical_analysis": {
    "analysis_4h": {
      "rsi": 25.5,
      "key_levels": {
        "period": 100,
        "high": 31000,
        "low": 29800
      }
    },
    "analysis_1h": {
      "rsi": 28.0
    }
  },
  "market_data": {
    "pair": "BTC/USDT",
    "current_price": 29850,
    "order_book": {
      "best_bid": 29849,
      "best_ask": 29851,
      "spread": 2
    }
  },
  "account_state": {
    "total_portfolio_value_usdt": 10000,
    "available_quote_balance": 10000,
    "open_positions": [],
    "open_orders": []
  }
}
```

**Ожидаемый `justification` (Логика):**

"Рынок в 'Extreme Fear' (25), RSI на 4H перепродан (25.5) и цена находится у `key_levels.low` (29800). Это сильный сигнал к покупке на отскок. Так как портфель пуст и мы находимся в экстремальной ситуации, я вхожу с уменьшенным риском 0.5% вместо стандартного 1.5%, чтобы защитить капитал. EMA_200 находится выше текущей цены на старшем таймфрейме, что подтверждает медвежий тренд, но в зоне перепроданности возможен краткосрочный отскок."

**Ожидаемый `decisions` (Действие):**

```json
{
  "decisions": [
    {
      "action": "OPEN_LONG",
      "pair": "BTC/USDT",
      "parameters": {
        "type": "limit",
        "price": 29900.0,
        "risk_percent": 0.5,
        "stop_loss_price": 29450.0,
        "take_profit_price": 30800.0,
        "trailing_stop_config": null
      },
      "justification": "Рынок в 'Extreme Fear' (25), RSI на 4H перепродан (25.5) и цена находится у key_levels.low (29800). Это сильный сигнал к покупке на отскок. Так как портфель пуст и мы находимся в экстремальной ситуации, я вхожу с уменьшенным риском 0.5% вместо стандартного 1.5%, чтобы защитить капитал."
    }
  ],
  "update_triggers_for_pair": "BTC/USDT",
  "next_call_triggers": {
    "reason": "Отслеживаем новый Limit-ордер по BTC и следим за движением цены.",
    "trigger_conditions": [
      { "type": "price", "condition": "below", "value": 29900 },
      { "type": "indicator", "name": "rsi", "timeframe": "1h", "condition": "above", "value": 70 }
    ]
  },
  "request_additional_data": null
}
```

## Тест-кейс 2: "Флэт / Нет тренда" (Hold)

**Сценарий:** Рынок "скучный", цена в середине диапазона, нет четких сигналов для входа. Индикаторы показывают нейтральное состояние.

**Пример JSON-входа (Ключевые части):**

```json
{
  "strategy_context": {
    "role": "Профессиональный риск-менеджер и помощник трейдера",
    "style": "Консервативный свинг-трейдинг",
    "risk_rules": {
      "default_risk_per_trade_percent": 1.5,
      "max_allowed_risk_per_trade_percent": 2.0,
      "max_total_portfolio_risk_percent": 10.0,
      "desired_risk_reward_ratio": 2.0
    },
    "macro_context": {
      "fear_and_greed_text": "Neutral",
      "fear_and_greed_index": 50
    },
    "watchlist": ["BTC/USDT", "ETH/USDT"]
  },
  "triggered_pair": "BTC/USDT",
  "technical_analysis": {
    "analysis_4h": {
      "rsi": 52.0,
      "key_levels": {
        "period": 100,
        "high": 31000,
        "low": 29800
      }
    },
    "analysis_1h": {
      "rsi": 48.0
    }
  },
  "market_data": {
    "pair": "BTC/USDT",
    "current_price": 30100,
    "order_book": {
      "best_bid": 30099,
      "best_ask": 30101,
      "spread": 2
    }
  },
  "account_state": {
    "total_portfolio_value_usdt": 10000,
    "available_quote_balance": 10000,
    "open_positions": [],
    "open_orders": []
  }
}
```

**Ожидаемый `justification` (Логика):**

"Рынок находится в нейтральной зоне. Fear & Greed Index в нормальном диапазоне (50). RSI на 4H показывает нейтральное значение (52.0), не перепродан и не перекуплен. Цена находится в середине диапазона между key_levels (29800-31000). EMA_200 на старшем таймфрейме не дает четкого сигнала тренда. Текущие позиции в портфеле отсутствуют. Нет четких сигналов для входа. Ожидаю более определенных условий перед принятием решения."

**Ожидаемый `decisions` (Действие):**

```json
{
  "decisions": [
    {
      "action": "HOLD",
      "pair": "BTC/USDT",
      "parameters": {},
      "justification": "Рынок находится в нейтральной зоне. Fear & Greed Index в нормальном диапазоне (50). RSI на 4H показывает нейтральное значение (52.0), не перепродан и не перекуплен. Цена находится в середине диапазона между key_levels (29800-31000). Нет четких сигналов для входа. Ожидаю более определенных условий перед принятием решения."
    }
  ],
  "update_triggers_for_pair": "BTC/USDT",
  "next_call_triggers": {
    "reason": "Ожидаем пробоя ключевого уровня или изменения в макро-контексте.",
    "trigger_conditions": [
      { "type": "price", "condition": "above", "value": 31000 },
      { "type": "price", "condition": "below", "value": 29800 },
      { "type": "timeout", "condition": "minutes_passed", "value": 240 }
    ]
  },
  "request_additional_data": null
}
```

## Тест-кейс 3: "Превышение Лимита Риска" (Risk Limit / Hold)

**Сценарий:** Появляется идеальный сигнал `OPEN_LONG`, но портфель уже загружен риском почти "под завязку". Текущий риск портфеля близок к максимальному лимиту.

**Пример JSON-входа (Ключевые части):**

```json
{
  "strategy_context": {
    "role": "Профессиональный риск-менеджер и помощник трейдера",
    "style": "Консервативный свинг-трейдинг",
    "risk_rules": {
      "default_risk_per_trade_percent": 1.5,
      "max_allowed_risk_per_trade_percent": 2.0,
      "max_total_portfolio_risk_percent": 10.0,
      "desired_risk_reward_ratio": 2.0
    },
    "macro_context": {
      "fear_and_greed_text": "Neutral",
      "fear_and_greed_index": 50
    },
    "watchlist": ["BTC/USDT", "ETH/USDT"]
  },
  "triggered_pair": "BTC/USDT",
  "technical_analysis": {
    "analysis_4h": {
      "rsi": 30.0,
      "key_levels": {
        "period": 100,
        "high": 31000,
        "low": 29800
      }
    }
  },
  "market_data": {
    "pair": "BTC/USDT",
    "current_price": 30000
  },
  "account_state": {
    "total_portfolio_value_usdt": 50000,
    "available_quote_balance": 10000,
    "open_positions": [
      {
        "pair": "ETH/USDT",
        "side": "long",
        "amount": 10,
        "average_entry_price": 1800,
        "stop_loss_price": 1750,
        "unrealized_pnl_percent": 2.5
      }
    ],
    "open_orders": [],
    "calculated_total_portfolio_risk_percent": 9.5
  }
}
```

**Ожидаемый `justification` (Логика):**

"Вижу сильный сигнал LONG по BTC/USDT. RSI на 4H показывает перепроданность (30.0), цена находится у ключевого уровня поддержки (29800). Однако не могу войти, так как текущий риск портфеля составляет 9.5% (открыта позиция ETH/USDT с риском $500 от общего портфеля $50000). Добавление новой сделки с риском 1.5% (или $750) превысит `max_total_portfolio_risk_percent` (10.0%). Сохраняю позицию (HOLD), чтобы не нарушать правила управления капиталом. Дисциплина в управлении риском важнее любой потенциальной прибыли."

**Ожидаемый `decisions` (Действие):**

```json
{
  "decisions": [
    {
      "action": "HOLD",
      "pair": "BTC/USDT",
      "parameters": {},
      "justification": "Вижу сильный сигнал LONG по BTC/USDT. RSI на 4H показывает перепроданность (30.0), цена находится у ключевого уровня поддержки (29800). Однако не могу войти, так как текущий риск портфеля составляет 9.5%. Добавление новой сделки с риском 1.5% превысит max_total_portfolio_risk_percent (10.0%). Сохраняю позицию (HOLD), чтобы не нарушать правила управления капиталом."
    }
  ],
  "update_triggers_for_pair": "BTC/USDT",
  "next_call_triggers": {
    "reason": "Отслеживаем сигнал. Ждем снижения риска портфеля после закрытия текущих позиций.",
    "trigger_conditions": [
      { "type": "price", "condition": "below", "value": 29800 },
      { "type": "timeout", "condition": "minutes_passed", "value": 360 }
    ]
  },
  "request_additional_data": null
}
```

## Тест-кейс 4: "Закрытие позиции по прибыли" (Close Position)

**Сценарий:** Открытая позиция достигла целевой цены Take Profit или появился сигнал на закрытие по техническим причинам.

**Пример JSON-входа (Ключевые части):**

```json
{
  "strategy_context": {
    "risk_rules": {
      "default_risk_per_trade_percent": 1.5,
      "max_allowed_risk_per_trade_percent": 2.0,
      "max_total_portfolio_risk_percent": 10.0,
      "desired_risk_reward_ratio": 2.0
    },
    "macro_context": {
      "fear_and_greed_text": "Neutral",
      "fear_and_greed_index": 55
    }
  },
  "triggered_pair": "ETH/USDT",
  "technical_analysis": {
    "analysis_4h": {
      "rsi": 75.0,
      "key_levels": {
        "high": 2000,
        "low": 1800
      }
    }
  },
  "market_data": {
    "pair": "ETH/USDT",
    "current_price": 1995
  },
  "account_state": {
    "total_portfolio_value_usdt": 50000,
    "open_positions": [
      {
        "pair": "ETH/USDT",
        "side": "long",
        "amount": 10,
        "average_entry_price": 1850,
        "stop_loss_price": 1800,
        "unrealized_pnl_percent": 7.8
      }
    ]
  }
}
```

**Ожидаемый `justification` (Логика):**

"Позиция ETH/USDT достигла целевой зоны. Цена находится у key_levels.high (2000), RSI на 4H показывает перекупленность (75.0). Позиция показывает прибыль 7.8%, что превышает желаемое соотношение риск/прибыль. Фиксирую прибыль, закрывая позицию по рынку, чтобы защитить достигнутый результат. Fear & Greed Index в нейтральной зоне (55), не требует экстренного закрытия, но технические индикаторы указывают на возможную коррекцию."

**Ожидаемый `decisions` (Действие):**

```json
{
  "decisions": [
    {
      "action": "CLOSE_POSITION",
      "pair": "ETH/USDT",
      "parameters": {
        "type": "market",
        "amount_percent": 100
      },
      "justification": "Позиция ETH/USDT достигла целевой зоны. Цена находится у key_levels.high (2000), RSI на 4H показывает перекупленность (75.0). Позиция показывает прибыль 7.8%, что превышает желаемое соотношение риск/прибыль. Фиксирую прибыль, закрывая позицию по рынку."
    }
  ],
  "update_triggers_for_pair": "ETH/USDT",
  "next_call_triggers": {
    "reason": "Позиция закрыта. Ожидаем нового сигнала для входа.",
    "trigger_conditions": [
      { "type": "indicator", "name": "rsi", "timeframe": "4h", "condition": "below", "value": 30 }
    ]
  },
  "request_additional_data": null
}
```

## Примечания по Тестированию

1. **Ручное тестирование:** Эти тест-кейсы предназначены для ручного тестирования промптов в "песочнице" OpenAI, Anthropic или другой LLM-системы.

2. **Полный JSON:** В реальном использовании `LLMRequestAssemblerService` будет формировать полный JSON-запрос, включая все поля из `LLMRequest`.

3. **Валидация:** Ответы LLM должны проходить валидацию через `llmResponseSchema` из `ILLMTypes.zod.ts`.

4. **Регрессионное тестирование:** При изменении промптов (`system.md`, `user_template.md`) эти тест-кейсы должны быть повторно проверены для обеспечения обратной совместимости.

