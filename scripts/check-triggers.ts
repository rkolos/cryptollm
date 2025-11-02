import { config } from 'dotenv';
import { Pool } from 'pg';
import { ConfigService } from '../src/services/ConfigService.js';

config();

async function checkTriggers() {
  // Инициализируем ConfigService для получения watchlist
  ConfigService.load();
  const configService = ConfigService.getInstance();
  const watchlist = configService.getWatchlist();

  const dbConfig = configService.getDbConfig();
  const pool = new Pool({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
  });

  try {
    console.log(`\n📋 Проверка триггеров для пар из watchlist:`);
    console.log(`   Watchlist: ${watchlist.join(', ')}\n`);

    // Получаем все существующие триггеры
    const existingTriggersResult = await pool.query('SELECT pair FROM LLM_Triggers ORDER BY pair');
    const existingPairs = new Set(existingTriggersResult.rows.map((row: { pair: string }) => row.pair));

    console.log(`✅ Найдено пар с триггерами в БД: ${existingPairs.size}`);
    console.log(`   Пары: ${Array.from(existingPairs).sort().join(', ') || '(нет)'}\n`);

    // Определяем пары без триггеров
    const pairsWithoutTriggers = watchlist.filter((pair) => !existingPairs.has(pair));

    // Определяем лишние триггеры (не в watchlist)
    const pairsInDbButNotInWatchlist = Array.from(existingPairs).filter((pair) => !watchlist.includes(pair));

    if (pairsWithoutTriggers.length === 0 && pairsInDbButNotInWatchlist.length === 0) {
      console.log('✅ Все пары из watchlist имеют триггеры. Лишних триггеров нет.\n');
      return;
    }

    if (pairsWithoutTriggers.length > 0) {
      console.log(`⚠️  Найдено пар БЕЗ триггеров: ${pairsWithoutTriggers.length}`);
      console.log(`   Пары: ${pairsWithoutTriggers.join(', ')}\n`);
      console.log(`💡 Для создания недостающих триггеров запустите: npm run fill-triggers\n`);
    }

    if (pairsInDbButNotInWatchlist.length > 0) {
      console.log(`ℹ️  Найдено триггеров для пар, которых нет в watchlist: ${pairsInDbButNotInWatchlist.length}`);
      console.log(`   Пары: ${pairsInDbButNotInWatchlist.join(', ')}\n`);
    }
  } catch (error) {
    console.error('❌ Критическая ошибка:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

checkTriggers().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
