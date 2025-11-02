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

async function addVolatilePairs() {
  // 5 высоковолатильных пар, которых еще нет в отслеживании
  const newPairs = ['MATIC/USDT', 'DOT/USDT', 'LINK/USDT', 'UNI/USDT', 'ATOM/USDT'];

  console.log(`\n📊 Добавление высоковолатильных пар: ${newPairs.join(', ')}\n`);

  // Проверяем существующие триггеры
  const existingTriggersResult = await pool.query('SELECT pair FROM LLM_Triggers');
  const existingPairs = new Set(existingTriggersResult.rows.map((row: { pair: string }) => row.pair));

  console.log(`✅ Уже отслеживается пар: ${existingPairs.size}`);
  console.log(`   Пары: ${Array.from(existingPairs).sort().join(', ')}\n`);

  // Фильтруем пары, которые еще не отслеживаются
  const pairsToAdd = newPairs.filter((pair) => !existingPairs.has(pair));

  if (pairsToAdd.length === 0) {
    console.log('⚠️  Все указанные пары уже отслеживаются. Дополнительных действий не требуется.\n');
    await pool.end();
    return;
  }

  console.log(`📈 Добавление новых пар: ${pairsToAdd.length}`);
  console.log(`   Пары: ${pairsToAdd.join(', ')}\n`);

  // Создаем начальные триггеры для новых пар
  let addedCount = 0;
  for (const pair of pairsToAdd) {
    // Создаем начальный триггер timeout на 1 минуту вперед
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
        [pair, 'Added volatile pair - initial LLM call', JSON.stringify(triggerConditions), null, new Date()],
      );

      console.log(`✅ Добавлена пара ${pair} (timeout: ${new Date(initialTimeout).toISOString()})`);
      addedCount++;
    } catch (error) {
      console.error(`❌ Ошибка при добавлении пары ${pair}:`, error);
    }
  }

  await pool.end();
  console.log(`\n✅ Успешно добавлено пар: ${addedCount}/${pairsToAdd.length}`);
  console.log('📌 Примечание: Не забудьте обновить переменную WATCHLIST в .env файле на сервере!\n');
}

addVolatilePairs().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
