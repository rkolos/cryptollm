# Техническое Задание (ТЗ): 4.5 Сборщик Состояния Портфеля (AccountStateService)

**Эпик:** 4. 📊 "Наблюдатель" (Watcher) - Сбор Данных и Технический Анализ **Задача:** 4.5 (и 4.5.1) Сборщик Состояния Портфеля и Инвалидация Кэша **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать **Singleton-сервис** `AccountStateService`, который отвечает за:

1.  **Агрегацию** данных "Состояния Счета" (Категория 3 из `about.md`) из **трех источников** (Биржа, БД: Позиции, БД: Ордера).
2.  **Кэширование** этого состояния `in-memory` (далее `globalAccountState`).
3.  Предоставление **синхронного** доступа к кэшу (для `LLMRequestAssemblerService` - 4.6).
4.  **Немедленную инвалидацию** кэша (вызов `refreshNow`) при получении события `trade_executed` от `EventBus` (Задача 4.5.1).

## 2\. Архитектурное Решение

1.  **Централизованный Кэш (Критично):** Сервис _обязан_ хранить единственную, последнюю, успешно обновленную версию состояния портфеля. Все сервисы, которым нужны эти данные (LLM Assembler, TSL Handler), _должны_ получать их **синхронно** через `getAccountState()`.
2.  **Оркестрация Сбора:** Метод `refreshNow()` _обязан_ использовать `Promise.all` для параллельного получения данных из `IExchangeService` и `DatabaseService`.
3.  **Атомарность (Защита от Гонки):** `refreshNow()` _обязан_ реализовать механизм блокировки (`refreshPromise` / флаг), чтобы предотвратить одновременный запуск двух процессов обновления кэша.
4.  **Инвалидация по Событию (Задача 4.5.1):** Сервис _обязан_ подписаться на `EventBus` и инициировать обновление кэша _сразу_ после того, как `WorkerService` (7.1) успешно завершит транзакцию (`trade_executed`). Это обеспечивает максимальную актуальность данных.
5.  **Точность:** Все расчеты (доступный баланс, стоимость портфеля) _обязаны_ использовать `decimal.js`.

## 3\. Зависимости Задачи

- **`IExchangeService` (3.1):** (Зависимость) Для `fetchBalance()`.
- **`DatabaseService` (2.3):** (Зависимость) Для `query()` (`ActivePositions`, `ActiveOrders`).
- **`EventBusService` (Новый, см. ниже):** (Зависимость) Для подписки на события.
- **`ConfigService` (1.3):** (Зависимость) Для получения `quoteCurrency` (e.g., 'USDT').
- **`LoggingService` (1.4):** (Зависимость).
- **`decimal.js` (1.2):** (Зависимость).

### 3.1. Реализация EventBus (Задача 4.5.1)

Разработчик _обязан_ создать `EventBusService` как Singleton, используя библиотеку `eventemitter3`, для реализации архитектуры, основанной на событиях.

- **Логика:** `EventBusService` _обязан_ наследоваться от `EventEmitter` из `eventemitter3` и быть строго типизирован, определяя интерфейс `TradeExecutedEvent` с полем `pair: string`.
- **Нюанс:** Класс _обязан_ иметь метод `emitTradeExecuted(pair: string)` для строго типизированной отправки события `trade_executed`.
- **Действие Разработчика:** Установка `npm install eventemitter3` и создание `src/services/EventBusService.ts` с необходимой структурой.

## 4\. Описание и Нюансы Реализации

### 4.1. Метод `refreshNow()` (Ядро Сбора)

1.  **Блокировка (Критично):** _обязан_ проверить, выполняется ли уже `refreshNow`. Если да, _обязан_ вернуть существующий `Promise` (ожидание), чтобы избежать дублирования запросов.
2.  **Параллельный Запрос с Retry (Критично):** _обязан_ использовать цикл retry (до `maxRetries`, например, 2) с задержкой между попытками для защиты от race condition. Внутри цикла _обязан_ использовать `Promise.all` для одновременного получения:
    - Балансы (`exchangeService.fetchBalance()`).
    - Активные позиции (`dbService.query('SELECT * FROM ActivePositions')`).
    - Активные ордера (`dbService.query('SELECT * FROM ActiveOrders WHERE status = $1', ['open'])`).
    - Состояние TSL (`dbService.query('SELECT * FROM TSL_State')`).
    - LLM триггеры (`dbService.query('SELECT * FROM llm_triggers')`).
3.  **Валидация данных:** После получения данных _обязан_ проверить, что все результаты являются массивами (`Array.isArray`). При несоответствии залогировать предупреждение и продолжить.

