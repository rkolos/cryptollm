# Техническое Задание (ТЗ): 4.6 Сборщик Запроса к LLM (LLMRequestAssemblerService)

**Эпик:** 4. 📊 "Наблюдатель" (Watcher) - Сбор Данных и Технический Анализ **Задача:** 4.6 Сборщик Запроса к LLM **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать **Singleton-сервис** `LLMRequestAssemblerService`, который выступает в роли "сборщика" и "компоновщика" данных. Его задача — взять информацию из _всех_ сервисов-сборщиков (TA, Market, Account, Macro) и **сформировать финальный Payload** для отправки в `ILLMService`.

## 2\. Архитектурное Решение

1.  **Orchestration (Оркестрация):** Главный метод `buildRequest` _обязан_ управлять порядком сбора данных, включая выполнение сложных шагов, таких как: чтение `on-demand` индикаторов из БД -> определение уникального списка таймфреймов -> параллельный запрос OHLCV.
2.  **Два Контракта:** Сервис _обязан_ работать с двумя контрактами: (1) **JSON-объектом** (`LLMRequestData`), который содержит _все_ данные (цены, риски, балансы), и (2) **Текстовым Шаблоном** (`user_template.md`), в который этот JSON будет внедрен.
3.  **Безопасность Типов (Критично):** Поскольку LLM не понимает тип `Decimal` (она увидит `{ "s": 1, "e": 3, "c": [30000] }`), этот сервис _обязан_ реализовать безопасный `JSON.stringify`, который **конвертирует все экземпляры `Decimal` в обычные `number`** перед сериализацией.
4.  **Кэширование Промптов:** Для избежания I/O на каждый вызов LLM, файлы промптов (`system.md`, `user_template.md`, `output_schema.md`) _обязаны_ быть загружены в `in-memory` кэш (`promptCache`) _один раз_ при инициализации.

## 3\. Зависимости Задачи

- **`fs/promises` / `path` (Node.js):** (Зависимость) Для чтения файлов промптов.
- **`DatabaseService` (2.3):** (Зависимость) Для чтения `requested_data_json` из `LLM_Triggers`.
- **Сборщики (4.1-4.5):** (Зависимости) `MarketDataService`, `TAEngineService`, `WatchlistOverviewService`, `AccountStateService`, `MacroContextService`.
- **Конфигурация (1.3):** `ConfigService`.

## 4\. Описание и Нюансы Реализации

### 4.1. Метод `initialize()` (Загрузка Кэша)

1.  **Логика:** _обязан_ асинхронно прочитать 4 файла: `system.md`, `user_template.md`, `output_schema.md` и `final_question_template.md` (путь к которым задан константой `PROMPT_DIR_V1`, вычисляемой через `fileURLToPath` и `dirname` для ESM-совместимости).
2.  **Нюанс:** _обязан_ использовать `Promise.all` для параллельного чтения всех файлов через `readFile` из `fs/promises`.
3.  **Кэширование:** Сохранить содержимое всех файлов в `promptCache` объект с полями `systemPrompt`, `userTemplate`, `outputSchema`, `finalQuestionTemplate`.
4.  **Отказоустойчивость (Критично):** Если любой из файлов отсутствует или чтение не удалось, `initialize()` _обязан_ залогировать `error` с сообщением "FATAL: Failed to load prompts" и бросить **фатальную ошибку** (`throw new Error(...)`), остановив приложение, так как бот не сможет работать без своей "конституции".

### 4.2. Метод `buildRequest(triggered_pair, reason)` (Ядро Сборки)

#### **Шаг A: Получение "on-demand" данных и истории решений**

1.  **Получение requested_data_json:** _обязан_ выполнить запрос к `DatabaseService` (`SELECT requested_data_json FROM llm_triggers WHERE pair = $1`, [triggeredPair]) для получения массива индикаторов, запрошенных LLM в прошлый раз (e.g., `["ADX_1h", "ATR_4h"]`).
2.  **Парсинг requested_data:** Использовать приватный метод `parseRequestedData(requestedDataValue)` для обработки различных форматов:
    - Массив (если PostgreSQL вернул JSONB как массив)
    - JSON строка
    - Строка с запятыми (fallback)
    - Метод должен извлекать индикаторы и таймфреймы из формата `"ADX_1h"` (разделение по `_`, последняя часть - таймфрейм)
    - Валидировать таймфреймы через список валидных для Binance
