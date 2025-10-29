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

1.  **Логика:** _обязан_ асинхронно прочитать `system.md`, `user_template.md` и `output_schema.md` (путь к которым задан константой `PROMPT_DIR_V1`).
2.  **Нюанс:** _обязан_ использовать `Promise.all` для параллельного чтения файлов.
3.  **Отказоустойчивость (Критично):** Если любой из файлов отсутствует или чтение не удалось, `initialize()` _обязан_ бросить **фатальную ошибку** (`throw error`) и остановить приложение, так как бот не сможет работать без своей "конституции".

### 4.2. Метод `buildRequest(triggered_pair, reason)` (Ядро Сборки)

#### **Шаг A: Получение "on-demand" данных**

1.  **Логика:** _обязан_ выполнить запрос к `DatabaseService` (`SELECT requested_data_json FROM LLM_Triggers`) для получения массива индикаторов, запрошенных LLM в прошлый раз (e.g., `["ADX_1h", "ATR_4h"]`).
2.  **Нюанс:** _обязан_ разделить этот массив на: `indicators` (`ADX`, `ATR`) и `timeframes` (`1h`, `4h`).
3.  **Нюанс:** _обязан_ объединить уникальный список `timeframes` с **обязательными** базовыми таймфреймами (`1h`, `4h`) для обеспечения полноты данных ТА.

#### **Шаг B: Параллельный Сбор Рыночных Данных**

1.  **Логика:** _обязан_ использовать `Promise.all` для параллельного сбора (от `MarketDataService` и `WatchlistOverviewService`):
    - Всех необходимых OHLCV (для всех уникальных TFs).
    - Агрегированного стакана и ленты.
    - Обзора `watchlist` (исключая `triggered_pair`).
    - Текущей цены (`current_price`).

2.  **Критично:** _обязан_ передать собранный `ohlcvMap` и `requestedData.indicators` в `taEngineService.getAnalysis()` для расчета ТА.

#### **Шаг C: Компоновка JSON-объекта (`LLMRequestData`)**

1.  **Синхронность:** _обязан_ синхронно получить кэшированные данные из `AccountStateService.getAccountState()` и `MacroContextService.getContext()`.
2.  **Сборка:** _обязан_ собрать все данные (TA, Market, Account, Macro, Risk Rules) в единый JSON-объект (`LLMRequestData`) в соответствии с "Примером 1" из `about.md`.

#### **Шаг D: Сборка Финального Промпта**

1.  **JSON-Сериализация (Критично):** _обязан_ использовать вспомогательную функцию (`safeJsonStringify`) для сериализации `LLMRequestData`. Эта функция _обязана_ рекурсивно искать все экземпляры `Decimal` и заменять их на `value.toNumber()` в итоговой строке JSON.
2.  **Шаблонизация:** _обязан_ взять `user_template.md` из кэша.
3.  **Нюанс:** _обязан_ сначала внедрить кэшированную `output_schema.md` в плейсхолдер `{{OUTPUT_SCHEMA}}` шаблона, а затем внедрить все остальные JSON-строки (`{{MARKET_DATA_JSON}}`, `{{ACCOUNT_STATE_JSON}}` и т.д.).
4.  **Возврат:** _обязан_ вернуть финальный `LLMRequestPayload` (отдельно `system_prompt` и `user_prompt`).

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Service

    `LLMRequestAssemblerService` создан как Singleton и корректно получает инъекции _всех_ 7+ необходимых сервисов.

2.  Init(Критично)

    `initialize()` _обязан_ загружать и кэшировать 3 файла промптов (`system.md`, `user_template.md`, `output_schema.md`) и бросать ошибку при сбое.

3.  DataLogic

    `buildRequest()` _обязан_ корректно читать `requested_data_json` из БД и формировать уникальный список требуемых таймфреймов.

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
