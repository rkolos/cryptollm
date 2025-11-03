import { config } from 'dotenv';
import { Pool } from 'pg';

config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'cryptollm',
  password: process.env.DB_PASSWORD || 'cryptollm',
  database: process.env.DB_NAME || 'cryptollm',
});

async function debugTriggers() {
  try {
    const result = await pool.query(
      'SELECT pair, reason, trigger_conditions_json, updated_at FROM llm_triggers ORDER BY pair',
    );

    console.log('🔍 Отладка триггеров:\n');

    for (const row of result.rows) {
      console.log(`📌 Пара: ${row.pair}`);
      console.log(`   Причина: ${row.reason}`);
      console.log(`   Обновлено: ${row.updated_at}`);

      try {
        let conditions;
        if (typeof row.trigger_conditions_json === 'string') {
          conditions = JSON.parse(row.trigger_conditions_json);
        } else {
          // PostgreSQL JSONB возвращается как объект
          conditions = row.trigger_conditions_json;
        }
        console.log(`   Условия: ${JSON.stringify(conditions, null, 2)}`);

        // Проверяем timeout триггеры
        for (const condition of conditions) {
          if (condition.type === 'timeout') {
            const now = Date.now();
            const triggerTime = condition.value;
            const timeLeft = triggerTime - now;
            console.log(`   ⏰ Timeout триггер: ${new Date(triggerTime).toISOString()}`);
            console.log(
              `      Осталось: ${Math.round(timeLeft / 1000)} сек (${timeLeft > 0 ? 'будущий' : 'просрочен'})`,
            );
          }
        }
      } catch (e) {
        console.log(`   ❌ Ошибка парсинга условий: ${e}`);
      }

      console.log('');
    }
  } catch (error) {
    console.error('❌ Ошибка:', error);
  } finally {
    await pool.end();
  }
}

debugTriggers().catch(console.error);
