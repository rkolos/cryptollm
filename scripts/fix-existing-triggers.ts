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

async function fixExistingTriggers() {
  console.log('🔧 Исправление существующих триггеров LLM...\n');

  try {
    // Получаем все существующие триггеры
    const result = await pool.query('SELECT * FROM llm_triggers ORDER BY pair');
    const triggers = result.rows;

    console.log(`Найдено ${triggers.length} триггеров для проверки и исправления\n`);

    for (const trigger of triggers) {
      const pair = trigger.pair;
      console.log(`🔍 Проверяем триггер для ${pair}...`);

      let triggerConditions: unknown[] = [];
      try {
        if (typeof trigger.trigger_conditions_json === 'string') {
          triggerConditions = JSON.parse(trigger.trigger_conditions_json);
        } else {
          triggerConditions = trigger.trigger_conditions_json || [];
        }
      } catch (error) {
        console.log(`   ⚠️  Ошибка парсинга условий для ${pair}:`, error);
        continue;
      }

      // Проверяем, есть ли timeout триггер
      const hasTimeoutTrigger = triggerConditions.some((condition: unknown) => {
        const cond = condition as { type: string };
        return cond.type === 'timeout';
      });
      const needsFix = !hasTimeoutTrigger || triggerConditions.length === 0;

      if (needsFix) {
        console.log(`   🔧 Исправляем триггер для ${pair}...`);

        // Создаем новые условия триггера
        const newTriggerConditions = [
          {
            type: 'timeout',
            value: 120, // 120 минут по умолчанию
            condition: 'minutes_passed',
          },
          {
            type: 'indicator',
            name: 'rsi',
            timeframe: '1h',
            value: 35,
            condition: 'below',
          },
          {
            type: 'indicator',
            name: 'rsi',
            timeframe: '1h',
            value: 65,
            condition: 'above',
          },
        ];

        // Обновляем триггер в БД
        await pool.query(
          `UPDATE llm_triggers
           SET trigger_conditions_json = $1,
               reason = $2,
               updated_at = NOW()
           WHERE pair = $3`,
          [JSON.stringify(newTriggerConditions), 'Исправленный триггер: timeout 120 мин + RSI индикаторы', pair],
        );

        console.log(`   ✅ Триггер для ${pair} исправлен`);
      } else {
        // Проверяем, правильные ли значения timeout
        const timeoutTrigger = triggerConditions.find((condition: unknown) => {
          const cond = condition as { type: string };
          return cond.type === 'timeout';
        }) as { value: number } | undefined;

        if (timeoutTrigger && timeoutTrigger.value === 0) {
          console.log(`   🔧 Исправляем timeout значение с 0 на 120 для ${pair}...`);

          // Обновляем значение timeout
          timeoutTrigger.value = 120;

          await pool.query(
            `UPDATE llm_triggers
             SET trigger_conditions_json = $1,
                 reason = $2,
                 updated_at = NOW()
             WHERE pair = $3`,
            [JSON.stringify(triggerConditions), 'Исправленный триггер: timeout исправлен с 0 на 120 минут', pair],
          );

          console.log(`   ✅ Timeout значение исправлено для ${pair}`);
        } else {
          console.log(`   ✅ Триггер для ${pair} в порядке`);
        }
      }
    }

    console.log('\n✅ Исправление триггеров завершено!');

    // Проверяем результат
    console.log('\n🔍 Проверяем результат исправления...\n');
    const finalResult = await pool.query(
      'SELECT pair, trigger_conditions_json, updated_at FROM llm_triggers ORDER BY pair',
    );

    for (const trigger of finalResult.rows) {
      const pair = trigger.pair;
      const conditions = JSON.parse(trigger.trigger_conditions_json);
      const timeoutTrigger = conditions.find((c: unknown) => {
        const cond = c as { type: string };
        return cond.type === 'timeout';
      });

      const timeoutValue = timeoutTrigger ? (timeoutTrigger as { value: number }).value : 'НЕТ';
      console.log(
        `${pair}: timeout=${timeoutValue} мин, updated=${new Date(trigger.updated_at).toLocaleString('ru-RU')}`,
      );
    }
  } catch (error) {
    console.error('❌ Ошибка при исправлении триггеров:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

fixExistingTriggers().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
