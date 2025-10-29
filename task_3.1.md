# Техническое Задание (ТЗ): 3.1 Клиент Биржи (ProductionExchangeService)

**Эпик:** 3. 🔌 Core-Сервисы и Клиенты (Core Services & Clients) **Задача:** 3.1 Клиент Биржи (ProductionExchangeService) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать **интерфейс** `IExchangeService`, определяющий "контракт" взаимодействия с биржей, и его "боевую" реализацию — класс `ProductionExchangeService`. Этот класс будет являться строго типизированной, отказоустойчивой оберткой над библиотекой `ccxt`, отвечающей за выполнение всех операций с биржей (Binance).

## 2\. Архитектурное Решение

1.  **Интерфейс (Контракт):** Мы _обязаны_ сначала определить `IExchangeService`. Все остальные сервисы (`Watcher`, `Worker`) _обязаны_ зависеть только от этого интерфейса. Это обеспечит легкую замену `ProductionExchangeService` на `MockExchangeService` (Задача 3.5) в режиме `DRY_RUN` или `TESTNET`.
2.  **Централизация Ошибок (Критично):** `ProductionExchangeService` _обязан_ перехватывать _все_ сырые ошибки `ccxt` (`NetworkError`, `RateLimitExceeded`, `InsufficientFunds`) и **транслировать** их в наши стандартизированные, кастомные ошибки. Это позволяет `WorkerService` (Эпик 7) надежно обрабатывать только знакомые ему типы ошибок (e.g., `InsufficientFundsError`).
3.  **Финансовая Точность (Критично):** `ccxt` возвращает финансовые данные как `number` или `string`. `ProductionExchangeService` _обязан_ конвертировать _все_ цены, объемы и суммы в экземпляры `Decimal` (из `decimal.js`) **немедленно** при получении, до того, как они покинут этот сервис.

## 3\. Зависимости Задачи

- `ccxt` / `@types/ccxt` (1.2): (Зависимость) Ядро клиента.
- `decimal.js` (1.2): (Зависимость) Для финансовой точности.
- `ConfigService` (1.3): (Зависимость) Для API ключей и режима `APP_MODE`.
- `LoggingService` (1.4): (Зависимость) Для логирования.
- `GlobalStateService` (1.6): (Зависимость) Для проверки `isShuttingDown` в циклах `watch`.

## 4\. Описание и Нюансы Реализации

### 4.1. Создание Файла 1: `src/errors/ExchangeErrors.ts`

1.  **Логика:** Разработчик _обязан_ создать и экспортировать иерархию кастомных классов ошибок.
2.  **Нюанс реализации:** Иерархия _обязана_ включать:
    - Базовый `ExchangeError`.
    - Специализированные классы, наследующие от него: `ExchangeNetworkError`, `ExchangeApiError`, `ExchangeRateLimitError`, **`InsufficientFundsError`**, `OrderNotFoundError`.
    - Это позволяет `Worker`\-у в `catch` блоке точно знать, с какой проблемой он столкнулся.

### 4.2. Создание Файла 2: `src/interfaces/IExchangeService.ts`

1.  **Логика:** Разработчик _обязан_ определить интерфейс, который _всегда_ возвращает данные, основанные на `Decimal`.
2.  **Нюанс реализации:** Интерфейс _обязан_ включать:
    - Типы данных: `IDecimalOHLCV`, `IDecimalTicker` (все поля цены/объема в которых — `Decimal`).
    - Методы `loadMarkets()`, `fetchOHLCV()`, `fetchTicker()`, `fetchOrderBook()`, `fetchBalance()`, `createOrder()`, `cancelOrder()`, `fetchOpenOrders()`, `fetchMyTrades()`.
    - Методы `watchTickers()` и `close()` (для Graceful Shutdown).

### 4.3. Создание Файла 3: `src/services/ProductionExchangeService.ts`

