import { config } from 'dotenv';
import { Pool } from 'pg';
import { ConfigService } from '../src/services/ConfigService.js';

config();

/**
 * Скрипт для принудительной инициализации всех триггеров для всех валютных пар
 * Устанавливает timeout триггеры на немедленное срабатывание
 */
async function forceTriggerAll() {
  // Инициализируем ConfigService для получения конфигурации БД
  ConfigService.load();
  const configService = ConfigService.getInstance();
  const dbConfig = configService.getDbConfig();

  const pool = new Pool({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
  });

  try {
    console.log('\n🚀 Принудительная инициализация всех триггеров...\n');

    // Получаем все пары из БД (из таблицы LLM_Triggers)
    const triggersResult = await pool.query('SELECT pair FROM LLM_Triggers ORDER BY pair');
    const pairs = triggersResult.rows.map((row: { pair: string }) => row.pair);

    if (pairs.length === 0) {
      console.log(
        '⚠️  В БД нет триггеров. Сначала создайте триггеры с помощью скрипта create-initial-triggers или fill-missing-triggers.\n',
      );
      return;
    }

    console.log(`📋 Найдено пар с триггерами: ${pairs.length}`);
    console.log(`   Пары: ${pairs.join(', ')}\n`);

    // Устанавливаем timeout триггер на немедленное срабатывание
    // Используем формат minutes_passed с значением 0 и устанавливаем updated_at в прошлое
    // Это гарантирует, что триггер сработает при следующей проверке SlowCycle
    const triggerConditions = [
      {
        type: 'timeout',
        condition: 'minutes_passed',
        value: 0, // Немедленное срабатывание
      },
    ];

    let updatedCount = 0;
    for (const pair of pairs) {
      try {
        // Обновляем триггер с установкой updated_at на 2 минуты назад
        // Это гарантирует, что условие minutes_passed >= 0 будет выполнено немедленно
        await pool.query(
          `UPDATE LLM_Triggers 
           SET reason = $1,
               trigger_conditions_json = $2,
               updated_at = NOW() - INTERVAL '2 minutes'
           WHERE pair = $3`,
          ['Принудительная инициализация триггера - немедленное срабатывание', JSON.stringify(triggerConditions), pair],
        );

        console.log(`   ✅ Обновлен триггер для ${pair} (сработает при следующей проверке SlowCycle)`);
        updatedCount++;
      } catch (error) {
        console.error(`   ❌ Ошибка при обновлении триггера для ${pair}:`, error);
      }
    }

    console.log(`\n✅ Готово! Обновлено триггеров: ${updatedCount}/${pairs.length}`);
    console.log(`💡 Триггеры сработают при следующем тике SlowCycle (обычно каждые 30-60 секунд).\n`);
  } catch (error) {
    console.error('❌ Критическая ошибка:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

forceTriggerAll().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
