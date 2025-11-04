# Техническое Задание (ТЗ): 5.2 "Медленный Цикл" (SlowCycleService)

**Эпик:** 5. 🔄 "Наблюдатель" (Watcher) - Синхронизация, Циклы и Триггеры **Задача:** 5.2 (SlowCycleService) и 5.2.1 (Stop-Loss Janitor) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать `SlowCycleService` (Singleton) — главный "пульс" приложения на основе `node-cron`. Этот сервис отвечает за периодические задачи: обновление кэша, плановую сверку состояния, проверку `timeout/indicator` триггеров и выполнение аварийной проверки `Stop-Loss Janitor` (Задача 5.2.1).

## 2\. Архитектурное Решение

1.  **`node-cron`:** Сервис использует библиотеку `node-cron` для надежного планирования задач (интервал загружается из `ConfigService`, e.g., `60000` мс, и конвертируется в cron выражение через приватный метод `_msToCronExpression`).
2.  **Отказоустойчивость:** Каждый "тик" (tick) должен быть полностью обернут в `try/catch`. Каждый шаг внутри тика (обновление кэша, сверка, проверка триггеров, janitor) также обернут в отдельный `try/catch` для максимальной отказоустойчивости. Сбой одного тика или шага не должен останавливать cron задачу.
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
    2.  Конвертирует интервал в cron выражение через приватный метод `_msToCronExpression(intervalMs)`:
        - Если интервал >= 60 минут, использует часы (`0 */${hours} * * *`).
        - Если интервал < 1 минуты, использует минимальный интервал 1 минута (`* * * * *`) и логирует `warn`.
        - Иначе использует минуты (`*/${minutes} * * * *`).
    3.  Валидирует cron выражение через `cron.validate(cronExpression)` и выбрасывает ошибку при невалидном выражении.
    4.  Создает cron задачу через `cron.schedule(cronExpression, callback, { timezone: 'UTC' })` и сохраняет в `this.cronJob`.
    5.  Вызывает `checkOverdueTriggersOnStartup()` для проверки просроченных триггеров при старте (без `await`, с обработкой ошибок).
    6.  После завершения проверки просроченных триггеров вызывает `runTick()` один раз (без `await`, с обработкой ошибок).

- **`public stop(): void`**
  - **Логика:**
    1.  `this.logger.warn("(SlowCycle) Остановка...");`
    2.  `if (this.cronJob) { this.cronJob.stop(); this.cronJob = null; }`

### 4.3. Приватный Метод `private async runTick(): Promise<void>`

Это "сердце" сервиса.

- **Логика:**
  1.  **Проверка Состояния:**
      - `if (this.globalState.isPaused() || this.globalState.isShuttingDown()) { ... return; }`

  2.  **Блок `try/catch`:**
      - **`try {`**
        - `this.logger.info("(SlowCycle) Тик ЗАПУЩЕН.");`
        - **Шаг 1. Обновление Кэша:** Обернуть в отдельный `try/catch`, логировать `debug` до и после, при ошибке логировать `error` и продолжить.
        - **Шаг 2. Плановая Сверка:** Обернуть в отдельный `try/catch`, логировать `debug` до и после, при ошибке логировать `error` и продолжить.
        - **Шаг 3. Проверка Триггеров:** Обернуть в отдельный `try/catch`, логировать `debug` до и после, при ошибке логировать `error` и продолжить.
        - **Шаг 4. Аварийный SL (5.2.1):** Обернуть в отдельный `try/catch`, логировать `debug` до и после, при ошибке логировать `error` и продолжить.
        - `this.logger.info("(SlowCycle) Тик ЗАВЕРШЕН.");`

      - **`} catch (error) {`**
        - `this.logger.error(`(SlowCycle) КРИТИЧЕСКИЙ СБОЙ "Медленного Цикла": ${String(error)}`, error);`
        - `this.logger.info("(SlowCycle) Тик ЗАВЕРШЕН (с ошибками).");`
        - `// (Не бросаем ошибку, чтобы cron задача продолжила работу)`

      - **`}`**

### 4.4. Приватный Метод `private async checkOverdueTriggersOnStartup(): Promise<void>`

- **Цель:** Проверка просроченных триггеров при старте приложения (обрабатывает триггеры, которые уже просрочены, если приложение было остановлено).
- **Логика:**
  1.  Получить `const allTriggersResult = await this.databaseService.query('SELECT * FROM llm_triggers');`
  2.  Залогировать `info` о количестве найденных триггеров.
  3.  Для каждого триггера:
      - Парсить `trigger_conditions_json` с поддержкой различных форматов (строка, массив, объект).
      - Проверять только `timeout` триггеры на просроченность:
        - Если `condition.condition === 'minutes_passed'`: сравнивать `minutesPassed` (разница между `Date.now()` и `row.updated_at`) с `condition.value`.
        - Иначе (legacy формат): сравнивать `Date.now()` с `condition.value` (timestamp).
      - Если триггер просрочен, залогировать `info` и вызвать `this.orchestrator.executeOrchestration(pair, reason)` без `await`.
      - Прервать внутренний цикл по условиям для этой пары после обработки просроченного триггера.
  4.  Залогировать `info` о количестве обработанных просроченных триггеров.
  5.  Обернуть всю логику в `try/catch` для предотвращения блокировки запуска приложения.