3.  **Получение отклоненных решений (для повторных запросов):** Если `reason` содержит "ПОВТОРНЫЙ ЗАПРОС", выполнить запрос к `LLM_Decision_Log` для получения последних отклоненных решений за 24 часа (поле `decision_result IN ('rejected_by_validator', 'failed_by_worker')`). Парсить `response_payload_json` и извлекать решения с обоснованиями и сообщениями об ошибках.
4.  **Получение успешных решений:** Выполнить запрос к `LLM_Decision_Log` для получения последних успешных решений за 7 дней (`decision_result = 'accepted'`). Парсить `response_payload_json` и извлекать решения с обоснованиями.
5.  **Валидация таймфреймов:** Использовать приватный метод `validateAndNormalizeTimeframes(timeframes)` для валидации и нормализации таймфреймов (приведение к нижнему регистру, проверка на валидность для Binance).
6.  **Объединение таймфреймов:** Объединить уникальный список таймфреймов из `requestedData` с **обязательными** базовыми таймфреймами (`['1h', '4h']`) и удалить дубликаты через `Array.from(new Set(...))`.

#### **Шаг B: Параллельный Сбор Рыночных Данных**

1.  **Логика:** _обязан_ использовать `Promise.all` для параллельного сбора:
    - Всех необходимых OHLCV: создать массив промисов для каждого уникального таймфрейма через `uniqueTimeframes.map(tf => marketDataService.fetchOHLCV(triggeredPair, tf, undefined, 50))`.
    - Агрегированного стакана и ленты: `marketDataService.fetchDetailedMarketData(triggeredPair, '1h', 50, 50)`.
    - Обзора `watchlist`: `watchlistOverviewService.fetchWatchlistOverview(triggeredPair)` (исключая `triggered_pair`).

2.  **Построение карты OHLCV:** Создать объект `ohlcvMap: Record<string, IDecimalOHLCV[]>` для хранения OHLCV по таймфреймам.

3.  **Расчет технического анализа:** Для каждого таймфрейма из `uniqueTimeframes` вызвать `taEngineService.getAnalysis(ohlcv, requestedData.indicators)` и сохранить результат в `technicalAnalysis: Record<string, AnalysisResult>` с ключом `analysis_${timeframe}`.

4.  **Расчет текущей цены:** Извлечь `currentPrice` из `orderBook` как среднее между `best_bid` и `best_ask` (`(best_bid + best_ask) / 2`). Если `orderBook` пуст, использовать fallback: `close` цену из последней свечи первого таймфрейма OHLCV. Если и это недоступно, использовать `new Decimal(0)`.

#### **Шаг C: Компоновка JSON-объекта (`LLMRequestData`)**

1.  **Синхронность:** _обязан_ синхронно получить кэшированные данные:
    - `AccountStateService.getAccountState()`
    - `MacroContextService.getContext()`
    - `ConfigService.getStrategyContext()`
    - `ConfigService.getRiskRules()`
    - `ConfigService.getWatchlist()`

2.  **Конвертация Decimal в number:** Использовать приватный метод `toNumber(decimalValue)` для конвертации всех `DecimalValue` в `number | null` при формировании всех структур данных.

3.  **Формирование market_data:** Включить `pair`, `current_price` (из `toNumber(finalCurrentPrice)`), `order_book` (со всеми полями, конвертированными через `toNumber`), `recent_trades` (с конвертацией `price` и `amount`), `watchlist_overview` (с конвертацией `current_price` и `rsi_1h`).

4.  **Формирование technical_analysis:** Для каждого таймфрейма создать объект с конвертацией всех полей `AnalysisResult` через `toNumber()` (включая вложенные объекты `macd`, `bollinger`, `key_levels`, `stochastic`).

5.  **Формирование account_state:** Включить все поля из `accountState` с конвертацией через `toNumber()`. Добавить `max_position_size_usdt` (равный `available_quote_balance`). Добавить `active_triggers` (из `accountState.llmTriggers` Map, преобразованной в объект). Добавить `previous_justifications` (из `recentAcceptedDecisions`, только для текущей пары, с преобразованием `timestamp` в ISO строку).

6.  **Формирование strategy_context:** Включить все поля из `strategyContext`, добавить `risk_rules` (из `riskRules`), `macro_context` (из `macroContext`, только если `fear_and_greed_index !== null`), `watchlist`.

7.  **Сборка финального объекта:** Создать `llmRequestData` с полями `strategy_context`, `triggered_pair`, `market_data`, `technical_analysis`, `account_state`, `question` (пустая строка, будет заполнена в шаблоне).

#### **Шаг D: Сборка Финального Промпта**

