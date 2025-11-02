import { config } from 'dotenv';
import { ConfigService } from '../src/services/ConfigService.js';
import { LoggingService } from '../src/services/LoggingService.js';
import { DatabaseService } from '../src/services/DatabaseService.js';
import { GlobalStateService } from '../src/services/GlobalStateService.js';
import { EventBusService } from '../src/services/EventBusService.js';
import { PairActorManagerService } from '../src/services/PairActorManagerService.js';
import { ProductionExchangeService } from '../src/services/ProductionExchangeService.js';
import { ProductionLLMService } from '../src/services/ProductionLLMService.js';
import { ExchangeRulesService } from '../src/services/ExchangeRulesService.js';
import { AccountStateService } from '../src/services/AccountStateService.js';
import { NotificationService } from '../src/services/NotificationService.js';
import { TAEngineService } from '../src/services/TAEngineService.js';
import { MarketDataService } from '../src/services/MarketDataService.js';
import { WatchlistOverviewService } from '../src/services/WatchlistOverviewService.js';
import { MacroContextService } from '../src/services/MacroContextService.js';
import { LLMRequestAssemblerService } from '../src/services/LLMRequestAssemblerService.js';
import { ValidatorService } from '../src/services/ValidatorService.js';
import { WorkerService } from '../src/services/WorkerService.js';
import { SyncEngineService } from '../src/services/SyncEngineService.js';
import { WatcherOrchestratorService } from '../src/services/WatcherOrchestratorService.js';
import { GuaranteedOrderExecutionService } from '../src/services/GuaranteedOrderExecutionService.js';

config();

/**
 * Скрипт для восстановления обработки триггеров, которые были прерваны
 * Использование:
 *   npm run recover-triggers                    # Восстановить все пары с триггерами
 *   npm run recover-triggers XRP/USDT ETH/USDT # Восстановить конкретные пары
 */