### 4.5. Приватный Метод `private async _checkTriggers(): Promise<void>`

- **Нюанс реализации:** Этот метод должен быть отказоустойчивым; сбой проверки одного триггера не должен останавливать цикл.
- **Логика:**
  1.  Обернуть всю логику в `try/catch`.
  2.  Добавить retry логику для защиты от race condition (до 3 попыток с задержкой).
  3.  Получить `const allTriggersResult = await this.databaseService.query('SELECT * FROM llm_triggers');`
  4.  Проверить консистентность данных (валидация `pair` и `trigger_conditions_json`).
  5.  Залогировать `info` о количестве найденных триггеров.
  6.  `for (const row of allTriggers.rows)`
  7.  `try {`
      - `const pair = row.pair;`
      - Парсить `trigger_conditions_json` с поддержкой различных форматов (строка, массив, объект), обрабатывать ошибки парсинга.
      - Залогировать `debug` о количестве условий для пары.
      - `for (const condition of conditions)`
      - **Проверить `timeout` триггеры:**
        - Если `condition.condition === 'minutes_passed'`: сравнивать `minutesPassed` (разница между `Date.now()` и `row.updated_at`) с `condition.value`.
        - Иначе (legacy формат): сравнивать `Date.now()` с `condition.value` (timestamp).
        - Залогировать `debug` о проверке.
      - **Проверить `indicator` триггеры:**
        - `if (condition.type === 'indicator' && condition.name && condition.timeframe)`
        - Получить `const ohlcv = await this.marketDataService.fetchOHLCV(pair, condition.timeframe, undefined, 50);`
        - Если `ohlcv.length === 0`, залогировать `warn` и продолжить (`continue`).
        - Получить `const analysis = this.taEngineService.getAnalysis(ohlcv, []);`
        - Использовать приватный метод `_getAnalysisValue(analysis, timeframe, indicatorName)` для извлечения значения индикатора.
        - Для RSI: если `condition.condition === 'below'` и `rsiValue < condition.value`, триггер сработал.
        - Для RSI: если `condition.condition === 'above'` и `rsiValue > condition.value`, триггер сработал.
        - Залогировать `debug` и `info` о проверке индикатора.

      - **Если триггер сработал (hit):**
        - `this.logger.info(`(SlowCycle) [${pair}] Триггер сработал! Обновляю время последнего срабатывания и запускаю оркестрацию...`);`
        - Обновить `updated_at` для триггера через `UPDATE llm_triggers SET updated_at = NOW() WHERE pair = $1` (обернуть в `try/catch`).
        - `this.orchestrator.executeOrchestration(pair, reason)` (Вызвать _без_ `await` - Задача 9.3).
        - **(Важно)** _Прервать_ внутренний цикл `for` по условиям для этой _пары_ (`break`).

  8.  `} catch (error) { this.logger.error(`(SlowCycle) [${row.pair}] Ошибка проверки триггера:`, error); }`

### 4.6. Приватный Метод `private _getAnalysisValue(analysis, timeframe, indicatorName): number | null`

- **Цель:** Вспомогательный метод для получения значения индикатора из анализа.
- **Логика:**
  - Проверять `analysis.rsi` для индикатора `'rsi'`.
  - Если значение является `DecimalValue`, вызвать `toNumber()`.
  - Если значение является `number`, вернуть его.
  - Иначе вернуть `null`.

### 4.7. Приватный Метод `private async _runStopLossJanitor(): Promise<void>` (Задача 5.2.1)

Это аварийный предохранитель.

