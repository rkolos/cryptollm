import { ConfigService } from './services/ConfigService.js';
import { LoggingService } from './services/LoggingService.js';
import { DatabaseService } from './services/DatabaseService.js';
import { GlobalStateService } from './services/GlobalStateService.js';
import { EventBusService } from './services/EventBusService.js';
import { PairActorManagerService } from './services/PairActorManagerService.js';
import { ProductionExchangeService } from './services/ProductionExchangeService.js';
import { MockExchangeService } from './services/MockExchangeService.js';
import { ProductionLLMService } from './services/ProductionLLMService.js';
import { MockLLMService } from './services/MockLLMService.js';
import { GuaranteedOrderExecutionService } from './services/GuaranteedOrderExecutionService.js';
import { ExchangeRulesService } from './services/ExchangeRulesService.js';
import { AccountStateService } from './services/AccountStateService.js';
import { NotificationService } from './services/NotificationService.js';
import { TAEngineService } from './services/TAEngineService.js';
import { MarketDataService } from './services/MarketDataService.js';
import { WatchlistOverviewService } from './services/WatchlistOverviewService.js';
import { MacroContextService } from './services/MacroContextService.js';
import { LLMRequestAssemblerService } from './services/LLMRequestAssemblerService.js';
import { ValidatorService } from './services/ValidatorService.js';
import { WorkerService } from './services/WorkerService.js';
import { SyncEngineService } from './services/SyncEngineService.js';
import { WatcherOrchestratorService } from './services/WatcherOrchestratorService.js';
import { TSLHandlerService } from './services/TSLHandlerService.js';
import { PriceTriggerHandler } from './services/PriceTriggerHandler.js';
import { SlowCycleService } from './services/SlowCycleService.js';
import { FastCycleService } from './services/FastCycleService.js';
import type { IExchangeService } from './interfaces/IExchangeService.js';
import type { ILLMService } from './interfaces/ILLMService.js';
import { runner } from 'node-pg-migrate';

// Глобальные ссылки на сервисы для graceful shutdown
let globalSlowCycle: SlowCycleService | null = null;
let globalFastCycle: FastCycleService | null = null;
let globalNotificationService: NotificationService | null = null;

/**
 * Главная точка входа приложения
 */
