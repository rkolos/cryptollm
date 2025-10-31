import { config } from 'dotenv';
import { Pool } from 'pg';
import { ConfigService } from '../src/services/ConfigService.js';
import { LoggingService } from '../src/services/LoggingService.js';

config();

async function clearDatabase() {
  // Инициализируем ConfigService перед LoggingService
  ConfigService.load();

  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER || 'cryptollm',
    password: process.env.DB_PASSWORD || 'cryptollm',
    database: process.env.DB_NAME || 'cryptollm',
  });

  LoggingService.initialize();
  const logger = LoggingService.getInstance().getLogger('ClearDB');

  try {
    logger.info('Starting database cleanup...');

    // Очищаем все таблицы и сбрасываем счетчики SERIAL
    await pool.query(
      'TRUNCATE ActivePositions, ActiveOrders, TSL_State, TradeHistory, LLM_Triggers, LLM_Decision_Log RESTART IDENTITY CASCADE',
    );

    logger.info('✅ Database cleared successfully!');
    console.log('\n✅ Все таблицы очищены:');
    console.log('   - ActivePositions');
    console.log('   - ActiveOrders');
    console.log('   - TSL_State');
    console.log('   - TradeHistory');
    console.log('   - LLM_Triggers');
    console.log('   - LLM_Decision_Log');
    console.log('\n💡 Счетчики ID сброшены.');

    // Создаем начальные триггеры для всех пар из watchlist
    logger.info('Creating initial triggers for watchlist pairs...');
    const config = ConfigService.getInstance();
    const watchlist = config.getWatchlist();

    console.log(`\n📋 Создание начальных триггеров для пар: ${watchlist.join(', ')}`);

    for (const pair of watchlist) {
      // Создаем начальный триггер timeout на 1 минуту вперед (чтобы сразу запустить LLM)
      const initialTimeout = Date.now() + 60000; // 1 минута от текущего времени

      const triggerConditions = [
        {
          type: 'timeout',
          value: initialTimeout,
        },
      ];

      try {
        await pool.query(
          `INSERT INTO LLM_Triggers (pair, reason, trigger_conditions_json, requested_data_json, updated_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (pair) DO UPDATE SET
             reason = EXCLUDED.reason,
             trigger_conditions_json = EXCLUDED.trigger_conditions_json,
             requested_data_json = EXCLUDED.requested_data_json,
             updated_at = EXCLUDED.updated_at`,
          [pair, 'Initial trigger - first LLM call', JSON.stringify(triggerConditions), null, new Date()],
        );

        logger.info(`Created initial trigger for ${pair}`);
        console.log(`   ✅ Создан триггер для ${pair} (timeout: ${new Date(initialTimeout).toISOString()})`);
      } catch (error) {
        logger.error(`Failed to create trigger for ${pair}:`, error);
        console.error(`   ❌ Ошибка при создании триггера для ${pair}:`, error);
      }
    }

    console.log('\n✅ Начальные триггеры созданы! LLM запросы начнутся через ~1 минуту.');
    console.log('💡 Приложение готово к запуску с чистого листа.\n');
  } catch (error) {
    logger.error('❌ Failed to clear database:', error);
    console.error('\n❌ Ошибка при очистке базы данных:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

clearDatabase().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
