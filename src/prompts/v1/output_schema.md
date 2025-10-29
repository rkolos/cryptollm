# JSON Output Schema - Схема Ответа LLM

Ты **ОБЯЗАН** вернуть ответ в формате JSON, который **СТРОГО** соответствует этой схеме.

## Описание Корневого Объекта (Root JSON Object)

| Поле | Тип | Обязательно | Описание |
|------|-----|-------------|----------|
| `decisions` | `Array<DecisionObject>` | **Да** | Массив торговых приказов. Может быть пустым (`[]`), если ты решаешь ничего не делать (но тогда должен быть хотя бы один `decision` с `action: 'HOLD'` и обоснованием). |
| `update_triggers_for_pair` | `string` | **Да** | Торговая пара (e.g., "BTC/USDT"), для которой предназначены `next_call_triggers`. |
| `next_call_triggers` | `TriggerConfigObject` | **Да** | Объект, описывающий _новые_ условия для следующего вызова LLM по этой паре. |
| `request_additional_data` | `Array<string> \| null` | **Да** | Массив строк (`null`, если ничего не нужно), запрашивающий _дополнительные_ индикаторы (e.g., `["ADX_1h", "ATR_4h"]`) для _следующего_ вызова LLM по этой паре. |

## Описание `DecisionObject` (Элемент массива `decisions`)

| Поле | Тип | Обязательно | Описание |
|------|-----|-------------|----------|
| `action` | `string` | **Да** | Тип действия. Допустимые значения: `OPEN_LONG`, `OPEN_SHORT`, `CLOSE_POSITION`, `MODIFY_POSITION`, `CANCEL_ORDERS`, `HOLD`. |
| `pair` | `string` | **Да** | Торговая пара, к которой применяется действие (e.g., "ETH/USDT"). |
| `parameters` | `ParametersObject` | **Да** | Объект с параметрами для `action`. **Структура этого объекта меняется в зависимости от `action`!** |
| `justification` | `string` | **Да** | (Chain-of-Thought) Твое текстовое "обоснование" решения, основанное на ТА, макро-контексте и портфеле. **Не может быть пустым.** Должен содержать цепочку размышлений. |

## Описание `ParametersObject` (В зависимости от `action`)

### 1. Для `action: "OPEN_LONG"` или `"OPEN_SHORT"`

| Поле | Тип | Обязательно | Описание |
|------|-----|-------------|----------|
| `type` | `string` | **Да** | `'market'` (по рынку) или `'limit'` (отложенный). |
| `price` | `number \| null` | Условно | Цена входа. **Обязательно** для `'limit'`, `null` для `'market'`. |
| `risk_percent` | `number \| null` | Нет | Процент риска от `total_portfolio_value_usdt` (e.g., `1.5`). Если `null`, используется `default_risk_per_trade_percent` из `risk_rules`. |
| `stop_loss_price` | `number` | **Да** | Цена _начального_ Stop Loss. **Обязательно для всех открытий позиций.** |
| `take_profit_price` | `number \| null` | Нет | Цена Take Profit. `null`, если используется TSL или не требуется. |
| `trailing_stop_config` | `object \| null` | Нет | `null` или `{ type: "percentage", distance: 3.0 }`. Определяет правила Trailing Stop Loss. |

### 2. Для `action: "CLOSE_POSITION"`

| Поле | Тип | Обязательно | Описание |
|------|-----|-------------|----------|
| `type` | `string` | **Да** | `'market'` (закрыть сейчас) или `'limit'` (поставить Take Profit). |
| `amount_percent` | `number` | **Да** | Какой % позиции закрыть (e.g., `100` для полного закрытия, `50` для частичного). |
| `price` | `number \| null` | Условно | Цена закрытия. **Обязательно** для `'limit'`, `null` для `'market'`. |

### 3. Для `action: "MODIFY_POSITION"`

| Поле | Тип | Обязательно | Описание |
|------|-----|-------------|----------|
| `new_stop_loss_price` | `number` | Нет | Новая цена SL. Должен быть указан, если меняем SL. |
| `new_take_profit_price` | `number` | Нет | Новая цена TP. Должен быть указан, если меняем TP. |
| `new_trailing_stop_config` | `object \| null` | Нет | Новые правила TSL. `null`, если отключаем TSL. Формат: `{ type: "percentage", distance: number }`. |

### 4. Для `action: "CANCEL_ORDERS"`

