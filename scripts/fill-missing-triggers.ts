import { config } from 'dotenv';
import { Pool } from 'pg';
import { ConfigService } from '../src/services/ConfigService.js';

config();

async function fillMissingTriggers() {
  // Инициализируем ConfigService для получения watchlist и конфигурации
  ConfigService.load();
  const configService = ConfigService.getInstance();
  const watchlist = configService.getWatchlist();
  const defaultTimeoutMinutes = configService.getDefaultTriggerTimeoutMinutes();

  const dbConfig = configService.getDbConfig();
  const pool = new Pool({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
  });

  try {
    console.log(`\n📋 Проверка триггеров для пар из watchlist: ${watchlist.join(', ')}\n`);

    // Получаем все существующие триггеры
    const existingTriggersResult = await pool.query('SELECT pair FROM LLM_Triggers');
    const existingPairs = new Set(existingTriggersResult.rows.map((row: { pair: string }) => row.pair));

    console.log(`✅ Найдено пар с триггерами: ${existingPairs.size}`);
    console.log(`   Пары: ${Array.from(existingPairs).join(', ') || '(нет)'}\n`);

    // Определяем пары без триггеров
    const pairsWithoutTriggers = watchlist.filter((pair) => !existingPairs.has(pair));

    if (pairsWithoutTriggers.length === 0) {
      console.log('✅ Все пары из watchlist уже имеют триггеры. Дополнительных действий не требуется.\n');
      return;
    }

    console.log(`⚠️  Найдено пар БЕЗ триггеров: ${pairsWithoutTriggers.length}`);
    console.log(`   Пары: ${pairsWithoutTriggers.join(', ')}\n`);

    // Создаем дефолтные триггеры для пар без триггеров
    let createdCount = 0;
    for (const pair of pairsWithoutTriggers) {
      const triggerConditions = [
        {
          type: 'timeout',
          condition: 'minutes_passed',
          value: defaultTimeoutMinutes,
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
          [
            pair,
            `Автоматически созданный триггер: проверка через ${defaultTimeoutMinutes} минут`,
            JSON.stringify(triggerConditions),
            null,
            new Date(),
          ],
        );

        console.log(`   ✅ Создан триггер для ${pair} (timeout: ${defaultTimeoutMinutes} минут)`);
        createdCount++;
      } catch (error) {
        console.error(`   ❌ Ошибка при создании триггера для ${pair}:`, error);
      }
    }

    console.log(`\n✅ Готово! Создано триггеров: ${createdCount}/${pairsWithoutTriggers.length}`);
    console.log(`💡 Триггеры сработают через ${defaultTimeoutMinutes} минут после следующего тика SlowCycle.\n`);
  } catch (error) {
    console.error('❌ Критическая ошибка:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

fillMissingTriggers().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
