# Техническое Задание (ТЗ): 8.1 Главная Точка Входа (Main Application - index.ts)

**Включает:** 8.1.1 Реализация "Корректного Завершения" (Graceful Shutdown)

**Эпик:** 8. 🚀 Сборка, Тестирование и Запуск **Задача:** 8.1. Главная Точка Входа (Main Application - `index.ts`) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать `src/index.ts` — "клей" и главную точку входа для всего приложения. Этот файл отвечает за:

1.  Инициализацию (DI) _всех_ Singleton-сервисов в строго определенном порядке.
2.  Выбор "боевых" (`Production`) или "симуляторных" (`Mock`) реализаций клиентов (`IExchangeService`, `ILLMService`) на основе `APP_MODE`.
3.  Выполнение "холодной" (начальной) сверки состояния (`SyncEngine.reconcileStateAll`) _до_ запуска циклов.
4.  Запуск "Медленного" и "Быстрого" циклов.
5.  Реализацию "Корректного Завершения" (`Graceful Shutdown`) для безопасной остановки бота.

## 2\. Архитектурное Решение

1.  **DI-Контейнер (Корень):** `index.ts` будет выступать в роли "корневого" DI-контейнера. Он создаст _экземпляры_ (instances) всех Singleton-сервисов и "внедрит" их друг в друга (передаст в конструкторы).
2.  **Фабрика Режимов (`APP_MODE`):** В `index.ts` будет реализована логика "фабрики" (factory), которая на основе `ConfigService.get('APP_MODE')` примет решение, какие классы (`Production` или `Mock`) создавать для интерфейсов `IExchangeService` и `ILLMService`.
3.  **Строгий Порядок Загрузки (Boot Sequence):** Инициализация должна проходить в строгом порядке, чтобы гарантировать доступность зависимостей (например, `Config` должен быть первым, `DB` — до `AccountState`, `ExchangeRules` — до `Validator`).
4.  **"Холодная" Сверка:** `index.ts` _обязан_ один раз вызвать `await SyncEngine.reconcileStateAll()` _после_ инициализации всех сервисов, но _до_ запуска `SlowCycleService` и `FastCycleService`.
5.  **Graceful Shutdown (Задача 8.1.1):** `index.ts` _обязан_ привязать обработчики к `process.on('SIGINT')` и `process.on('SIGTERM')`. Этот обработчик _должен_ вызвать `GlobalStateService.startShutdown()`, остановить циклы, дождаться завершения `PairActorManagerService` и _только потом_ закрыть пул БД.

## 3\. Зависимости Задачи

Эта задача является "корнем" и будет использовать (импортировать и инициализировать) **практически все сервисы**, созданные в предыдущих задачах (Эпики 1-7, 9, 10).

## 4\. Описание и Нюансы Реализации

Разработчик должен создать `src/index.ts`. Этот файл будет содержать две основные функции: `async function main()` и `async function handleShutdown()`.

### 4.1. `async function main()` (Точка Входа)