| Поле | Тип | Обязательно | Описание |
|------|-----|-------------|----------|
| `order_id` | `string \| null` | Нет | `id` ордера для отмены. Если `null` – отменить **все** `limit` и `stop` ордера по этой `pair`. |

### 5. Для `action: "HOLD"`

Для действия `HOLD` параметры не требуются, но поле `parameters` должно присутствовать (может быть пустым объектом `{}`).

## Описание `TriggerConfigObject` (Поле `next_call_triggers`)

| Поле | Тип | Обязательно | Описание |
|------|-----|-------------|----------|
| `reason` | `string` | **Да** | Краткое текстовое описание, зачем нужны эти триггеры. |
| `trigger_conditions` | `Array<TriggerCondition>` | **Да** | Массив новых триггеров. **Заменяет** все старые триггеры для этой пары. |

### Элемент `TriggerCondition`

| Поле | Тип | Обязательно | Описание |
|------|-----|-------------|----------|
| `type` | `string` | **Да** | Тип триггера: `'price'`, `'indicator'` или `'timeout'`. |
| `condition` | `string` | **Да** | Условие: `'above'`, `'below'` (для `price` и `indicator`), `'minutes_passed'` (для `timeout`). |
| `value` | `number` | **Да** | Целевое значение (e.g., `30000` для цены, `30` для RSI, `120` для таймаута в минутах). |
| `name` | `string \| null` | Условно | `null` для `price` и `timeout`. Имя индикатора (e.g., `'rsi'`, `'macd'`) для `indicator`. **Обязательно** для `type: 'indicator'`. |
| `timeframe` | `string \| null` | Условно | `null` для `price` и `timeout`. Таймфрейм (e.g., `'1h'`, `'4h'`) для `indicator`. **Обязательно** для `type: 'indicator'`. |

## Примеры Валидных Ответов

### Пример 1: Открытие Long позиции (Market)

```json
{
  "decisions": [
    {
      "action": "OPEN_LONG",
      "pair": "BTC/USDT",
      "parameters": {
        "type": "market",
        "risk_percent": 1.5,
        "stop_loss_price": 29800.0,
        "take_profit_price": 31000.0,
        "trailing_stop_config": null
      },
      "justification": "Рынок в 'Extreme Fear' (25), RSI на 4H перепродан (28) и цена находится у key_levels.low (29800). Это сильный сигнал к покупке на отскок. Так как портфель пуст, я вхожу со стандартным риском 1.5%."
    }
  ],
  "update_triggers_for_pair": "BTC/USDT",
  "next_call_triggers": {
    "reason": "Отслеживаем новую позицию и следим за движением цены.",
    "trigger_conditions": [
      { "type": "price", "condition": "below", "value": 29800 },
      { "type": "indicator", "name": "rsi", "timeframe": "1h", "condition": "above", "value": 70 }
    ]
  },
  "request_additional_data": null
}
```

### Пример 2: HOLD с обоснованием

```json
{
  "decisions": [
    {
      "action": "HOLD",
      "pair": "ETH/USDT",
      "parameters": {},
      "justification": "Рынок находится в нейтральной зоне. EMA_200 на 4H не дает четкого сигнала тренда. Fear & Greed Index в нормальном диапазоне (50). Текущие позиции в портфеле уже используют 2% риска. Ожидаю более четких сигналов перед входом."
    }
  ],
  "update_triggers_for_pair": "ETH/USDT",
  "next_call_triggers": {
    "reason": "Ожидаем четкого пробоя ключевого уровня или изменения в макро-контексте.",
    "trigger_conditions": [
      { "type": "price", "condition": "above", "value": 2500 },
      { "type": "timeout", "condition": "minutes_passed", "value": 240 }
    ]
  },
  "request_additional_data": ["ADX_4h"]
}
```

## Критические Требования

1. **JSON Формат**: Ответ должен быть **ТОЛЬКО** валидным JSON-объектом без какого-либо обрамляющего текста.

2. **Поле `justification`**: Каждый `decision` **ОБЯЗАН** содержать filled `justification` с цепочкой размышлений (Chain-of-Thought), описывающую:
   - Какие индикаторы увидел в `technical_analysis`
   - Как `macro_context` повлиял на решение
   - Как `account_state` повлиял на решение
   - Почему выбран конкретный `risk_percent` (если открывается позиция)

3. **Массив `decisions`**: Даже если ты не принимаешь торговых решений, массив `decisions` должен содержать хотя бы один элемент с `action: 'HOLD'` и обоснованием.

4. **Триггеры**: Всегда указывай `next_call_triggers` для отслеживания изменений на рынке.