async function recoverTriggers() {
  const pairsToRecover = process.argv.slice(2);

  try {
    // Инициализация сервисов
    ConfigService.load();
    LoggingService.initialize();
    const logger = LoggingService.getInstance().getLogger('RecoverTriggers');
    logger.info('Инициализация сервисов для восстановления триггеров...');

    await DatabaseService.initialize();
    const databaseService = DatabaseService.getInstance();
    const configService = ConfigService.getInstance();

    // Инициализация базовых сервисов
    const eventBus = EventBusService.getInstance();
    const globalState = GlobalStateService.getInstance();
    const pairActorManager = PairActorManagerService.getInstance();

    // Инициализация Exchange и LLM сервисов
    const exchangeService = new ProductionExchangeService();
    const llmService = new ProductionLLMService();
    
    // Определяем пары для восстановления (если не указаны, используем все из БД)
    let targetPairs: string[] = [];
    if (pairsToRecover.length > 0) {
      targetPairs = pairsToRecover;
    } else {
      const triggersResult = await databaseService.query('SELECT pair FROM LLM_Triggers ORDER BY pair');
      targetPairs = triggersResult.rows.map((row: { pair: string }) => row.pair);
    }
    
    // Загружаем правила только для нужных пар
    logger.info('Загрузка правил биржи для восстанавливаемых пар...');
    ExchangeRulesService.instance = ExchangeRulesService.instance || new ExchangeRulesService();
    
    for (const pair of targetPairs) {
      const rules = await ExchangeRulesService.loadRulesForPair(pair, exchangeService);
      if (rules) {
        ExchangeRulesService.instance.rulesCache.set(pair, rules);
        logger.debug(`Правила загружены для ${pair}: minNotional=${rules.minNotional}, takerFee=${rules.takerFee}`);
      } else {
        logger.warn(`Пара ${pair} не найдена на бирже или не удалось загрузить правила`);
      }
    }

    // Инициализация остальных сервисов
    const accountStateService = AccountStateService.getInstance(
      configService,
      exchangeService,
      databaseService,
      eventBus,
    );
    const notificationService = NotificationService.getInstance(configService);
    const taEngineService = TAEngineService.getInstance(databaseService);
    const marketDataService = MarketDataService.getInstance(exchangeService);
    const watchlistOverviewService = WatchlistOverviewService.getInstance(marketDataService);
    const macroContextService = MacroContextService.getInstance();
    const assemblerService = LLMRequestAssemblerService.getInstance(
      configService,
      databaseService,
      marketDataService,
      taEngineService,
      watchlistOverviewService,
      accountStateService,
      macroContextService,
    );
    
    // Инициализация LLMRequestAssemblerService (загрузка промптов)
    logger.info('Загрузка промптов LLM...');
    await assemblerService.initialize();
    logger.info('Промпты LLM загружены успешно.');
    const validatorService = ValidatorService.getInstance(configService, exchangeService);
    const guaranteedOrderService = GuaranteedOrderExecutionService.getInstance(exchangeService);
    const workerService = WorkerService.getInstance(
      databaseService,
      exchangeService,
      validatorService,
      guaranteedOrderService,
      accountStateService,
      notificationService,
      configService,
    );
    const syncEngine = SyncEngineService.getInstance(
      databaseService,
      exchangeService,
      pairActorManager,
      accountStateService,
    );
    const orchestrator = WatcherOrchestratorService.getInstance(
      databaseService,
      llmService,
      assemblerService,
      syncEngine,
      workerService,
      pairActorManager,
      notificationService,
      accountStateService,
      configService,
      marketDataService,
    );

    // Обновляем состояние счета
    logger.info('Обновление состояния счета...');
    await accountStateService.refreshNow();

    logger.info(`Восстановление обработки для пар: ${targetPairs.join(', ')}`);

    if (targetPairs.length === 0) {
      logger.warn('Не найдено пар для восстановления.');
      return;
    }

    // Проверяем наличие незавершенных обработок
    logger.info('Проверка незавершенных обработок...');
    const pendingLogsResult = await databaseService.query(
      `SELECT DISTINCT triggered_pair 
       FROM LLM_Decision_Log 
       WHERE decision_result = 'pending' 
         AND timestamp > NOW() - INTERVAL '1 hour'
       ORDER BY triggered_pair`,
    );
    const pairsWithPendingLogs = new Set(
      pendingLogsResult.rows.map((row: { triggered_pair: string }) => row.triggered_pair),
    );

    logger.info(
      `Найдено пар с незавершенными обработками: ${pairsWithPendingLogs.size} ${
        pairsWithPendingLogs.size > 0 ? `(${Array.from(pairsWithPendingLogs).join(', ')})` : '(нет)'
      }`,
    );

    // Запускаем восстановление для каждой пары
    logger.info(`\n🚀 Запуск восстановления обработки для ${targetPairs.length} пар...\n`);

    for (const pair of targetPairs) {
      try {
        const hasPendingLog = pairsWithPendingLogs.has(pair);
        const reason = hasPendingLog
          ? `Восстановление прерванной обработки (найдена запись со статусом 'pending')`
          : `Восстановление обработки после перезапуска приложения`;

        logger.info(`[${pair}] ${reason}...`);

        // Вызываем оркестрацию для восстановления обработки
        orchestrator.executeOrchestration(pair, reason);

        logger.info(`[${pair}] ✅ Задача восстановления добавлена в очередь`);
      } catch (error) {
        logger.error(`[${pair}] ❌ Ошибка при восстановлении:`, error);
      }
    }

    logger.info(`\n✅ Восстановление инициировано для ${targetPairs.length} пар.`);
    logger.info('Ожидание завершения обработки всех задач...\n');

    // Ждем завершения всех задач через PairActorManager
    // Таймаут 120 секунд (2 минуты) - достаточно для запросов к LLM
    await pairActorManager.waitForAllQueuesToSettle(120000);

    logger.info('\n✅ Все задачи восстановления завершены.');

    // Закрываем соединения
    await databaseService.closePool();
  } catch (error) {
    console.error('❌ Критическая ошибка при восстановлении:', error);
    process.exit(1);
  }
}

recoverTriggers().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

