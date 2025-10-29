# Запрос к LLM - Анализ и Принятие Решения

## Контекст Стратегии и Риска

{{STRATEGY_CONTEXT}}

## Данные Рынка (Triggered Pair: {{TRIGGERED_PAIR}})

{{MARKET_DATA_JSON}}

## Технический Анализ (Triggered Pair: {{TRIGGERED_PAIR}})

{{TECHNICAL_ANALYSIS_JSON}}

## Состояние Портфеля (Global)

{{ACCOUNT_STATE_JSON}}

## Требуемая Схема Ответа (JSON Output Schema)

Ты **ОБЯЗАН** вернуть ответ в формате JSON, который **СТРОГО** соответствует этой схеме.

{{OUTPUT_SCHEMA_MD}}

## ЗАДАЧА

{{FINAL_QUESTION}}

