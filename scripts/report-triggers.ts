import { ConfigService } from '../src/services/ConfigService.js';
import { LoggingService } from '../src/services/LoggingService.js';
import pkg from 'pg';
const { Pool } = pkg;

async function reportTriggers() {
  console.log('📊 ОТЧЕТ О СОСТОЯНИИ ТРИГГЕРОВ\n');

  // Инициализация сервисов
  ConfigService.load();
  LoggingService.initialize();
  const config = ConfigService.getInstance();

  // Создаем пул подключений к БД
  const pool = new Pool({
    host: config.getDbConfig().host,
    port: config.getDbConfig().port,
    user: config.getDbConfig().user,
    password: config.getDbConfig().password,
    database: config.getDbConfig().database,
  });

  const watchlist = config.getWatchlist();
  console.log(`📋 Watchlist: ${watchlist.join(', ')}\n`);
  console.log(`📊 Всего пар в watchlist: ${watchlist.length}\n`);

  try {
    // Получаем все триггеры
    const triggersResult = await pool.query(`
      SELECT pair, reason, trigger_conditions_json, updated_at
      FROM llm_triggers
      ORDER BY pair, updated_at DESC
    `);

    const triggersMap = new Map<
      string,
      {
        pair: string;
        reason: string;
        conditions: unknown[];
        updated_at: string;
      }
    >();
    triggersResult.rows.forEach(
      (row: { pair: string; reason: string; trigger_conditions_json: unknown[]; updated_at: string }) => {
        if (!triggersMap.has(row.pair)) {
          triggersMap.set(row.pair, {
            pair: row.pair,
            reason: row.reason,
            conditions: row.trigger_conditions_json,
            updated_at: row.updated_at,
          });
        }
      },
    );

    // Анализ состояния триггеров
    let activeTriggers = 0;
    let pairsWithTriggers = 0;
    let pairsWithoutTriggers = 0;

    console.log('🔍 ПОДРОБНЫЙ АНАЛИЗ ПО ПАРАМ:\n');

    for (const pair of watchlist) {
      const trigger = triggersMap.get(pair);

      if (trigger) {
        pairsWithTriggers++;
        activeTriggers++;

        // Показываем полную информацию о триггере
        const conditions = Array.isArray(trigger.conditions) ? trigger.conditions : [trigger.conditions];
        console.log(`   📋 Полные условия триггера:`);

        conditions.forEach((cond: unknown, index: number) => {
          console.log(`     ${index + 1}. ${JSON.stringify(cond, null, 2)}`);
        });

        const updatedAt = new Date(trigger.updated_at).toLocaleString('ru-RU');

        console.log(`✅ ${pair}`);
        console.log(`   📅 Обновлено: ${updatedAt}`);
        console.log(`   📝 Причина: ${trigger.reason}`);
        console.log('');
      } else {
        pairsWithoutTriggers++;
        console.log(`❌ ${pair} - НЕТ АКТИВНЫХ ТРИГГЕРОВ`);
        console.log('');
      }
    }

    // Итоговая статистика
    console.log('📈 ИТОГОВАЯ СТАТИСТИКА:\n');
    console.log(`🎯 Всего пар в watchlist: ${watchlist.length}`);
    console.log(`✅ Пар с активными триггерами: ${pairsWithTriggers}`);
    console.log(`❌ Пар без триггеров: ${pairsWithoutTriggers}`);
    console.log(`🔄 Общее количество триггеров: ${activeTriggers}`);

    if (pairsWithoutTriggers > 0) {
      console.log(`\n⚠️  ВНИМАНИЕ: ${pairsWithoutTriggers} пар не имеют активных триггеров!`);
    } else {
      console.log(`\n🎉 ОТЛИЧНО: Все пары имеют активные триггеры!`);
    }

    // Закрываем соединение с БД
    await pool.end();
  } catch (error) {
    console.error('❌ Ошибка при получении данных о триггерах:', error);
    await pool.end();
    process.exit(1);
  }
}

// Запуск скрипта
reportTriggers().catch((error) => {
  console.error('❌ Критическая ошибка:', error);
  process.exit(1);
});