1.  **Конструктор и Инициализация:**
    - **Логика:** Конструктор _обязан_ инициализировать `ccxt.binance()` (с `defaultType: 'spot'`).
    - **Нюанс реализации:** Если `APP_MODE` (из `ConfigService`) равен `'testnet'`, конструктор _обязан_ вызвать `this.ccxtExchange.setSandboxMode(true)` и залогировать `warn`.

2.  **A. Метод-обертка `private async execute<T>(fn: () => Promise<T>)` (Критично):**
    - **Логика:** Этот метод _обязан_ быть вызван _каждым_ публичным REST-методом.
    - **Нюанс реализации:** Внутри `catch` блока _обязан_ быть `switch` или `if/else if` для **трансляции ошибок**:
      - `if (e instanceof ccxt.RateLimitExceeded)` -> `throw new ExchangeRateLimitError(...)`
      - `if (e instanceof ccxt.InsufficientFunds)` -> `throw new InsufficientFundsError(...)` (Критично для `Worker`!)
      - `if (e instanceof ccxt.NetworkError)` -> `throw new ExchangeNetworkError(...)`
      - Остальные ошибки `ccxt` _обязаны_ быть преобразованы в `ExchangeApiError` или базовый `ExchangeError`.

3.  **B. REST Методы (`fetchOHLCV`, `fetchTicker`):**
    - **Логика:** Эти методы _обязаны_ использовать `execute()` и _обязаны_ выполнять конвертацию в `Decimal`.
    - **Нюанс реализации:** Например, `fetchOHLCV` _обязан_ в цикле `map` брать сырые значения `ohlcv[1]`...`ohlcv[5]` и возвращать `new Decimal(ohlcv[n])` для каждого поля.

4.  **C. Метод `public async watchTickers(...)` (WebSocket):**
    - **Логика:** Этот метод _обязан_ запустить бесконечный цикл `while (!GlobalStateService.getIsShuttingDown())` вокруг `this.ccxtExchange.watchTickers()`.
    - **Нюанс реализации (Ошибка):** `catch` блок _внутри_ цикла `watch` _обязан_ использовать ту же логику трансляции ошибок (как в `execute`), залогировать `error` и добавить **паузу** (e.g., 5 секунд) _перед_ следующей итерацией цикла.
    - **Нюанс реализации (Decimal):** Полученный `ticker` _обязан_ быть преобразован в `IDecimalTicker` (e.g., `last: new Decimal(ticker.last)`) _перед_ вызовом `callback(decimalTicker)`.

5.  **D. Метод `public async close()` (Graceful Shutdown):**
    - **Логика:** Этот метод _обязан_ корректно закрыть все активные соединения.
    - **Нюанс реализации:** Он _обязан_ вызвать `await this.ccxtExchange.close()`.

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Interface

    Файл `IExchangeService.ts` создан и определяет _все_ необходимые методы, возвращающие _типы_ на основе `Decimal`.

2.  Errors

    Файл `ExchangeErrors.ts` создан и экспортирует иерархию ошибок, включая `ExchangeNetworkError` и **`InsufficientFundsError`**.

3.  Implementation

    Класс `ProductionExchangeService` создан и реализует `IExchangeService`.

4.  Config

    Конструктор _корректно_ настраивает `ccxt` и включает `setSandboxMode(true)`, если `APP_MODE` требует `testnet`.

5.  ErrorHandling(Критично)

    Метод `private execute()` _корректно_ перехватывает ошибки `ccxt` (`RateLimitExceeded`, `InsufficientFunds`, `NetworkError`) и _транслирует_ их в наши кастомные ошибки.

6.  Precision(Критично)

    Методы `fetchOHLCV`, `fetchTicker` и `watchTickers` _обязаны_ конвертировать _все_ финансовые данные в `Decimal` _до_ возврата.

7.  WebSocket

    `watchTickers` _корректно_ использует `while (!GlobalStateService.getIsShuttingDown())` для цикла, и _внутри_ `catch` блока _обязательно_ содержит логику паузы перед переподключением.

8.  Shutdown

    Метод `close()` реализован и вызывает `this.ccxtExchange.close()`.
