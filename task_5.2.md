# Техническое Задание (ТЗ): 5.2 "Медленный Цикл" (SlowCycleService)

**Эпик:** 5. 🔄 "Наблюдатель" (Watcher) - Синхронизация, Циклы и Триггеры **Задача:** 5.2 (SlowCycleService) и 5.2.1 (Stop-Loss Janitor) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать `SlowCycleService` (Singleton) — главный "пульс" приложения на основе `node-cron`. Этот сервис отвечает за периодические задачи: обновление кэша, плановую сверку состояния, проверку `timeout/indicator` триггеров и выполнение аварийной проверки `Stop-Loss Janitor` (Задача 5.2.1).

## 2\. Архитектурное Решение

1.  **`setInterval`:** Сервис инкапсулирует `setInterval` (интервал загружается из `ConfigService`, e.g., `60000` мс).
2.  **Отказоустойчивость:** Каждый "тик" (tick) `setInterval` должен быть полностью обернут в `try/catch`. Сбой одного тика не должен останавливать `setInterval`.
3.  **Гос. Контроль:** "Тик" _обязан_ немедленно прерываться (`return`), если `GlobalStateService` находится в состоянии `isPaused` или `isShuttingDown`.
4.  **"Stop-Loss Janitor" (5.2.1):** Эта логика является _неотъемлемой частью_ `SlowCycleService` и выполняется в конце каждого "тика". Она _обязана_ использовать `PairActorManagerService` (Задача 9.1) для принудительного закрытия, чтобы избежать "гонки" с "Быстрым Циклом".
5.  **Indicator Triggers:** Для проверки индикаторных триггеров (`RSI < 30`) этот сервис будет использовать `MarketDataService` (4.2) и `TAEngineService` (4.1).

## 3\. Зависимости Задачи

- **`LoggingService` (1.4):** (Зависимость) Для логирования.
- **`ConfigService` (1.3):** (Зависимость) Для `getSlowCycleIntervalMs()`.
- **`GlobalStateService` (1.6):** (Зависимость) Для `isPaused()`, `isShuttingDown()`.
- **`AccountStateService` (4.5):** (Зависимость) Для `refreshNow()` и `getAccountState()`.
- **`SyncEngineService` (5.0):** (Зависимость) Для `reconcileStateAll()`.
- **`DatabaseService` (2.3):** (Зависимость) Для чтения `LLM_Triggers`.
- **`MarketDataService` (4.2):** (Зависимость) Для `fetchOHLCV()` (для `indicator` триггеров).
- **`TAEngineService` (4.1):** (Зависимость) Для `getAnalysis()` (для `indicator` триггеров).
- **`WatcherOrchestratorService` (5.6):** (Зависимость) Для `executeOrchestration()`.
- **`IExchangeService` (3.1 / 3.5):** (Зависимость) Для `fetchTickers()` (для `Stop-Loss Janitor`).
- **`PairActorManagerService` (9.1):** (Зависимость) Для `execute()` (для `Stop-Loss Janitor`).
- **`WorkerService` (7.1):** (Зависимость) Для `execute()` (для `Stop-Loss Janitor`).
- **`NotificationService` (1.5):** (Зависимость) Для `sendAlert()` (для `Stop-Loss Janitor`).

## 4\. Описание и Нюансы Реализации

### 4.1. Создание `src/services/SlowCycleService.ts`

Разработчик должен создать `src/services/SlowCycleService.ts` (Singleton), который принимает в конструкторе все 13 зависимостей.

### 4.2. Публичные Методы `start()` и `stop()`

- **`public start(): void`**
  - **Нюанс реализации:** Этот метод _не_ `async`.
  - **Логика:**
    1.  Читает `intervalMs` из `ConfigService`.
    2.  Вызывает `this.logger.info(`(SlowCycle) Запуск с интервалом ${intervalMs} мс...`);`
    3.  Сохраняет `this.intervalId = setInterval(() => this.runTick(), intervalMs);`
    4.  **(Важно)** _Немедленно_ вызывает `this.runTick()` один раз при старте (не дожидаясь первого `setInterval`), чтобы заполнить кэши.

- **`public stop(): void`**
  - **Логика:**
    1.  `this.logger.warn("(SlowCycle) Остановка...");`
    2.  `if (this.intervalId) { clearInterval(this.intervalId); }`

### 4.3. Приватный Метод `private async runTick(): Promise<void>`

Это "сердце" сервиса.

- **Логика:**
  1.  **Проверка Состояния:**
      - `if (this.globalState.isPaused() || this.globalState.isShuttingDown()) { ... return; }`

  2.  **Блок `try/catch`:**
      - **`try {`**
        - `this.logger.info("(SlowCycle) Тик ЗАПУЩЕН.");`
        - **Шаг 1. Обновление Кэша:** `await this.accountStateService.refreshNow();`
        - **Шаг 2. Плановая Сверка:** `await this.syncEngine.reconcileStateAll();`
        - **Шаг 3. Проверка Триггеров:** `await this._checkTriggers();`
        - **Шаг 4. Аварийный SL (5.2.1):** `await this._runStopLossJanitor();`
        - `this.logger.info("(SlowCycle) Тик ЗАВЕРШЕН.");`

      - **`} catch (e: any) {`**
        - `this.logger.error(`(SlowCycle) КРИТИЧЕСКИЙ СБОЙ "Медленного Цикла": ${e.message}`, e.stack);`
        - `// (Не бросаем ошибку, чтобы setInterval() продолжил работу)`

      - **`}`**

### 4.4. Приватный Метод `private async _checkTriggers(): Promise<void>`

