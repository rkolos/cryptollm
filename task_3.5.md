# Техническое Задание (ТЗ): 3.5 Симулятор Биржи (MockExchangeService)

**Эпик:** 3. 🔌 Core-Сервисы и Клиенты (Core Services & Clients) **Задача:** 3.5 (Переименована): Симулятор Биржи (MockExchangeService) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать **Singleton-сервис** `MockExchangeService`, который _полностью_ реализует интерфейс `IExchangeService` (из Задачи 3.1) для обеспечения режима `DRY_RUN`.

Этот сервис должен симулировать поведение биржи (балансы, исполнение ордеров, комиссии) полностью в **`in-memory`**, без каких-либо реальных API-вызовов. Это критически важный компонент для безопасной отладки `WorkerService` (Эпик 7) и `SyncEngine` (Эпик 5).

## 2\. Архитектурное Решение

1.  **Полная Изоляция:** Сервис _обязан_ работать исключительно с `in-memory` состоянием. Он не должен зависеть от БД (`DatabaseService`) и не должен совершать сетевых вызовов.
2.  **Точность (Критично):** Все операции с балансами, ценами, суммами и комиссиями _обязаны_ использовать `decimal.js` для предотвращения ошибок с плавающей запятой в симуляции.
3.  **Симуляция Исполнения:** Для `market` ордеров сервис _обязан_ имитировать **мгновенное исполнение** с применением всех правил (`precision`, `minNotional`, `takerFee`) и немедленно обновлять внутреннее состояние балансов.
4.  **Симуляция Блокировки:** Для `limit`/`stop` ордеров сервис _обязан_ имитировать **блокировку** средств (уменьшение `available` баланса без изменения `total`).
5.  **Интерфейс `IExchangeService`:** Сервис _обязан_ быть полностью взаимозаменяем с `ProductionExchangeService`.

## 3\. Зависимости Задачи

- **`IExchangeService` (3.1):** Реализуемый интерфейс.
- **`ConfigService` (1.3):** Для получения _начальных_ балансов симулятора (e.g., `DRY_RUN_INITIAL_USDT`).
- **`ExchangeRulesService` (3.2):** (Критично) Для получения правил (`takerFee`, `minNotional`, `precision`) для _корректной_ симуляции исполнения.
- **`LoggingService` (1.4):** Для логирования действий симулятора.
- **`decimal.js` (1.2):** (Критично) Для _всех_ внутренних расчетов.
- **`crypto` (Node.js встроенный модуль):** Для генерации `id` ордеров и сделок через `randomUUID()`.

## 4\. Описание и Нюансы Реализации

### 4.1. Внутреннее Состояние (In-Memory State)

1.  **Логика:** Разработчик _обязан_ определить внутренние хранилища, использующие `Map<string, ...>`.
2.  **Нюанс реализации:**
    - `balances`: `Map<string, { total: Decimal, available: Decimal }>`. Это основной источник истины.
    - `openOrders`: `Map<string, ExchangeOrder>`. Для хранения незавершенных `limit`/`stop` ордеров.
    - `tradeHistory`: Массив `ExchangeTrade[]`. Для сохранения записей о завершенных сделках.
    - `currentPrices`: `Map<string, Decimal>`. Для симуляции текущей цены (используется для `market` ордеров).

### 4.2. Инициализация и Зависимости

1.  **Логика:** В конструкторе _обязан_ быть инициализирован начальный баланс `USDT` (из `ConfigService.getDryRunInitialBalance()`).
2.  **Нюанс реализации:**
    - Сохранить `this.configService` и `this.exchangeRulesService` в приватных полях.
    - Инициализировать `this.balances` с начальным балансом USDT как `Decimal`.
    - Инициализировать пустые `Map` для `openOrders`, `tradeHistory`, `currentPrices`, `markets`.
    - Залогировать `warn` о том, что используется in-memory симуляция с указанием начального баланса.

### 4.3. Реализация Метода `createOrder` (Критичный)

Этот метод должен содержать сложную логику, разделенную на две ветки:

