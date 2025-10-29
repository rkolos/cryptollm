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
  2.  `LoggingService.init(ConfigService)` (Задача 1.4).
  3.  `Logger.info("Bot is starting...")`.
  4.  `DatabaseService.connect(ConfigService)` (Задача 2.3).
  5.  `Logger.info("Running DB migrations...")`.
  6.  `await DatabaseService.runMigrations()` (Задача 2.2).
  7.  **Инициализация "Базовых" Синглтонов:**
      - `const eventBus = EventBusService.getInstance()` (Задача 4.5.1).
      - `const globalState = GlobalStateService.getInstance()` (Задача 1.6).
      - `const pairActorManager = PairActorManagerService.getInstance(LoggingService)` (Задача 9.1).

  8.  **Логика "Фабрики" (`APP_MODE`):**
      - `const appMode = ConfigService.get('APP_MODE');`
      - `const exchangeService: IExchangeService = (appMode === 'production' || appMode === 'testnet') ? new ProductionExchangeService(...) : new MockExchangeService(...);`
      - `const llmService: ILLMService = (appMode === 'production' || appMode === 'testnet') ? new ProductionLLMService(...) : new MockLLMService(...);`

  9.  **Инициализация (DI) "Ядерных" Сервисов:**
      - `GuaranteedOrderExecutionService.init(exchangeService, dbService, ...)` (Задача 7.0).
      - `ExchangeRulesService.init(exchangeService)` (Задача 3.2).
      - `Logger.info("Loading exchange rules...")`.
      - `await ExchangeRulesService.loadRules()`.
      - `AccountStateService.init(dbService, exchangeService, eventBus, ...)` (Задача 4.5).
      - `NotificationService.init(configService, accountStateService)` (Задача 1.5).

  10. **Инициализация (DI) "Функциональных" Сервисов:**


      -   `TAEngineService.init(...)` (Задача 4.1).

      -   `MarketDataService.init(exchangeService, ...)` (Задача 4.2).

      -   ... (Инициализировать _все_ оставшиеся сервисы: `WatchlistOverview`, `MacroContext`, `LLMRequestAssembler`, `Validator`, `WorkerService`, `SyncEngine`, `WatcherOrchestrator`, `TSLHandler`, `PriceTriggerHandler`, передавая им друг друга в конструкторы).


  11. **"Холодный" Старт (Сверка):**


      -   `Logger.info("Services initialized. Starting 'cold sync' (reconciliation)...")`.

      -   `await SyncEngine.reconcileStateAll()`.

      -   `Logger.info("Reconciliation complete. Bot is warming up...")`.

      -   `await AccountStateService.refreshNow()` (Чтобы кэш был 100% актуален перед стартом).


  12. **Запуск Циклов:**


      -   `SlowCycleService.start(...)` (Задача 5.2).

      -   `FastCycleService.start(...)` (Задача 5.3).

      -   `Logger.info("Bot is fully operational. Fast and Slow cycles are running.")`.

      -   `await NotificationService.sendAlert("Bot successfully started.", true)`.


### 4.2. `async function handleShutdown()` (Задача 8.1.1)

- **Нюанс реализации:** Эта функция _не должна_ бросать исключений. Она должна быть "best-effort".
- **Логика:**
  1.  `Logger.warn("SIGINT/SIGTERM received. Starting graceful shutdown...")`.
  2.  `GlobalStateService.startShutdown()` (Задача 1.6) (Это немедленно остановит `SlowCycle`, `FastCycle`, `TSLHandler` и `PriceTriggerHandler` от _начала_ новых операций).
  3.  `SlowCycleService.stop()` (Задача 5.2) (Остановить `setInterval`).
  4.  `FastCycleService.stop()` (Задача 5.3) (Закрыть WebSocket).
  5.  `Logger.info("Cycles stopped. Waiting for all pending tasks to complete (max 20s)...")`.
  6.  `await PairActorManagerService.waitForAllQueuesToSettle(20000)` (Задача 9.1) (Дождаться завершения _уже начатых_ операций).
  7.  `Logger.info("All tasks settled.")`.
  8.  `await NotificationService.sendAlert("Bot shutting down gracefully.")`.
  9.  `await DatabaseService.closePool()` (Задача 2.3).
  10. `process.exit(0)`.

### 4.3. Привязка Обработчиков

- **Нюанс реализации:** В _глобальной_ области (вне `main`) разработчик должен привязать обработчики:
  - `process.on('SIGINT', handleShutdown);`
  - `process.on('SIGTERM', handleShutdown);`

## 5\. Критерии Приемки (Acceptance Criteria)

1.  File

    `src/index.ts` создан и содержит `async function main()`.

2.  **\[Config\]** `main()` _корректно_ загружает `ConfigService` _первым_.
3.  **\[DB\]** `main()` _корректно_ инициализирует `DatabaseService` и _успешно_ вызывает `await runMigrations()`.
4.  **\[DI\]** `main()` _корректно_ создает `EventBus`, `GlobalStateService` и `PairActorManagerService`.
5.  **\[Mode\]** `main()` _корректно_ создает `ProductionExchangeService` ИЛИ `MockExchangeService` (аналогично для `ILLMService`) на основе `APP_MODE`.
6.  **\[Rules\]** `main()` _корректно_ вызывает `await ExchangeRulesService.loadRules()` _после_ создания `ExchangeService`.
7.  **\[DI\]** `main()` _корректно_ инициализирует (DI) _все_ остальные сервисы (`AccountState`, `Worker`, `SyncEngine` и т.д.), передавая им нужные зависимости.
8.  **\[Boot\]** `main()` _корректно_ вызывает `await SyncEngine.reconcileStateAll()` _после_ инициализации всех сервисов, но _до_ запуска циклов.
9.  **\[Boot\]** `main()` _корректно_ вызывает `await AccountStateService.refreshNow()` _сразу после_ `reconcileStateAll`.
10. **\[Run\]** `main()` _корректно_ вызывает `SlowCycleService.start()` и `FastCycleService.start()`.

11. **\[Notify\]** `main()` отправляет PUSH-уведомление (`NotificationService`) об _успешном_ старте.

12. **\[Error\]** `main()` имеет `try/catch` верхнего уровня для обработки фатальных ошибок при старте.

13. **\[Shutdown (8.1.1)\]** В `index.ts` реализована `async function handleShutdown()`.

14. **\[Shutdown (8.1.1)\]** Обработчики `SIGINT` и `SIGTERM` _корректно_ привязаны к `handleShutdown` в глобальной области.

15. **\[Shutdown (8.1.1)\]** `handleShutdown()` _корректно_ вызывает `GlobalStateService.startShutdown()` и `stop()` для _обоих_ циклов.

16. **\[Shutdown (8.1.1)\]** `handleShutdown()` _корректно_ вызывает `await PairActorManagerService.waitForAllQueuesToSettle()`.

17. **\[Shutdown (8.1.1)\]** `handleShutdown()` _корректно_ вызывает `await DatabaseService.closePool()` _в самом конце_ (после `waitForAllQueuesToSettle`).
