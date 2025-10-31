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
    console.log('\n💡 Счетчики ID сброшены. Приложение готово к запуску с чистого листа.\n');
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