1.  **Общие Шаги (Для `market` и `limit`):**
    - _Шаг А: Округление._ _обязан_ использовать приватные методы `amountToPrecision(pair, amount)` и `priceToPrecision(pair, price)` (с правилами из `ExchangeRulesService`) для округления `amount` и `price`. Эти методы используют `precision.amount` и `precision.price` из правил для расчета точности.
    - _Шаг Б: Определение цены исполнения._ Для `market` ордеров использовать цену из `currentPrices.get(symbol)` или дефолтное значение (например, 30000). Для `limit` ордеров использовать округленную цену из параметра.
    - _Шаг В: Валидация._ _обязан_ проверить _округленную_ стоимость ордера (`cost = roundedAmount * executionPrice`) на соответствие `minNotional`. Если не соответствует, бросить `Error` с описанием проблемы.
    - _Шаг Г: Проверка Баланса._ _обязан_ определить требуемую валюту (`requiredCurrency = side === 'buy' ? quoteCurrency : baseCurrency`) и требуемую сумму (`requiredAmount = side === 'buy' ? cost : roundedAmount`). Проверить `available` баланс. Если недостаточно, бросить `InsufficientFundsError`.

2.  **Ветка `type: 'market'` (Исполнение):**
    - **Логика:** _обязан_ имитировать немедленное исполнение.
    - **Нюанс реализации:**
      - Рассчитать комиссию: `fee = cost * takerFee`.
      - Рассчитать чистую стоимость: `netCost = side === 'buy' ? cost + fee : cost - fee`.
      - Для `buy`: заблокировать `netCost` из quote валюты (USDT), затем уменьшить `total` и `available` quote валюты на `netCost`, увеличить `total` и `available` базовой валюты на `roundedAmount`.
      - Для `sell`: заблокировать `roundedAmount` из базовой валюты, затем уменьшить `total` и `available` базовой валюты на `roundedAmount`, увеличить `total` и `available` quote валюты на `netCost`.
      - Создать `MockTrade` с `id = randomUUID()`, `order = orderId`, `price = executionPrice`, `amount = roundedAmount`, `cost = cost`, `fee = {cost: fee, currency: quoteCurrency}`, `timestamp = Date.now()`.
      - Добавить сделку в `tradeHistory`.
      - Вернуть ордер со статусом `'closed'`, `filled = roundedAmount`, `remaining = 0`.

3.  **Ветка `type: 'limit'` или `type: 'stop'` (Блокировка):**
    - **Логика:** _обязан_ имитировать размещение ордера в "стакан".
    - **Нюанс реализации:**
      - Определить требуемую сумму для блокировки: `requiredAmount = side === 'buy' ? cost : roundedAmount`.
      - Использовать приватный helper-метод (`lockFunds(requiredCurrency, requiredAmount)`) для **блокировки** необходимой суммы (уменьшить `available` баланс, `total` не менять).
      - Создать `MockOrder` с `id = randomUUID()`, `symbol`, `type`, `side`, `amount = roundedAmount`, `price = orderPrice`, `status = 'open'`, `timestamp = Date.now()`.
      - Добавить ордер в `openOrders` с ключом `orderId`.
      - Вернуть ордер со статусом `'open'`.

### 4.4. Реализация Метода `cancelOrder` (Критичный)

1.  **Логика:** _обязан_ проверить, что ордер существует и имеет статус `'open'`.
2.  **Нюанс реализации:**
    - Найти ордер в `openOrders` по `orderId`.
    - Если ордер не найден, бросить `OrderNotFoundError`.
    - Определить требуемую сумму для разблокировки: `requiredAmount = order.side === 'buy' ? order.amount * order.price : order.amount`.
    - Определить валюту: `requiredCurrency = order.side === 'buy' ? quoteCurrency : baseCurrency`.
    - Использовать приватный helper-метод (`unlockFunds(requiredCurrency, requiredAmount)`) для **разблокировки** средств (вернуть сумму в `available` баланс).
    - Удалить ордер из `openOrders`.
    - Ордер не сохраняется в отдельную историю (так как он уже в `openOrders`), просто удаляется.

### 4.5. Реализация Метода `fetchBalance`

1.  **Логика:** _обязан_ преобразовать внутренний `in-memory` формат (`Map<string, MockBalance>`) в формат `IDecimalBalance` (с полями `Decimal`).
2.  **Нюанс реализации:**
    - Для каждой валюты в `balances` создать объект с полями `free = balance.available`, `used = balance.total - balance.available`, `total = balance.total`.
    - Все поля должны быть типа `DecimalValue` (не строки, так как интерфейс `IExchangeService` использует `Decimal`).

