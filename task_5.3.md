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
- **`IExchangeService` (3.1 / 3.5):** (Зависимость) Для `watchTickers()` и `close()`.
- **`TSLHandlerService` (5.4):** (Зависимость) **(Будет создан в 5.4)** Обработчик Trailing Stop Loss.
- **`PriceTriggerHandler` (5.5):** (Зависимость) **(Будет создан в 5.5)** Обработчик `price` триггеров.

## 4\. Описание и Нюансы Реализации

### 4.1. Создание `src/services/FastCycleService.ts`

Разработчик должен создать `src/services/FastCycleService.ts` (Singleton), который принимает в конструкторе все 6 зависимостей.

### 4.2. Публичные Методы `start()` и `stop()`

- **`public start(): void`**
  - **Нюанс реализации:** Этот метод _не_ `async`. Он запускает _фоновый_ асинхронный цикл.
  - **Логика:**
    1.  Установить `this.isStopping = false;`
    2.  `this.logger.info("(FastCycle) Запуск...");`
    3.  Вызвать `this._runWebSocketLoop();` (без `await`).

- **`public async stop(): Promise<void>`**
  - **Нюанс реализации:** Этот метод _должен_ быть `async`, чтобы гарантировать "Graceful Shutdown".
  - **Логика:**
    1.  `this.logger.warn("(FastCycle) Остановка...");`
    2.  Установить `this.isStopping = true;`
    3.  Вызвать `await this.exchangeService.close();` (Этот метод (из Задачи 3.1) закроет WS-соединение, что приведет к выходу из цикла в `_runWebSocketLoop`).

### 4.3. Приватный Метод `private async _runWebSocketLoop(): Promise<void>`

Это "вечный" цикл, обеспечивающий переподключение.

- **Логика:**
  1.  Получить `const watchlist = this.config.getWatchlist();`
  2.  `while (!this.isStopping)`
  3.  `try {`
      - `this.logger.info("(FastCycle) Подключение к watchTickers...");`
      - `await this.exchangeService.watchTickers(watchlist, (ticker) => this._handleTickerData(ticker));`
      - `// Если мы здесь, значит ccxt "отвалился" штатно (без ошибки)`

  4.  `} catch (e: any) {`
      - `this.logger.error(`(FastCycle) Ошибка watchTickers: ${e.message}. Переподключение через 5 сек...`);`

  5.  `}`
  6.  `if (!this.isStopping) { await sleep(5000); }` (Вспомогательная функция `sleep`)

### 4.4. Приватный Метод `private _handleTickerData(ticker: Ticker): void`

Это "сердце" сервиса, вызываемое _на каждый "тик"_.

- **Нюанс реализации:** Этот метод **НЕ `async`**.
- **Логика:**
  1.  **Проверка Состояния (Критично):**
      - `if (this.globalState.isPaused() || this.globalState.isShuttingDown() || this.isStopping) { return; }`

  2.  **Блок `try/catch`:**
      - **`try {`**
        - `// (Задача 5.4) Делегирование TSL (без await)`
        - `this.tslHandler.handleTicker(ticker);`
        - `// (Задача 5.5) Делегирование Price Triggers (без await)`
        - `this.priceTriggerHandler.handleTicker(ticker);`

      - **`} catch (e: any) {`**
        - `this.logger.error(`(FastCycle) \[${ticker.symbol}\] КРИТИЧЕСКИЙ СБОЙ обработчика "тика": ${e.message}`, e.stack);`
        - `// (Не бросаем ошибку, чтобы не "убить" WS-цикл)`

      - **`}`**

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Service

    `FastCycleService.ts` создан и корректно принимает все 6 зависимостей (включая `TSLHandlerService` и `PriceTriggerHandler`).

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
