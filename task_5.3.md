# Техническое Задание (ТЗ): 5.3 "Быстрый Цикл" (FastCycleService - WebSocket)

**Эпик:** 5. 🔄 "Наблюдатель" (Watcher) - Синхронизация, Циклы и Триггеры **Задача:** 5.3. "Быстрый Цикл" (FastCycleService - WebSocket) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать `FastCycleService` (Singleton) — сервис, отвечающий за _постоянное_ подключение к WebSocket API биржи (`ccxt.watchTickers()`) и _немедленную_ (real-time) делегацию входящих "тиков" (обновлений цены) специализированным обработчикам (`TSLHandlerService` и `PriceTriggerHandler`).

## 2\. Архитектурное Решение

1.  **Отказоустойчивое Подключение:** `FastCycleService` отвечает за "вечное" подключение. Он должен инкапсулировать логику `while (true)` для _автоматического переподключения_ к `watchTickers` в случае обрыва связи, ошибки сети или закрытия WS-соединения биржей.
2.  **Гос. Контроль:** Сервис _обязан_ проверять `GlobalStateService` (`isPaused`, `isShuttingDown`). Если бот на паузе, он _не_ должен делегировать "тики" обработчикам.
3.  **Высокая Производительность (Критично):** Обработчик "тика" (`_handleTickerData`) _не должен_ быть `async` и _не должен_ содержать `await`. Его задача — мгновенно (в режиме "fire-and-forget") передать "тик" в `TSLHandlerService` (5.4) и `PriceTriggerHandler` (5.5). Любая задержка здесь приведет к "лагу" в обработке TSL и ценовых триггеров.
4.  **Делегирование:** Этот сервис — "диспетчер", а не "исполнитель". Он не содержит бизнес-логики TSL или триггеров; он только знает, _кому_ ее передать.

## 3\. Зависимости Задачи

- **`LoggingService` (1.4):** (Зависимость) Для логирования.
- **`ConfigService` (1.3):** (Зависимость) Для `getWatchlist()`.
- **`GlobalStateService` (1.6):** (Зависимость) Для `isPaused()`, `isShuttingDown()`.
- **`AccountStateService` (4.5):** (Зависимость) Для получения состояния аккаунта и проверки прибыли.
- **`IExchangeService` (3.1 / 3.5):** (Зависимость) Для `watchTickers()`, `close()`, `fetchTicker()`.
- **`TSLHandlerService` (5.4):** (Зависимость) Обработчик Trailing Stop Loss.
- **`PriceTriggerHandler` (5.5):** (Зависимость) Обработчик `price` триггеров.
- **`NotificationService` (1.5):** (Зависимость) Для отправки критических уведомлений.

## 4\. Описание и Нюансы Реализации

### 4.1. Создание `src/services/FastCycleService.ts`

Разработчик должен создать `src/services/FastCycleService.ts` (Singleton), который принимает в конструкторе все 7 зависимостей (включая `AccountStateService` и `NotificationService`).

### 4.2. Публичные Методы `start()` и `stop()`

- **`public start(): void`**
  - **Нюанс реализации:** Этот метод _не_ `async`. Он запускает _фоновый_ асинхронный цикл.
  - **Логика:**
    1.  Установить `this.isStopping = false;`
    2.  `this.logger.info("(FastCycle) Запуск...");`
    3.  Вызвать `this._runWebSocketLoop()` (без `await`, с обработкой ошибок через `.catch()`).
    4.  Вызвать `this._startProfitCheckTimer()` для запуска независимого таймера проверки прибыли (каждые 30 секунд).
    5.  Залогировать `info` о запуске WebSocket цикла.

- **`public async stop(): Promise<void>`**
  - **Нюанс реализации:** Этот метод _должен_ быть `async`, чтобы гарантировать "Graceful Shutdown".
  - **Логика:**
    1.  `this.logger.warn("(FastCycle) Остановка...");`
    2.  Установить `this.isStopping = true;`
    3.  Остановить таймер проверки прибыли: `if (this.profitCheckTimer) { clearInterval(this.profitCheckTimer); this.profitCheckTimer = null; }`
    4.  Вызвать `await this.exchangeService.close();` (Этот метод (из Задачи 3.1) закроет WS-соединение, что приведет к выходу из цикла в `_runWebSocketLoop`).
    5.  Залогировать `info` об остановке.

### 4.3. Приватный Метод `private async _runWebSocketLoop(): Promise<void>`

Это "вечный" цикл, обеспечивающий переподключение.

- **Логика:**
  1.  Получить `const watchlist = this.configService.getWatchlist();`
  2.  Инициализировать `const reconnectDelayMs = 5000;` (5 секунд) и `let loopIteration = 0;`
  3.  `while (!this.isStopping)`
  4.  Увеличить `loopIteration++`
  5.  `try {`
      - Залогировать `info` о подключении с количеством пар и номером итерации.
      - Запустить мониторинг тикеров один раз через `_startTickerMonitoring()` (если `!this.isMonitoringStarted`).
      - Запомнить `watchStartTime = Date.now()`.
      - Вызвать `await this.exchangeService.watchTickers(watchlist, async (ticker) => { this._handleTickerData(ticker); })` (callback обернут в async функцию).
      - Если выполнение дошло до этой точки, значит `watchTickers` завершился. Залогировать `warn` с длительностью работы и номером итерации.

  6.  `} catch (error) {`
      - Извлечь `errorMessage = error instanceof Error ? error.message : String(error);`
      - Проверить, содержит ли ошибка "Max reconnection attempts":
        - Если да, залогировать `error` критическую ошибку, отправить уведомление через `notificationService.sendAlert()`, прервать цикл (`break`).
      - Иначе залогировать `error` с номером итерации.
      - Если `!this.isStopping`, вызвать `await this._sleep(reconnectDelayMs)` перед переподключением.

  7.  `}`
  8.  Залогировать `info` о завершении вечного цикла.