### 4.6. Реализация Метода `watchTickers`

1.  **Логика:** Этот метод _не должен_ создавать реальных WebSocket-подключений.
2.  **Нюанс реализации:** Для соответствия интерфейсу метод _обязан_ быть реализован как заглушка, которая только логирует вызов (`debug` или `warn`), но _не блокирует_ поток, и _не должен_ содержать бесконечных циклов (`while(true)`), типичных для реального `ccxt.watchTickers`. Метод должен быть асинхронным (`async`) и возвращать `Promise<void>` немедленно.

### 4.7. Реализация Метода `loadMarkets`

1.  **Логика:** Метод должен создавать фиктивные рынки на основе правил из `ExchangeRulesService`.
2.  **Нюанс реализации:**
    - Получить `watchlist` из `ConfigService.getWatchlist()`.
    - Для каждой пары получить правила через `exchangeRulesService.getRules(pair)`.
    - Создать объект рынка с полями: `id`, `symbol`, `precision` (из правил, преобразованные в `number`), `limits.cost.min` (из правил, преобразованное в `number`), `fees.taker` (из правил, преобразованное в `number`).
    - Сохранить рынок в `this.markets[pair]`.
    - Залогировать `info` о загрузке рынков.

### 4.8. Реализация Метода `getRawMarkets`

1.  **Логика:** Метод должен возвращать `Record<string, unknown>` с фиктивными рынками, созданными в `loadMarkets()`.

### 4.9. Реализация Методов `fetchOHLCV`, `fetchTicker`, `fetchOrderBook`

1.  **Логика:** Эти методы должны возвращать фиктивные данные на основе `currentPrices`.
2.  **Нюанс реализации:**
    - `fetchOHLCV`: Вернуть массив с одной свечой, где цена берется из `currentPrices` или дефолтное значение (30000). Цены `high` и `low` вычисляются как ±1% от текущей цены.
    - `fetchTicker`: Вернуть тикер с ценой из `currentPrices`, `bid` и `ask` как ±0.01% от текущей цены, фиктивные объемы.
    - `fetchOrderBook`: Вернуть стакан с одной заявкой на покупку и одной на продажу по ценам ±0.1% от текущей цены.

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Service

    `MockExchangeService` создан как Singleton и _полностью_ реализует `IExchangeService`.

2.  Init

    Конструктор корректно получает и использует `ConfigService` и `ExchangeRulesService` через DI.

3.  BalanceInit

    Начальный баланс `USDT` корректно инициализируется (из `ConfigService`) и хранится как `Decimal`.

4.  Precision/Rules

    `MockExchangeService` _корректно_ использует `ExchangeRulesService` для получения `precision` и `minNotional` при каждом вызове `createOrder`.

5.  MarketLogic(Критично)

    `createOrder` (type: 'market') _немедленно_ (но с расчетами) исполняет ордер, обновляет `total` и `available` балансы, и применяет `takerFee`.

6.  LimitLogic(Критично)

    `createOrder` (type: 'limit') _корректно_ блокирует средства (уменьшает `available` баланс), и _не_ меняет `total` баланс.

7.  Errors

    `createOrder` _корректно_ бросает `InsufficientFundsError` и `Error` (если нарушен `minNotional` или отсутствует цена для limit ордера).

8.  CancelLogic

    `cancelOrder` _корректно_ разблокирует средства (увеличивает `available` баланс).

9.  DataOutput

    `fetchBalance` и другие `fetch*` методы возвращают данные с типами `DecimalValue` (не строки), как того требует интерфейс `IExchangeService`.

10. LoadMarkets

    Метод `loadMarkets()` создает фиктивные рынки на основе правил из `ExchangeRulesService` для всех пар из watchlist.

11. FetchMethods

    Методы `fetchOHLCV`, `fetchTicker`, `fetchOrderBook` возвращают фиктивные данные на основе `currentPrices` или дефолтных значений.

10. TSLSim


    Добавлен публичный метод `setMockPrice(pair, price)` для возможности управления симулируемой ценой из тестов (`Worker` и `SyncEngine`).