- **Нюанс реализации:** Этот метод должен быть отказоустойчивым; сбой проверки одного триггера не должен останавливать цикл.
- **Логика:**
  1.  Получить `const allTriggers = await this.dbService.query("SELECT * FROM LLM_Triggers");`
  2.  `for (const row of allTriggers.rows)`
  3.  `try {`
      - `const pair = row.pair;`
      - `const conditions = JSON.parse(row.triggers_json);`
      - **Проверить `timeout` триггеры:** (e.g., `if (condition.type === 'timeout' && Date.now() > condition.timestamp) ...`)
      - **Проверить `indicator` триггеры:**
        - `if (condition.type === 'indicator')`
        - Получить `const ohlcv = await this.marketData.fetchOHLCV(pair, condition.timeframe);`
        - Получить `const analysis = await this.taEngine.getAnalysis(ohlcv, []);`
        - (e.g., `if (condition.name === 'rsi' && analysis['1h'].rsi.lessThan(condition.value)) ...`)

      - **Если триггер сработал (hit):**
        - `this.logger.info(`(SlowCycle) \[${pair}\] Сработал ${condition.type} триггер.`);`
        - `this.orchestrator.executeOrchestration(pair, "SlowCycle Trigger");` (Вызвать _без_ `await` - Задача 9.3).
        - **(Важно)** _Прервать_ цикл `for` (внутренний) для этой _пары_ (т.к. "Оркестратор" уже запущен).

  4.  `} catch (e: any) { this.logger.error(`(SlowCycle) \[${row.pair}\] Ошибка проверки триггера: ${e.message}`); }`

### 4.5. Приватный Метод `private async _runStopLossJanitor(): Promise<void>` (Задача 5.2.1)

Это аварийный предохранитель.

- **Логика:**
  1.  `const accountState = this.accountStateService.getAccountState();`
  2.  `if (!accountState.active_positions || accountState.active_positions.length === 0) return;`
  3.  Получить `const tickers = await this.exchangeService.fetchTickers(this.config.getWatchlist());`
  4.  `for (const position of accountState.active_positions)`
  5.  `try {`
      - Получить `const ticker = tickers[position.pair];`
      - `const currentPrice = new Decimal(ticker.last);`
      - `const slPrice = new Decimal(position.stop_loss_price);`
      - Определить `const isBreached = (position.side === 'long' && currentPrice.lessThan(slPrice)) || ...`
      - **Если `isBreached`:**
        - `this.logger.fatal(`(StopLossJanitor) \[${position.pair}\] ФАТАЛЬНАЯ ОШИБКА: Цена ${currentPrice} ПРОБИЛА SL ${slPrice}, но позиция НЕ ЗАКРЫТА! Запуск принудительного закрытия.`);`
        - **(Задача 9.2)** `this.pairActorManager.execute(position.pair, async () => { ... })` (Вызвать _без_ `await`):
          - `(async () => {`
          - `await this.notificationService.sendAlert("... (StopLossJanitor FATAL) ...", true);`
          - `await this.workerService.execute({ action: 'CLOSE_POSITION', pair: position.pair, parameters: { type: 'market', amount_percent: 100 } }, null);` (null, т.к. лога LLM нет)
          - `});`

        - `.catch((e) => { ... (Логировать ошибку "актора") ... });`

  6.  `} catch (e: any) { this.logger.error(`(StopLossJanitor) \[${position.pair}\] Ошибка проверки SL: ${e.message}`); }`

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Service

    `SlowCycleService.ts` создан и корректно принимает все 13 зависимостей.

2.  **\[API\]** `start()` корректно запускает `setInterval` (используя интервал из `ConfigService`) и `runTick()` один раз при старте.
3.  **\[API\]** `stop()` корректно вызывает `clearInterval()`.
4.  **\[Core\]** `runTick()` _корректно_ проверяет `GlobalStateService` (`isPaused`, `isShuttingDown`) в _самом начале_.
5.  **\[Core\]** _Вся_ основная логика `runTick()` (Шаги 1-4) обернута в `try/catch` для предотвращения остановки `setInterval`.
6.  **\[Core (Шаг 1)\]** `runTick()` _корректно_ вызывает `await this.accountStateService.refreshNow()`.
7.  **\[Core (Шаг 2)\]** `runTick()` _корректно_ вызывает `await this.syncEngine.reconcileStateAll()`.
8.  **\[Core (Шаг 3)\]** Реализован приватный метод `_checkTriggers()`.
9.  **\[Triggers\]** `_checkTriggers()` _корректно_ читает `LLM_Triggers` из `DatabaseService`.
10. **\[Triggers\]** `_checkTriggers()` _корректно_ реализует логику проверки `timeout` и `indicator` (используя `TAEngineService`).

11. **\[Triggers\]** `_checkTriggers()` _корректно_ вызывает `this.orchestrator.executeOrchestration()` _без_ `await`.

12. **\[Janitor (Задача 5.2.1)\]** Реализован приватный метод `_runStopLossJanitor()`.

13. **\[Janitor (Logic)\]** `_runStopLossJanitor()` _корректно_ получает `accountState` и `tickers` (из `IExchangeService`).

14. **\[Janitor (Logic)\]** `_runStopLossJanitor()` _корректно_ использует `decimal.js` для сравнения `currentPrice` и `slPrice`.

15. **\[Janitor (Concurrency)\]** `_runStopLossJanitor()` _корректно_ вызывает `this.pairActorManager.execute()` _без_ `await` в случае `isBreached`.

16. **\[Janitor (Action)\]** Внутри "актора", `_runStopLossJanitor()` _корректно_ вызывает `notificationService.sendAlert` и `workerService.execute` (с `CLOSE_POSITION (Market)` и `llmLogId = null`).
