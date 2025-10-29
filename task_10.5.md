# Техническое Задание (ТЗ): 10.5 Формализация и Внедрение Выходной Схемы (JSON Output Schema)

**Эпик:** 10. 🧠 Архитектура Промптов и "Личность" Трейдера **Задача:** 10.5 🗃️ Формализация и Внедрение Выходной Схемы (JSON Output Schema) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать файл `output_schema.md`, который содержит исчерпывающее, но понятное для LLM описание требуемой структуры JSON-ответа.

Этот файл является "контрактом" между LLM и кодом (валидатором). Он будет использоваться как `LLMRequestAssemblerService` (для вставки в промпт), так и `ProductionLLMService` (для `zod`\-валидации).

## 2\. Зависимости Задачи

- **`about.md` (Пример 2):** (Источник) Исходный пример формата ответа.
- **`system.md` (10.3):** (Источник) Требование о наличии поля `justification`.
- **`user_template.md` (10.4):** (Потребитель) Файл, в который будет вставлено содержимое `output_schema.md` (в плейсхолдер `{{OUTPUT_SCHEMA_MD}}`).
- **`ProductionLLMService` (3.4):** (Потребитель) Сервис, который будет использовать эту структуру для создания `zod`\-схемы валидации.

## 3\. Описание и Нюансы Реализации

### 3.1. Создание Файла

Разработчик (Prompt Engineer / Architect) должен создать файл по следующему пути:

- `src/prompts/v1/output_schema.md`

### 3.2. Содержание Файла `output_schema.md`

Файл должен быть написан на **русском языке**. Он должен описывать **корневой объект** и все его вложенные структуры.

**Содержание (Пример):**