- **Нюанс реализации:** Вся функция `main()` должна быть обернута в `try/catch (e: any)` верхнего уровня. В случае _фатальной_ ошибки при старте (e.g., не удалось подключиться к БД, не удалось загрузить `Config`), `main()` должен вызвать `Logger.fatal(...)`, `NotificationService.sendAlert(...)` (если он успел инициализироваться) и `process.exit(1)`.
- **Логика (Порядок Загрузки):**
  1.  `ConfigService.load()` (Задача 1.3).
  2.  `LoggingService.initialize()` (Задача 1.4) (без параметров).
  3.  `const logger = LoggingService.getInstance().getLogger('Application')` и `logger.info("Bot is starting...")`.
  4.  `await DatabaseService.initialize()` (Задача 2.3) (без параметров).
  5.  `logger.info("Running DB migrations...")`.
  6.  Выполнение миграций через `runner` из `node-pg-migrate` с параметрами `databaseUrl`, `dir: 'migrations'`, `direction: 'up'`, `migrationsTable: 'pgmigrations'`, `count: Infinity`.
  7.  **Инициализация "Базовых" Синглтонов:**
      - `const eventBus = EventBusService.getInstance()` (Задача 4.5.1).
      - `const globalState = GlobalStateService.getInstance()` (Задача 1.6).
      - `const pairActorManager = PairActorManagerService.getInstance()` (Задача 9.1) (без параметров).

  8.  **Логика "Фабрики" (`APP_MODE`):**
      - `const appMode = config.getAppMode()` (из `ConfigService.getInstance()`).
      - Для `production` или `testnet`: `exchangeService = new ProductionExchangeService()`, `llmService = new ProductionLLMService()`.
      - Для `dry_run`: Сначала создается временный `ProductionExchangeService` для загрузки правил, затем `ExchangeRulesService.initialize(tempExchangeForRules, config)`, затем `exchangeService = new MockExchangeService(config, exchangeRulesService)`, `llmService = new MockLLMService()`.

  9.  **Инициализация (DI) "Ядерных" Сервисов:**
      - `const guaranteedOrderService = GuaranteedOrderExecutionService.getInstance()` и `guaranteedOrderService.initialize(exchangeService)` (Задача 7.0).
      - Для `production`/`testnet`: `await ExchangeRulesService.initialize(exchangeService, config)`, затем `const exchangeRulesService = ExchangeRulesService.getInstance()`.
      - Для `dry_run`: Правила уже загружены, используется `ExchangeRulesService.getInstance()`.
      - `const accountStateService = AccountStateService.getInstance(config, exchangeService, databaseService, eventBus)` (Задача 4.5).
      - `const notificationService = NotificationService.getInstance(config)`, затем `notificationService.injectAccountStateService(accountStateService)`, `notificationService.injectDatabaseService(databaseService)`, `notificationService.injectExchangeService(exchangeService)`, `notificationService.injectExchangeRulesService(exchangeRulesService)` (Задача 1.5).

  10. **Инициализация (DI) "Функциональных" Сервисов:**

      -   `const taEngineService = TAEngineService.getInstance()` (Задача 4.1).
      -   `const marketDataService = MarketDataService.getInstance(exchangeService)` (Задача 4.2).
      -   `const watchlistOverviewService = WatchlistOverviewService.getInstance(config, exchangeService, marketDataService, taEngineService)`.
      -   `const macroContextService = MacroContextService.getInstance()` и `await macroContextService.initialize()` (первая загрузка данных).
      -   `const llmRequestAssemblerService = LLMRequestAssemblerService.getInstance(config, databaseService, marketDataService, taEngineService, watchlistOverviewService, accountStateService, macroContextService)` и `await llmRequestAssemblerService.initialize()` (загрузка промптов).
      -   `const validatorService = ValidatorService.getInstance(exchangeRulesService)`.
      -   `const workerService = WorkerService.getInstance(validatorService, guaranteedOrderService, databaseService, eventBus, notificationService, globalState, accountStateService, exchangeRulesService, exchangeService, config)` (10 зависимостей).
      -   `const syncEngine = SyncEngineService.getInstance(config, databaseService, exchangeService, pairActorManager, exchangeRulesService, guaranteedOrderService)`.
      -   `const watcherOrchestrator = WatcherOrchestratorService.getInstance(databaseService, llmService, llmRequestAssemblerService, syncEngine, workerService, pairActorManager, notificationService, accountStateService, config, marketDataService)`.
      -   `const tslHandler = TSLHandlerService.getInstance(accountStateService, pairActorManager, guaranteedOrderService, databaseService)`.
      -   `const priceTriggerHandler = PriceTriggerHandler.getInstance(accountStateService, pairActorManager, watcherOrchestrator)`.


  11. **"Холодный" Старт (Сверка):**


      -   `Logger.info("Services initialized. Starting 'cold sync' (reconciliation)...")`.

      -   `await SyncEngine.reconcileStateAll()`.

      -   `Logger.info("Reconciliation complete. Bot is warming up...")`.

      -   `await AccountStateService.refreshNow()` (Чтобы кэш был 100% актуален перед стартом).


  12. **Запуск Циклов:**

      -   Сохранение ссылок на циклы в глобальные переменные (`globalSlowCycle`, `globalFastCycle`) для использования в `handleShutdown`.
      -   `globalSlowCycle = SlowCycleService.getInstance(config, globalState, accountStateService, syncEngine, databaseService, marketDataService, taEngineService, watcherOrchestrator, exchangeService, pairActorManager, workerService, notificationService)` и `globalSlowCycle.start()` (Задача 5.2).
      -   `globalFastCycle = FastCycleService.getInstance(config, globalState, accountStateService, exchangeService, tslHandler, priceTriggerHandler)` и `globalFastCycle.start()` (Задача 5.3).
      -   `logger.info("Bot is fully operational. Fast and Slow cycles are running.")`.
      -   `notificationService.sendAlert("Bot successfully started.", true)` (без `await`, так как это fire-and-forget).


### 4.2. `async function handleShutdown()` (Задача 8.1.1)

- **Нюанс реализации:** Эта функция _не должна_ бросать исключений. Она должна быть "best-effort".
- **Логика (обернута в try/catch для обработки ошибок):**
  1.  `logger.warn("SIGINT/SIGTERM received. Starting graceful shutdown...")`.
  2.  `const globalState = GlobalStateService.getInstance()` и `globalState.startShutdown()` (Задача 1.6) (Это немедленно остановит `SlowCycle`, `FastCycle`, `TSLHandler` и `PriceTriggerHandler` от _начала_ новых операций).
  3.  Остановка циклов через глобальные ссылки: `if (globalSlowCycle) { globalSlowCycle.stop() }` (Задача 5.2) и `if (globalFastCycle) { await globalFastCycle.stop() }` (Задача 5.3) (каждый в отдельном try/catch).
  4.  `logger.info("Cycles stopped. Waiting for all pending tasks to complete (max 20s)...")`.
  5.  `const pairActorManager = PairActorManagerService.getInstance()` и `await pairActorManager.waitForAllQueuesToSettle(20000)` (Задача 9.1) (Дождаться завершения _уже начатых_ операций) в try/catch.
  6.  `logger.info("All tasks settled.")`.
  7.  `if (globalNotificationService) { globalNotificationService.sendAlert("Bot shutting down gracefully.", false) }` и `await new Promise((resolve) => setTimeout(resolve, 2000))` (ожидание 2 секунды для async очереди уведомлений) в try/catch.
  8.  `const databaseService = DatabaseService.getInstance()` и `await databaseService.closePool()` (Задача 2.3) в try/catch.
  9.  `logger.info("Graceful shutdown completed.")` и `process.exit(0)`.
  10. При любой ошибке в `catch`: `logger.error("Error during graceful shutdown:", error)` и `process.exit(1)`.