4.  **Парсинг Баланса (Критично):** _обязан_ использовать приватный метод `toDecimal(value)` для преобразования значений в `DecimalValue`. Для расчета:
    - `available_quote_balance`: извлечь `balanceData[quoteCurrency].free` через `toDecimal()`.
    - `total_portfolio_value_usdt`: извлечь `balanceData[quoteCurrency].total` через `toDecimal()` (для V1 используется как общий показатель).
    - `assets`: массив, который _обязан_ включать только активы, где `total > 0` (используя `Decimal.gt(0)`) и которые _не_ являются `quoteCurrency` (например, BTC, ETH, но не USDT). Пропускать служебные поля: `'info'`, `'free'`, `'used'`, `'total'`.
5.  **Парсинг Позиций:** Преобразовать строки из БД (`amount`, `average_entry_price`, `stop_loss_price`) в `DecimalValue` через `toDecimal()`. `stop_loss_price` может быть `null`.
6.  **Парсинг Ордеров:** Преобразовать данные ордеров, используя `exchange_order_id` как `id` (преобразовать в строку).
7.  **Парсинг TSL_State:** Для каждой записи TSL_State найти соответствующую позицию. Парсить `rule_config_json` через `JSON.parse()`. Формировать `TSLRule` с полями `pair`, `position`, `state` (с `currentStopPrice`, `currentStopOrderId`, `priceSeen`), `rule` (из `rule_config_json`). Сохранять в `Map<string, TSLRule>`.
8.  **Парсинг LLM_Triggers:** Для каждой записи парсить `trigger_conditions_json` (может быть строкой, массивом или объектом). Обработать различные форматы: строка -> `JSON.parse()`, массив -> использовать напрямую, объект -> `JSON.stringify()` + `JSON.parse()`. Сохранять в `Map<string, LLMTriggerCondition[]>`.

9.  **Обновление/Освобождение:** _обязан_ обновить `accountStateCache` новыми данными (включая `tslRules` и `llmTriggers` как `Map`) и _обязан_ снять блокировку (`refreshPromise = null`) в блоке `finally` (для гарантии).
10. **Отказоустойчивость:** _обязан_ использовать `try/catch` вокруг всего процесса. При ошибке _обязан_ залогировать ее (`error`) и оставить старый кэш, не "валяя" приложение. Логировать предупреждения при ошибках парсинга отдельных элементов (например, TSL или триггеров).

### 4.2. Обработчик `handleTradeExecuted` (Задача 4.5.1)

1.  **Подписка:** В конструкторе `AccountStateService` _обязан_ подписаться на `eventBus.on('trade_executed', ...)`.
2.  **Вызов:** Обработчик _обязан_ залогировать `debug` сообщение с указанием пары и немедленно вызвать `this.refreshNow()`.
3.  **Нюанс "Fire-and-Forget":** Вызов `refreshNow()` _не должен_ использовать `await`, чтобы не блокировать поток, в котором было сгенерировано событие (обычно это поток `Worker`\-а). _обязан_ использовать `.catch()` для асинхронной обработки ошибок с логированием `error`.

### 4.3. Метод `getAccountState()`

1.  _обязан_ быть **синхронным** и возвращать `accountStateCache` напрямую.

## 5\. Критерии Приемки (Acceptance Criteria)

1.  EventBusSetup

    `EventBusService` создан как Singleton и строго типизирован.

2.  Service

    `AccountStateService` создан как Singleton с методом `getInstance(configService, exchangeService, databaseService, eventBus)` и корректно получает все 4 необходимые зависимости через DI в конструкторе.

3.  Interface

    Созданы/дополнены интерфейсы `AssetBalance` и `AccountState`, где все финансовые поля имеют тип `Decimal | null`.

4.  Logic:Get

    `getAccountState()` _обязан_ быть синхронным и возвращать последнее состояние.

5.  Concurrency(Критично)

    `refreshNow()` _обязан_ реализовать механизм блокировки (`refreshPromise`) для предотвращения параллельного запуска.

6.  DataFetch

    `refreshNow()` _обязан_ использовать цикл retry с `Promise.all` для одновременного запроса `fetchBalance`, `ActivePositions`, `ActiveOrders`, `TSL_State` и `llm_triggers`.

7.  DataProcessing

    `refreshNow()` _обязан_ корректно рассчитывать и форматировать поля `available_quote_balance`, `total_portfolio_value_usdt` и `assets` (используя приватный метод `toDecimal()`). Также должен парсить и сохранять `tslRules` и `llmTriggers` в `Map`.

8.  Subscription(Задача4.5.1)

    `AccountStateService` _обязан_ подписаться на `eventBus.on('trade_executed', ...)`.

9.  Invalidation(Критично)

    Обработчик события _обязан_ вызывать `this.refreshNow().catch(...)` (fire-and-forget), обеспечивая немедленное обновление кэша после совершения сделки.

10. Robustness


    `refreshNow()` _обязан_ снимать блокировку (`refreshPromise = null`) в блоке `finally` и не должен "валить" приложение при сбое обновления.