async function main(): Promise<void> {
  let notificationService: NotificationService | null = null;

  try {
    // 1. ConfigService.load()
    ConfigService.load();

    // 2. LoggingService.initialize()
    LoggingService.initialize();
    const logger = LoggingService.getInstance().getLogger('Application');
    logger.info('Bot is starting...');

    // 3. DatabaseService.initialize()
    await DatabaseService.initialize();
    logger.info('Database connected.');

    // 4. Выполнение миграций БД
    logger.info('Running DB migrations...');
    const config = ConfigService.getInstance();
    const dbConfig = config.getDbConfig();
    const databaseUrl = `postgresql://${dbConfig.user}:${dbConfig.password}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`;

    try {
      await runner({
        databaseUrl,
        dir: 'migrations',
        direction: 'up',
        migrationsTable: 'pgmigrations',
        count: Infinity,
      });
      logger.info('DB migrations completed successfully.');
    } catch (migrationError) {
      logger.error('DB migration failed:', migrationError);
      throw migrationError;
    }

    // 5. Инициализация "Базовых" Синглтонов
    const eventBus = EventBusService.getInstance();
    const globalState = GlobalStateService.getInstance();
    const pairActorManager = PairActorManagerService.getInstance();

    // 6. Логика "Фабрики" (APP_MODE)
    const appMode = config.getAppMode();
    let exchangeService: IExchangeService;
    let llmService: ILLMService;

    // 7. Инициализация "Ядерных" Сервисов (частично для MockExchangeService)
    const databaseService = DatabaseService.getInstance();

    // Сначала создаем временный ExchangeService для загрузки правил (если нужен Mock)
    if (appMode === 'production' || appMode === 'testnet') {
      exchangeService = new ProductionExchangeService();
      llmService = new ProductionLLMService();
      logger.info(`Using Production services (mode: ${appMode})`);
    } else {
      // Для Mock нужно сначала загрузить правила через ProductionExchangeService
      const tempExchangeForRules = new ProductionExchangeService();
      logger.info('Loading exchange rules for Mock mode...');
      await ExchangeRulesService.initialize(tempExchangeForRules, config);
      const exchangeRulesService = ExchangeRulesService.getInstance();

      exchangeService = new MockExchangeService(config, exchangeRulesService);
      llmService = new MockLLMService();
      logger.info(`Using Mock services (mode: ${appMode})`);
    }

    // GuaranteedOrderExecutionService
    const guaranteedOrderService = GuaranteedOrderExecutionService.getInstance();
    guaranteedOrderService.initialize(exchangeService);

    // ExchangeRulesService (для Production/Testnet режима)
    let exchangeRulesService: ExchangeRulesService;
    if (appMode === 'production' || appMode === 'testnet') {
      logger.info('Loading exchange rules...');
      await ExchangeRulesService.initialize(exchangeService, config);
      exchangeRulesService = ExchangeRulesService.getInstance();
    } else {
      // Для Mock режима правила уже загружены
      exchangeRulesService = ExchangeRulesService.getInstance();
    }

    // AccountStateService
    const accountStateService = AccountStateService.getInstance(config, exchangeService, databaseService, eventBus);

    // NotificationService
    notificationService = NotificationService.getInstance(config);
    notificationService.injectAccountStateService(accountStateService);
    notificationService.injectDatabaseService(databaseService);
    notificationService.injectExchangeService(exchangeService);
    notificationService.injectExchangeRulesService(exchangeRulesService);
    // Сохраняем ссылку в глобальной области для handleShutdown
    globalNotificationService = notificationService;

    // 8. Инициализация "Функциональных" Сервисов
    const taEngineService = TAEngineService.getInstance();
    const marketDataService = MarketDataService.getInstance(exchangeService);
    const watchlistOverviewService = WatchlistOverviewService.getInstance(
      config,
      exchangeService,
      marketDataService,
      taEngineService,
    );
    const macroContextService = MacroContextService.getInstance();
    await macroContextService.initialize(); // Первая загрузка данных

    const llmRequestAssemblerService = LLMRequestAssemblerService.getInstance(
      config,
      databaseService,
      marketDataService,
      taEngineService,
      watchlistOverviewService,
      accountStateService,
      macroContextService,
    );

    // Инициализация LLMRequestAssemblerService (загрузка промптов)
    logger.info('Loading LLM prompts...');
    await llmRequestAssemblerService.initialize();
    logger.info('LLM prompts loaded successfully.');

    // ValidatorService для WorkerService
    const validatorService = ValidatorService.getInstance(exchangeRulesService);

    // WorkerService (задача 7.1)
    const workerService = WorkerService.getInstance(
      validatorService,
      guaranteedOrderService,
      databaseService,
      eventBus,
      notificationService,
      globalState,
      accountStateService,
      exchangeRulesService,
      config,
    );

    const syncEngine = SyncEngineService.getInstance(
      config,
      databaseService,
      exchangeService,
      pairActorManager,
      exchangeRulesService,
      guaranteedOrderService,
    );

    const watcherOrchestrator = WatcherOrchestratorService.getInstance(
      databaseService,
      llmService,
      llmRequestAssemblerService,
      syncEngine,
      workerService,
      pairActorManager,
      notificationService,
      accountStateService,
      config,
      marketDataService,
    );

    const tslHandler = TSLHandlerService.getInstance(
      accountStateService,
      pairActorManager,
      guaranteedOrderService,
      databaseService,
    );

    const priceTriggerHandler = PriceTriggerHandler.getInstance(
      accountStateService,
      pairActorManager,
      watcherOrchestrator,
    );

    // 9. "Холодный" Старт (Сверка)
    logger.info("Services initialized. Starting 'cold sync' (reconciliation)...");
    await syncEngine.reconcileStateAll();
    logger.info('Reconciliation complete. Bot is warming up...');
    await accountStateService.refreshNow(); // Чтобы кэш был 100% актуален перед стартом

    // 10. Запуск Циклов
    globalSlowCycle = SlowCycleService.getInstance(
      config,
      globalState,
      accountStateService,
      syncEngine,
      databaseService,
      marketDataService,
      taEngineService,
      watcherOrchestrator,
      exchangeService,
      pairActorManager,
      workerService,
      notificationService,
    );

    globalFastCycle = FastCycleService.getInstance(
      config,
      globalState,
      exchangeService,
      tslHandler,
      priceTriggerHandler,
    );

    globalSlowCycle.start();
    globalFastCycle.start();

    logger.info('Bot is fully operational. Fast and Slow cycles are running.');
    notificationService.sendAlert('Bot successfully started.', true);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const logger = LoggingService.getInstance().getLogger('Application');
    logger.error(`FATAL ERROR during startup: ${errorMessage}`, error);

    if (notificationService) {
      try {
        notificationService.sendAlert(`FATAL ERROR during startup: ${errorMessage}`, false);
      } catch (notifyError) {
        // Игнорируем ошибки уведомлений при фатальной ошибке
        console.error('Failed to send notification:', notifyError);
      }
    }

    process.exit(1);
  }
}

