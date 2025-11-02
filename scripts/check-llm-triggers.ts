import { config } from 'dotenv';
import { Pool } from 'pg';

config();

async function checkLLMTriggers() {
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER || 'cryptollm',
    password: process.env.DB_PASSWORD || 'cryptollm',
    database: process.env.DB_NAME || 'cryptollm',
  });

  try {
    console.log('\n=== Проверка триггеров LLM в БД ===\n');

    const result = await pool.query('SELECT * FROM llm_triggers ORDER BY pair');

    if (result.rows.length === 0) {
      console.log('❌ В таблице LLM_Triggers нет записей!\n');
      console.log('Триггеры должны быть созданы либо:');
      console.log('  1. Через скрипт: npm run create-triggers');
      console.log('  2. Автоматически после первого ответа от LLM\n');
      return;
    }

    console.log(`✅ Найдено записей: ${result.rows.length}\n`);

    for (const row of result.rows) {
      const pair = row.pair;
      const reason = row.reason || '(не указана)';
      const updatedAt = new Date(row.updated_at).toLocaleString('ru-RU');
      const triggerConditions = row.trigger_conditions_json;
      const requestedData = row.requested_data_json;

      console.log(`📊 Пара: ${pair}`);
      console.log(`   Причина: ${reason}`);
      console.log(`   Обновлено: ${updatedAt}`);

      // Парсим trigger_conditions_json
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let conditions: any[] = [];
      if (triggerConditions) {
        try {
          if (typeof triggerConditions === 'string') {
            conditions = JSON.parse(triggerConditions);
          } else {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            conditions = triggerConditions as any;
          }
        } catch (error) {
          console.log(`   ⚠️  Ошибка парсинга trigger_conditions_json: ${error}`);
        }
      }

      if (conditions.length === 0) {
        console.log(`   ⚠️  Нет условий триггеров!`);
      } else {
        console.log(`   Условия триггеров (${conditions.length}):`);
        for (const condition of conditions) {
          const type = condition.type || 'unknown';
          const value = condition.value;
          const name = condition.name || '';
          const timeframe = condition.timeframe || '';
          const conditionStr = condition.condition || '';

          let displayValue = value;
          if (type === 'timeout') {
            if (conditionStr === 'minutes_passed') {
              // Для minutes_passed значение - это количество минут
              const updatedAtTime = new Date(row.updated_at).getTime();
              const minutesPassed = Math.floor((Date.now() - updatedAtTime) / 60000);
              const requiredMinutes = value;
              const remainingMinutes = requiredMinutes - minutesPassed;
              if (remainingMinutes <= 0) {
                displayValue = `${value} минут (ПРОСРОЧЕН на ${Math.abs(remainingMinutes)} мин)`;
              } else {
                displayValue = `${value} минут (осталось ${remainingMinutes} мин до срабатывания)`;
              }
            } else {
              // Старый формат: timestamp в миллисекундах
              const timeoutDate = new Date(value);
              const now = Date.now();
              const diff = value - now;
              if (diff > 0) {
                const minutes = Math.floor(diff / 60000);
                const seconds = Math.floor((diff % 60000) / 1000);
                displayValue = `${timeoutDate.toLocaleString('ru-RU')} (через ${minutes}м ${seconds}с)`;
              } else {
                displayValue = `${timeoutDate.toLocaleString('ru-RU')} (ПРОСРОЧЕН на ${Math.abs(Math.floor(diff / 1000))}с)`;
              }
            }
          }

          console.log(`      - Тип: ${type}`);
          if (conditionStr) console.log(`        Условие: ${conditionStr}`);
          if (name) console.log(`        Индикатор: ${name}`);
          if (timeframe) console.log(`        Таймфрейм: ${timeframe}`);
          console.log(`        Значение: ${displayValue}`);
        }
      }

      if (requestedData) {
        let requested: string[] = [];
        try {
          if (typeof requestedData === 'string') {
            requested = JSON.parse(requestedData);
          } else {
            requested = requestedData;
          }
        } catch (error) {
          console.log(`   ⚠️  Ошибка парсинга requested_data_json: ${error}`);
        }

        if (requested.length > 0) {
          console.log(`   Запрошенные данные: ${requested.join(', ')}`);
        }
      }

      console.log('');
    }

    // Проверяем последние ответы LLM
    console.log('\n=== Последние ответы LLM (для проверки) ===\n');
    const llmLogResult = await pool.query(
      `SELECT id, triggered_pair, trigger_reason, 
              response_payload_json, decision_result, timestamp
       FROM LLM_Decision_Log 
       ORDER BY timestamp DESC 
       LIMIT 5`,
    );

    if (llmLogResult.rows.length === 0) {
      console.log('❌ В таблице LLM_Decision_Log нет записей\n');
    } else {
      console.log(`Найдено последних записей: ${llmLogResult.rows.length}\n`);
      for (const logRow of llmLogResult.rows) {
        const logId = logRow.id;
        const pair = logRow.triggered_pair;
        const reason = logRow.trigger_reason;
        const result = logRow.decision_result;
        const timestamp = new Date(logRow.timestamp).toLocaleString('ru-RU');
        const responseJson = logRow.response_payload_json;

        console.log(`📝 Лог #${logId} - ${pair}`);
        console.log(`   Причина: ${reason}`);
        console.log(`   Статус: ${result}`);
        console.log(`   Время: ${timestamp}`);

        if (responseJson) {
          try {
            const response = typeof responseJson === 'string' ? JSON.parse(responseJson) : responseJson;
            if (response.next_call_triggers) {
              console.log(`   ✅ LLM вернул next_call_triggers для: ${response.update_triggers_for_pair}`);
              console.log(`      Количество условий: ${response.next_call_triggers.trigger_conditions?.length || 0}`);
            } else {
              console.log(`   ⚠️  LLM НЕ вернул next_call_triggers!`);
            }
          } catch (error) {
            console.log(`   ⚠️  Ошибка парсинга response_payload_json: ${error}`);
          }
        }
        console.log('');
      }
    }
  } catch (error) {
    console.error('❌ Ошибка при проверке триггеров:', error);
  } finally {
    await pool.end();
  }
}

checkLLMTriggers().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