### 4.3. Привязка Обработчиков

- **Нюанс реализации:** В _глобальной_ области (вне `main`) разработчик должен привязать обработчики:
  - `process.on('SIGINT', () => { handleShutdown().catch((error) => { logger.error('Fatal error in shutdown handler:', error); process.exit(1); }) });`
  - `process.on('SIGTERM', () => { handleShutdown().catch((error) => { logger.error('Fatal error in shutdown handler:', error); process.exit(1); }) });`
  - Также вызывается `main().catch((error) => { logger.error('Fatal error:', error); process.exit(1); })` в конце файла.

## 5\. Критерии Приемки (Acceptance Criteria)

1.  File

    `src/index.ts` создан и содержит `async function main()`.

2.  **\[Config\]** `main()` _корректно_ загружает `ConfigService.load()` _первым_.
3.  **\[DB\]** `main()` _корректно_ инициализирует `DatabaseService.initialize()` и _успешно_ выполняет миграции через `runner` из `node-pg-migrate`.
4.  **\[DI\]** `main()` _корректно_ создает `EventBusService.getInstance()`, `GlobalStateService.getInstance()` и `PairActorManagerService.getInstance()` (без параметров).
5.  **\[Mode\]** `main()` _корректно_ создает `ProductionExchangeService` ИЛИ `MockExchangeService` (аналогично для `ILLMService`) на основе `appMode = config.getAppMode()`. Для `dry_run` сначала загружает правила через временный `ProductionExchangeService`.
6.  **\[Rules\]** `main()` _корректно_ вызывает `await ExchangeRulesService.initialize(exchangeService, config)` _после_ создания `ExchangeService` (для production/testnet) или до создания Mock (для dry_run).
7.  **\[DI\]** `main()` _корректно_ инициализирует (DI) _все_ остальные сервисы через `getInstance()` с передачей зависимостей: `WorkerService` получает 10 зависимостей, `WatcherOrchestrator` получает 11 зависимостей, и т.д.
8.  **\[Boot\]** `main()` _корректно_ вызывает `await syncEngine.reconcileStateAll()` _после_ инициализации всех сервисов, но _до_ запуска циклов.
9.  **\[Boot\]** `main()` _корректно_ вызывает `await accountStateService.refreshNow()` _сразу после_ `reconcileStateAll`.
10. **\[Run\]** `main()` _корректно_ сохраняет ссылки на циклы в глобальные переменные и вызывает `globalSlowCycle.start()` и `globalFastCycle.start()`.

11. **\[Notify\]** `main()` отправляет PUSH-уведомление (`notificationService.sendAlert("Bot successfully started.", true)`) об _успешном_ старте (без `await`).

12. **\[Error\]** `main()` имеет `try/catch` верхнего уровня для обработки фатальных ошибок при старте, логирует через `logger.error()`, отправляет уведомление (если `notificationService` инициализирован) и вызывает `process.exit(1)`.

13. **\[Shutdown (8.1.1)\]** В `index.ts` реализована `async function handleShutdown()`.

14. **\[Shutdown (8.1.1)\]** Обработчики `SIGINT` и `SIGTERM` _корректно_ привязаны к `handleShutdown` в глобальной области.

15. **\[Shutdown (8.1.1)\]** `handleShutdown()` _корректно_ вызывает `GlobalStateService.getInstance().startShutdown()` и `stop()` для _обоих_ циклов через глобальные ссылки (`globalSlowCycle`, `globalFastCycle`) в отдельных try/catch блоках.

16. **\[Shutdown (8.1.1)\]** `handleShutdown()` _корректно_ вызывает `await PairActorManagerService.getInstance().waitForAllQueuesToSettle(20000)` в try/catch.

17. **\[Shutdown (8.1.1)\]** `handleShutdown()` _корректно_ вызывает `await NotificationService.sendAlert("Bot shutting down gracefully.", false)` и ожидает 2 секунды для async очереди уведомлений, затем `await DatabaseService.getInstance().closePool()` _в самом конце_ (после `waitForAllQueuesToSettle`) в try/catch.

18. **\[Shutdown (8.1.1)\]** `handleShutdown()` _обернута_ в `try/catch`, логирует ошибки и вызывает `process.exit(1)` при ошибке.

19. **\[Shutdown (8.1.1)\]** Обработчики `SIGINT` и `SIGTERM` _обернуты_ в `.catch()` для обработки ошибок в `handleShutdown()`.