/**
 * Обработчик корректного завершения (Graceful Shutdown)
 */
async function handleShutdown(): Promise<void> {
  const logger = LoggingService.getInstance().getLogger('Application');

  try {
    logger.warn('SIGINT/SIGTERM received. Starting graceful shutdown...');

    // 1. Установка флага завершения
    const globalState = GlobalStateService.getInstance();
    globalState.startShutdown();

    // 2. Остановка циклов (используем сохраненные ссылки)
    if (globalSlowCycle) {
      try {
        globalSlowCycle.stop();
        logger.info('SlowCycle stopped.');
      } catch (error) {
        logger.warn('Error stopping SlowCycle:', error);
      }
    }

    if (globalFastCycle) {
      try {
        await globalFastCycle.stop();
        logger.info('FastCycle stopped.');
      } catch (error) {
        logger.warn('Error stopping FastCycle:', error);
      }
    }

    // 3. Ожидание завершения всех задач
    logger.info('Cycles stopped. Waiting for all pending tasks to complete (max 20s)...');
    try {
      const pairActorManager = PairActorManagerService.getInstance();
      await pairActorManager.waitForAllQueuesToSettle(20000);
      logger.info('All tasks settled.');
    } catch (error) {
      logger.warn('Error waiting for queues to settle:', error);
    }

    // 4. Отправка уведомления о завершении
    if (globalNotificationService) {
      try {
        globalNotificationService.sendAlert('Bot shutting down gracefully.', false);
        // Даем время на отправку (async очередь)
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error) {
        logger.warn('Error sending shutdown notification:', error);
      }
    }

    // 5. Закрытие пула БД
    try {
      const databaseService = DatabaseService.getInstance();
      await databaseService.closePool();
      logger.info('Database pool closed.');
    } catch (error) {
      logger.warn('Error closing database pool:', error);
    }

    logger.info('Graceful shutdown completed.');
    process.exit(0);
  } catch (error) {
    logger.error('Error during graceful shutdown:', error);
    process.exit(1);
  }
}

// Привязка обработчиков сигналов
process.on('SIGINT', () => {
  handleShutdown().catch((error) => {
    console.error('Fatal error in shutdown handler:', error);
    process.exit(1);
  });
});

process.on('SIGTERM', () => {
  handleShutdown().catch((error) => {
    console.error('Fatal error in shutdown handler:', error);
    process.exit(1);
  });
});

// Запуск приложения
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
