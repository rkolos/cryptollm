import { config } from 'dotenv';
import { Pool } from 'pg';
import { ConfigService } from '../src/services/ConfigService.js';

config();

async function addMissingTimeoutTriggers() {
  // Инициализируем ConfigService
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
    console.log(`\n📋 Проверка и добавление отсутствующих timeout триггеров...\n`);

    // Получаем все существующие триггеры
    const existingTriggersResult = await pool.query(
      'SELECT pair, trigger_conditions_json FROM llm_triggers ORDER BY pair',
    );
    const allTriggers = existingTriggersResult.rows;

    let updatedCount = 0;
    const defaultTimeoutMinutes = 60; // По умолчанию 60 минут

    for (const row of allTriggers) {
      const pair = row.pair;
      let triggerConditions = row.trigger_conditions_json;

      // Если trigger_conditions_json это строка, парсим её
      if (typeof triggerConditions === 'string') {
        try {
          triggerConditions = JSON.parse(triggerConditions);
        } catch (error) {
          console.error(`   ❌ Ошибка парсинга trigger_conditions_json для ${pair}:`, error);
          continue;
        }
      }

      // Проверяем, есть ли timeout триггер
      if (!Array.isArray(triggerConditions)) {
        console.warn(`   ⚠️  ${pair}: trigger_conditions_json не является массивом, пропускаем`);
        continue;
      }

      const hasTimeoutTrigger = triggerConditions.some((trigger: unknown) => {
        if (typeof trigger === 'object' && trigger !== null) {
          const t = trigger as { type?: string };
          return t.type === 'timeout';
        }
        return false;
      });

      if (!hasTimeoutTrigger) {
        // Добавляем timeout триггер
        const updatedTriggers = [
          ...triggerConditions,
          {
            type: 'timeout',
            condition: 'minutes_passed',
            value: defaultTimeoutMinutes,
          },
        ];

        try {
          await pool.query(
            `UPDATE llm_triggers 
             SET trigger_conditions_json = $1, 
                 updated_at = $2
             WHERE pair = $3`,
            [JSON.stringify(updatedTriggers), new Date(), pair],
          );

          console.log(`   ✅ Добавлен timeout триггер для ${pair} (${defaultTimeoutMinutes} минут)`);
          updatedCount++;
        } catch (error) {
          console.error(`   ❌ Ошибка при обновлении триггера для ${pair}:`, error);
        }
      } else {
        console.log(`   ✓ ${pair}: timeout триггер уже присутствует`);
      }
    }

    console.log(`\n✅ Готово! Обновлено триггеров: ${updatedCount}/${allTriggers.length}\n`);
  } catch (error) {
    console.error('❌ Критическая ошибка:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

addMissingTimeoutTriggers().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