- **Логика:**
  1.  Проверить `if (this.globalState.getIsPaused()) return;`
  2.  Обернуть всю логику в `try/catch`.
  3.  `const accountState = this.accountStateService.getAccountState();`
  4.  `if (!accountState.open_positions || accountState.open_positions.length === 0) { this.logger.debug('(StopLossJanitor) Нет открытых позиций, проверка не требуется.'); return; }`
  5.  Залогировать `debug` о количестве открытых позиций.
  6.  Получить `watchlist = this.configService.getWatchlist()`.
  7.  Создать массив промисов для получения тикеров: `watchlist.map((pair) => this.exchangeService.fetchTicker(pair))`.
  8.  Использовать `Promise.allSettled` для параллельного получения тикеров.
  9.  Создать `Map<string, IDecimalTicker>` для быстрого поиска тикеров по паре.
  10. Обработать результаты `Promise.allSettled`: для `fulfilled` добавить в Map, для `rejected` залогировать `warn`.
  11. Залогировать `debug` о количестве успешно полученных тикеров.
  12. `for (const position of accountState.open_positions)`
  13. `try {`
      - Получить `const ticker = tickerMap.get(position.pair);`
      - Если тикер отсутствует, залогировать `warn` и продолжить (`continue`).
      - `const currentPrice = new DecimalConstructor(ticker.last.toString());`
      - Если `position.stop_loss_price === null`, продолжить (`continue`).
      - `const slPrice = new DecimalConstructor(position.stop_loss_price.toString());`
      - Определить `const isBreached = (position.side === 'long' && currentPrice.lessThan(slPrice)) || (position.side === 'short' && currentPrice.greaterThan(slPrice))`
      - **Если `isBreached`:**
        - `this.logger.fatal(`(StopLossJanitor) [${position.pair}] ФАТАЛЬНАЯ ОШИБКА: Цена ${currentPrice} ПРОБИЛА SL ${slPrice}, но позиция НЕ ЗАКРЫТА! Запуск принудительного закрытия.`);`
        - **(Задача 9.2)** `this.pairActorManager.execute(position.pair, async () => { ... }).catch((e) => { ... })` (Вызвать _без_ `await`):
          - Внутри актора:
            - `await this.notificationService.sendAlert("... (StopLossJanitor FATAL) ...", true);`
            - `await this.workerService.execute({ action: 'CLOSE_POSITION', pair: position.pair, parameters: { type: 'market', amount_percent: 100 } }, null);` (null, т.к. лога LLM нет)
          - В `.catch()`: залогировать `error` об ошибке актора.

  14. `} catch (error) { this.logger.error(`(StopLossJanitor) [${position.pair}] Ошибка проверки SL:`, error); }`

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Service

    `SlowCycleService.ts` создан и корректно принимает все 13 зависимостей.

2.  **\[API\]** `start()` корректно конвертирует интервал в cron выражение через `_msToCronExpression()`, валидирует его, создает cron задачу через `cron.schedule()`, вызывает `checkOverdueTriggersOnStartup()` и `runTick()` один раз при старте.
3.  **\[API\]** `stop()` корректно вызывает `this.cronJob.stop()` и устанавливает `this.cronJob = null`.
4.  **\[Core\]** `runTick()` _корректно_ проверяет `GlobalStateService` (`isPaused`, `isShuttingDown`) в _самом начале_.
5.  **\[Core\]** _Вся_ основная логика `runTick()` (Шаги 1-4) обернута в `try/catch`. Каждый шаг также обернут в отдельный `try/catch` для максимальной отказоустойчивости.
6.  **\[Core (Шаг 1)\]** `runTick()` _корректно_ вызывает `await this.accountStateService.refreshNow()`.
7.  **\[Core (Шаг 2)\]** `runTick()` _корректно_ вызывает `await this.syncEngine.reconcileStateAll()`.
8.  **\[Core (Шаг 3)\]** Реализован приватный метод `_checkTriggers()`.
9.  **\[Triggers\]** `_checkTriggers()` _корректно_ читает `LLM_Triggers` из `DatabaseService`.
10. **\[Triggers\]** `_checkTriggers()` _корректно_ реализует логику проверки `timeout` (с поддержкой `minutes_passed` и legacy формата) и `indicator` (используя `TAEngineService` и `_getAnalysisValue`). Поддерживает retry логику и различные форматы `trigger_conditions_json`.

11. **\[Triggers\]** `_checkTriggers()` _корректно_ вызывает `this.orchestrator.executeOrchestration()` _без_ `await`.

12. **\[Janitor (Задача 5.2.1)\]** Реализован приватный метод `_runStopLossJanitor()`.

13. **\[Janitor (Logic)\]** `_runStopLossJanitor()` _корректно_ получает `accountState` и `tickers` (из `IExchangeService`).

14. **\[Janitor (Logic)\]** `_runStopLossJanitor()` _корректно_ использует `decimal.js` для сравнения `currentPrice` и `slPrice`.

15. **\[Janitor (Concurrency)\]** `_runStopLossJanitor()` _корректно_ вызывает `this.pairActorManager.execute()` _без_ `await` в случае `isBreached`.

16. **\[Janitor (Action)\]** Внутри "актора", `_runStopLossJanitor()` _корректно_ вызывает `notificationService.sendAlert` и `workerService.execute` (с `CLOSE_POSITION (Market)` и `llmLogId = null`).

17. **\[Startup\]** Реализован метод `checkOverdueTriggersOnStartup()` для проверки просроченных триггеров при старте приложения.

18. **\[Helper\]** Реализован метод `_getAnalysisValue(analysis, timeframe, indicatorName)` для извлечения значений индикаторов из анализа.

19. **\[Cron\]** Используется библиотека `node-cron` вместо `setInterval` для надежного планирования задач.

20. **\[Janitor (Tickers)\]** `_runStopLossJanitor()` использует `Promise.allSettled` для параллельного получения тикеров и создает Map для быстрого поиска.
