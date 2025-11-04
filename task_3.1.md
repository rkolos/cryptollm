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
    - **Логика:** Конструктор _обязан_ инициализировать `ccxt.binance()` с параметрами:
      - `apiKey` и `secret` из `ConfigService.getBinanceConfig()`
      - `enableRateLimit: true` (включение автоматического rate limiting)
      - `enableTimeSync: true` (включение автоматической синхронизации времени)
      - `timeout: 30000` (30 секунд таймаут HTTP запросов)
      - `options.defaultType: 'spot'` (спотовая торговля)
      - `options.recvWindow: 10000` (10 секунд окно времени для надежности)
    - **Нюанс реализации:** Если `APP_MODE` (из `ConfigService`) равен `'testnet'`, конструктор _обязан_ вызвать `this.ccxtExchange.setSandboxMode(true)` и залогировать `warn`.
    - **Синхронизация времени:** Для testnet режима добавлен механизм синхронизации времени через `_syncTimeOnce()`, который вызывается при первом запросе в методе `execute()`.

2.  **A. Метод-обертка `private async execute<T>(fn: () => Promise<T>, maxRetries: number = 5)` (Критично):**
    - **Логика:** Этот метод _обязан_ быть вызван _каждым_ публичным REST-методом.
    - **Нюанс реализации:**
      - **Синхронизация времени:** Для testnet режима вызвать `_syncTimeOnce()` при первом запросе, если `timeSyncDone === false`.
      - **Механизм Retry:** Реализовать цикл повторов (до `maxRetries` попыток) с экспоненциальной задержкой:
        - Для сетевых ошибок (`NetworkError`, timeout) повторить запрос с задержкой `retryDelayMs * (attempt + 1)` (начинается с 2 секунд).
        - Для ошибок timestamp (-1021) в testnet режиме пересинхронизировать время и повторить без задержки.
        - Логировать каждую попытку и успех после retry.
      - **Трансляция ошибок:** Внутри `catch` блока _обязан_ быть `if/else if` для **трансляции ошибок**:
        - `if (e instanceof ccxt.RateLimitExceeded)` -> `throw new ExchangeRateLimitError(...)`
        - `if (e instanceof ccxt.InsufficientFunds)` -> `throw new InsufficientFundsError(...)` (Критично для `Worker`!)
        - `if (e instanceof ccxt.NetworkError)` -> `throw new ExchangeNetworkError(...)`
        - `if (e instanceof ccxt.OrderNotFound)` -> `throw new OrderNotFoundError(...)`
        - `if (e instanceof ccxt.BaseError)` -> `throw new ExchangeApiError(...)`
        - Остальные ошибки _обязаны_ быть преобразованы в базовый `ExchangeError`.
      - После исчерпания всех попыток пробросить финальную ошибку.

3.  **B. REST Методы (`fetchOHLCV`, `fetchTicker`):**
    - **Логика:** Эти методы _обязаны_ использовать `execute()` и _обязаны_ выполнять конвертацию в `Decimal`.
    - **Нюанс реализации:** Например, `fetchOHLCV` _обязан_ в цикле `map` брать сырые значения `ohlcv[1]`...`ohlcv[5]` и возвращать `new Decimal(ohlcv[n])` для каждого поля.

4.  **C. Метод `public async watchTickers(...)` (WebSocket):**
    - **Логика:** Этот метод _обязан_ реализовать WebSocket подключение напрямую (не через `ccxt.watchTickers()`), используя библиотеку `ws`.
    - **Нюанс реализации:**
      - **Построение URL:** Использовать метод `_buildWebSocketUrl(symbols)` для построения WebSocket URL (разные для testnet и production).
      - **Основной цикл:** Запустить бесконечный цикл `while (!GlobalStateService.getInstance().getIsShuttingDown())`.
      - **Ограничение попыток:** Отслеживать количество попыток переподключения (`wsReconnectAttempts`) с максимумом `maxReconnectAttempts` (например, 10). При достижении максимума пробросить ошибку.
      - **Подключение:** Создать WebSocket соединение с таймаутом подключения (например, 10 секунд). Обработать события `open`, `error`, `unexpected-response`.
      - **Обработка сообщений:** В обработчике `message` парсить JSON, преобразовывать в `IDecimalTicker` через `_parseBinanceTicker()`, вызывать `callback()` асинхронно (не блокируя обработку).
      - **Переподключение:** При неожиданном закрытии соединения (код не 1000) использовать экспоненциальную задержку `reconnectDelay(attempt)` (от 1 секунды до максимума 30 секунд) перед следующей попыткой.
      - **Graceful Shutdown:** При `getIsShuttingDown() === true` закрыть соединение с кодом 1000 и завершить цикл.
    - **Нюанс реализации (Парсинг):** Метод `_parseBinanceTicker()` должен обрабатывать различные форматы сообщений Binance WebSocket и преобразовывать данные в `IDecimalTicker` с использованием `toDecimal()` для всех финансовых полей.
    - **Нюанс реализации (Ошибки):** Все ошибки парсинга и обработки должны логироваться, но не прерывать цикл. Ошибки переподключения логируются и обрабатываются с паузой перед следующей попыткой.

5.  **D. Метод `public async close()` (Graceful Shutdown):**
    - **Логика:** Этот метод _обязан_ корректно закрыть все активные соединения.
    - **Нюанс реализации:**
      - Если WebSocket соединение открыто (`this.wsConnection`), закрыть его с кодом 1000 ('Normal closure') и обнулить ссылку.
      - Вызвать `await this.ccxtExchange.close()` для закрытия всех соединений CCXT.
      - Залогировать `info` о закрытии соединений.

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

    Метод `close()` реализован и закрывает WebSocket соединение (если открыто) и вызывает `this.ccxtExchange.close()`.

9.  Retry

    Метод `execute()` реализует механизм повторов (до 5 попыток) для сетевых ошибок и ошибок timeout с экспоненциальной задержкой.

10. TimeSync

    Для testnet режима реализована синхронизация времени через `_syncTimeOnce()` при первом запросе и при ошибках timestamp (-1021).

11. WebSocket

    Метод `watchTickers()` реализован через прямое WebSocket подключение с автоматическим переподключением, экспоненциальной задержкой и ограничением попыток.
