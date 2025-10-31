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

async function createInitialTriggers() {
  const watchlist = (process.env.WATCHLIST || 'BTC/USDT,ETH/USDT').split(',').map((p) => p.trim());

  console.log(`Создание начальных триггеров для пар: ${watchlist.join(', ')}`);

  for (const pair of watchlist) {
    // Создаем начальный триггер timeout на 1 минуту вперед (чтобы сразу запустить LLM)
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
        [pair, 'Initial trigger - first LLM call', JSON.stringify(triggerConditions), null, new Date()],
      );

      console.log(`✅ Создан начальный триггер для ${pair} (timeout: ${new Date(initialTimeout).toISOString()})`);
    } catch (error) {
      console.error(`❌ Ошибка при создании триггера для ${pair}:`, error);
    }
  }

  await pool.end();
  console.log('\n✅ Начальные триггеры созданы! LLM запросы начнутся через ~1 минуту.');
}

createInitialTriggers().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