### 4.4. Приватный Метод `private _handleTickerData(ticker: Ticker): void`

Это "сердце" сервиса, вызываемое _на каждый "тик"_.

- **Нюанс реализации:** Этот метод **НЕ `async`**.
- **Логика:**
  1.  Обновить метки времени: `this.lastTickerTime = Date.now()`, `this.tickerCount++`.
  2.  Логировать получение тикеров каждые 100 тикеров (`if (this.tickerCount % 100 === 0)`).
  3.  **Проверка Состояния (Критично):**
      - `if (this.globalState.getIsPaused() || this.globalState.getIsShuttingDown() || this.isStopping) { return; }`

  4.  **Блок `try/catch`:**
      - **`try {`**
        - `// (Задача 5.4) Делегирование TSL (без await)`
        - `this.tslHandler.handleTicker(ticker);`
        - `// (Задача 5.5) Делегирование Price Triggers (без await)`
        - `this.priceTriggerHandler.handleTicker(ticker);`
        - `// Проверка прибыли и автоматическое закрытие позиций (не чаще чем раз в 30 секунд)`
        - `if (now - this.lastProfitCheck > 30000 && !this.isCheckingProfit) {`
        -   Сохранить старое значение `lastProfitCheck`, установить флаг `this.isCheckingProfit = true`, обновить `this.lastProfitCheck = now`.
        -   Вызвать `this._checkAndClosePositionsIfProfitable().catch(...)` (без `await`, с обработкой ошибок).

      - **`} catch (error) {`**
        - `this.logger.error(`(FastCycle) [${ticker.symbol}] КРИТИЧЕСКИЙ СБОЙ обработчика "тика": ${String(error)}`, error);`
        - `// (Не бросаем ошибку, чтобы не "убить" WS-цикл)`

      - **`}`**

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Service

    `FastCycleService.ts` создан как Singleton с методом `getInstance(configService, globalState, accountState, exchangeService, tslHandler, priceTriggerHandler)` и корректно принимает все 7 зависимостей (включая `AccountStateService` и `NotificationService`).

2.  **\[API\]** `start()` корректно запускает `_runWebSocketLoop` в _фоновом режиме_ (без `await`).
3.  **\[API\]** `stop()` корректно устанавливает флаг `isStopping` и вызывает `await this.exchangeService.close()`.
4.  **\[Core (Loop)\]** `_runWebSocketLoop` реализован как "вечный" цикл (`while (!this.isStopping)`).
5.  **\[Core (Loop)\]** `_runWebSocketLoop` _корректно_ вызывает `await this.exchangeService.watchTickers()`, передавая ему `_handleTickerData` в качестве callback.
6.  **\[Core (Loop)\]** `_runWebSocketLoop` _корректно_ обрабатывает ошибки `watchTickers` (через `try/catch`) и реализует логику переподключения с задержкой (e.g., 5 секунд).
7.  **\[Core (Tick)\]** `_handleTickerData` (callback) _не_ является `async` и _не_ содержит `await`.
8.  **\[Core (Tick)\]** `_handleTickerData` _корректно_ проверяет `GlobalStateService` и флаг `isStopping` в _самом начале_.
9.  **\[Core (Tick)\]** _Вся_ логика делегирования в `_handleTickerData` обернута в `try/catch`.
10. **\[Delegation (5.4)\]** `_handleTickerData` _корректно_ вызывает `this.tslHandler.handleTicker(ticker)`.

11. **\[Delegation (5.5)\]** `_handleTickerData` _корректно_ вызывает `this.priceTriggerHandler.handleTicker(ticker)`.

12. **\[ProfitCheck\]** Реализован метод `_checkAndClosePositionsIfProfitable()` для проверки общей прибыли и автоматического закрытия позиций при прибыли > 10 USD.

13. **\[ProfitCheck\]** Реализован метод `_calculateTotalProfit()` для расчета общей прибыли всех позиций с учетом комиссий биржи.

14. **\[ProfitCheck\]** Реализован метод `_closeAllPositions()` для закрытия всех открытых позиций через market ордера.

15. **\[ProfitCheck\]** Реализован метод `_cleanupDatabaseAfterCloseAll()` для очистки БД и пересоздания триггеров после закрытия всех позиций.

16. **\[ProfitCheck\]** Реализован метод `_startProfitCheckTimer()` для запуска независимого таймера проверки прибыли каждые 30 секунд.

17. **\[Monitoring\]** Реализован метод `_startTickerMonitoring()` для мониторинга получения тикеров и обнаружения проблем с WebSocket соединением.

18. **\[Monitoring\]** Реализован метод `_sleep(ms)` для вспомогательной паузы.

19. **\[Reconnection\]** `_runWebSocketLoop` обрабатывает ошибку "Max reconnection attempts" и отправляет критическое уведомление при достижении лимита переподключений.

20. **\[TickCount\]** `_handleTickerData` обновляет счетчик тикеров и логирует получение тикеров каждые 100 тикеров.