1.  **JSON-Сериализация (Критично):** Использовать приватный метод `safeJsonStringify(obj)` для сериализации `llmRequestData`. Этот метод использует `JSON.stringify` с `replacer` функцией, которая проверяет, является ли значение `DecimalValue` (проверка на наличие полей `e` и метода `toNumber`) и заменяет его на `value.toNumber()` в итоговой строке JSON. Форматирование с отступами (`JSON.stringify(obj, replacer, 2)`).

2.  **Шаблонизация:** Использовать приватный метод `_buildUserPrompt(llmRequestData, triggeredPair, reason, macroContext, recentRejections)`:
    - Взять `userTemplate` из кэша.
    - Внедрить кэшированную `outputSchema` в плейсхолдер `{{OUTPUT_SCHEMA}}`.
    - Внедрить сериализованные JSON-строки: `{{MARKET_DATA_JSON}}`, `{{TECHNICAL_ANALYSIS_JSON}}`, `{{ACCOUNT_STATE_JSON}}`, `{{STRATEGY_CONTEXT_JSON}}`.
    - Использовать `finalQuestionTemplate` для формирования вопроса, внедряя `triggeredPair`, `reason`, информацию о макро-контексте и отклоненных решениях (если есть).
    - Внедрить финальный вопрос в плейсхолдер `{{FINAL_QUESTION}}`.

3.  **Возврат:** Вернуть объект `LLMRequestPayload` с полями:
    - `system_prompt`: `promptCache.systemPrompt`
    - `user_prompt`: результат `_buildUserPrompt()`

4.  **Логирование:** Залогировать `info` о начале сборки запроса и `debug` о количестве таймфреймов и запрошенных индикаторов.

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Service

    `LLMRequestAssemblerService` создан как Singleton с методом `getInstance(configService, databaseService, marketDataService, taEngineService, watchlistOverviewService, accountStateService, macroContextService)` и корректно получает инъекции _всех_ 7 необходимых сервисов.

2.  Init(Критично)

    `initialize()` _обязан_ загружать и кэшировать 4 файла промптов (`system.md`, `user_template.md`, `output_schema.md`, `final_question_template.md`) и бросать ошибку при сбое. Использует ESM-совместимый путь через `fileURLToPath` и `dirname`.

3.  DataLogic

    `buildRequest()` _обязан_ корректно читать `requested_data_json` из БД (для конкретной пары), парсить его через `parseRequestedData()` (поддержка различных форматов), валидировать таймфреймы через `validateAndNormalizeTimeframes()` и формировать уникальный список требуемых таймфреймов (объединение с базовыми `['1h', '4h']`).

4.  Concurrency

    `buildRequest()` _обязан_ использовать `Promise.all` для параллельного сбора рыночных данных и OHLCV.

5.  DataChain

    `buildRequest()` _обязан_ вызвать `taEngineService.getAnalysis()` с корректными OHLCV и списком `on-demand` индикаторов.

6.  DataIntegrity

    `buildRequest()` _обязан_ синхронно получить `account_state` и `macro_context` и включить их в `LLMRequestData`.

7.  Serialization(Критично)

    Реализована вспомогательная функция `safeJsonStringify` (или аналогичная), которая _гарантированно_ преобразует **все** экземпляры `Decimal` в `number` в строке JSON.

8.  Templating

    Метод `_buildUserPrompt()` _обязан_ корректно внедрять `output_schema.md` и все JSON-строки в шаблон, используя кэшированные данные.

9.  Output

    `buildRequest()` _обязан_ возвращать объект `LLMRequestPayload` с двумя строковыми полями: `system_prompt` и `user_prompt`.

10. RejectionHistory

    Для повторных запросов (`reason` содержит "ПОВТОРНЫЙ ЗАПРОС") `buildRequest()` получает и включает информацию об отклоненных решениях из `LLM_Decision_Log` за последние 24 часа.

11. AcceptedDecisions

    `buildRequest()` получает последние успешные решения из `LLM_Decision_Log` за последние 7 дней и включает их обоснования в `account_state.previous_justifications`.

12. CurrentPrice

    `buildRequest()` корректно рассчитывает `current_price` из `orderBook` (среднее между bid и ask) или использует fallback на последнюю свечу OHLCV.

13. ActiveTriggers

    `buildRequest()` включает `active_triggers` в `account_state` из `accountState.llmTriggers` Map, преобразованной в объект.

14. MaxPositionSize

    `buildRequest()` включает `max_position_size_usdt` в `account_state`, равный `available_quote_balance`.

15. FinalQuestionTemplate

    Метод `_buildUserPrompt()` использует `finalQuestionTemplate` для формирования вопроса с учетом отклоненных решений и макро-контекста.