> ## Описание Корневого Объекта (Root JSON Object)
>
> Поле
>
> Тип
>
> Обязательно
>
> Описание
>
> `justification`
>
> `string`
>
> **Да**
>
> (Chain-of-Thought) Твое текстовое "обоснование" решения, основанное на ТА, макро-контексте и портфеле. **Не может быть пустым.**
>
> `decisions`
>
> `Array<DecisionObject>`
>
> **Да**
>
> Массив торговых приказов. Может быть пустым (`[]`), если ты решаешь ничего не делать (HOLD).
>
> `update_triggers_for_pair`
>
> `string`
>
> **Да**
>
> `pair` (e.g., "BTC/USDT"), для которого предназначены `next_call_triggers`.
>
> `next_call_triggers`
>
> `TriggerConfigObject`
>
> **Да**
>
> Объект, описывающий _новые_ условия для следующего вызова LLM по этой паре.
>
> `request_additional_data`
>
> `Array<string> | null`
>
> **Да**
>
> Массив строк (`null`, если ничего не нужно), запрашивающий _дополнительные_ индикаторы (e.g., `["ADX_1h", "ATR_4h"]`) для _следующего_ вызова LLM по этой паре.
>
> ## Описание `DecisionObject` (Элемент массива `decisions`)
>
> Поле
>
> Тип
>
> Обязательно
>
> Описание
>
> `action`
>
> `string`
>
> **Да**
>
> Тип действия. Допустимые значения: `OPEN_LONG`, `OPEN_SHORT`, `CLOSE_POSITION`, `MODIFY_POSITION`, `CANCEL_ORDERS`.
>
> `pair`
>
> `string`
>
> **Да**
>
> Торговая пара, к которой применяется действие (e.g., "ETH/USDT").
>
> `parameters`
>
> `ParametersObject`
>
> **Да**
>
> Объект с параметрами для `action`. **Структура этого объекта меняется в зависимости от `action`!**
>
> ## Описание `ParametersObject` (В зависимости от `action`)
>
> ### 1\. Для `action: "OPEN_LONG"` или `"OPEN_SHORT"`
>
> Поле
>
> Тип
>
> Описание
>
> `type`
>
> `string`
>
> **Обязательно.** `'market'` (по рынку) или `'limit'` (отложенный).
>
> `price`
>
> `number | null`
>
> Цена входа. **Обязательно** для `'limit'`, `null` для `'market'`.
>
> `risk_percent`
>
> `number | null`
>
> Процент риска от `total_portfolio_value_usdt` (e.g., `1.5`). Если `null`, используется `default_risk_per_trade_percent`.
>
> `stop_loss_price`
>
> `number`
>
> **Обязательно.** Цена _начального_ Stop Loss.
>
> `take_profit_price`
>
> `number | null`
>
> Цена Take Profit. `null`, если используется TSL или не требуется.
>
> `trailing_stop_config`
>
> `object | null`
>
> `null` или `{ type: "percentage", distance: 3.0 }`.
>
> ### 2\. Для `action: "CLOSE_POSITION"`
>
> Поле
>
> Тип
>
> Описание
>
> `type`
>
> `string`
>
> **Обязательно.** `'market'` (закрыть сейчас) или `'limit'` (поставить Take Profit).
>
> `amount_percent`
>
> `number`
>
> **Обязательно.** Какой % позиции закрыть (e.g., `100`).
>
> `price`
>
> `number | null`
>
> Цена закрытия. **Обязательно** для `'limit'`, `null` для `'market'`.
>
> ### 3\. Для `action: "MODIFY_POSITION"`
>
> Поле
>
> Тип
>
> Описание
>
> `new_stop_loss_price`
>
> `number | null`
>
> Новая цена SL. `null`, если не меняем.
>
> `new_take_profit_price`
>
> `number | null`
>
> Новая цена TP. `null`, если не меняем.
>
> `new_trailing_stop_config`
>
> `object | null`
>
> Новые правила TSL. `null`, если не меняем.
>
> ### 4\. Для `action: "CANCEL_ORDERS"`
>
> Поле
>
> Тип
>
> Описание
>
> `order_id`
>
> `string | null`
>
> `id` ордера для отмены. Если `null` – отменить **все** `limit` и `stop` ордера по этой `pair`.
>
> ## Описание `TriggerConfigObject` (Поле `next_call_triggers`)
>
> Поле
>
> Тип
>
> Описание
>
> `reason`
>
> `string`
>
> Краткое текстовое описание, зачем нужны эти триггеры.
>
> `trigger_conditions`
>
> `Array<TriggerCondition>`
>
> Массив новых триггеров. **Заменяет** все старые триггеры для этой пары.
>
> ### Элемент `TriggerCondition`
>
> Поле
>
> Тип
>
> Описание
>
> `type`
>
> `string`
>
> `'price'`, `'indicator'` или `'timeout'`.
>
> `condition`
>
> `string`
>
> `'above'`, `'below'`, `'minutes_passed'`.
>
> `value`
>
> `number`
>
> Целевое значение (e.g., `30000` для цены, `30` для RSI, `120` для таймаута).
>
> `name`
>
> `string | null`
>
> `null` для `price` и `timeout`. Имя индикатора (e.g., `'rsi'`) для `indicator`.
>
> `timeframe`
>
> `string | null`
>
> `null` для `price` и `timeout`. Таймфрейм (e.g., `'1h'`) для `indicator`.

## 4\. Критерии Приемки (Acceptance Criteria)

1.  **\[Файл\]** Файл `src/prompts/v1/output_schema.md` создан.
2.  **\[Полнота\]** Схема описывает _все_ поля из "Примера 2" (`about.md`), включая `decisions`, `next_call_triggers` и `request_additional_data`.
3.  **\[CoT (Критично)\]** Схема включает **обязательное** поле `justification` (string) на корневом уровне, как того требовала Задача 10.3.
4.  **\[Детализация `decisions`\]** Четко описаны все варианты `action` и _различные_ структуры `parameters` для каждого из них (OPEN, CLOSE, MODIFY, CANCEL).
5.  **\[Потребитель\]** Подтверждено (архитектурно), что `LLMRequestAssemblerService` (4.6) будет внедрять этот файл в `user_template.md` (10.4).
