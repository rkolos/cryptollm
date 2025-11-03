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

async function createImmediateTriggers() {
  // Получаем watchlist из переменных окружения (как в ConfigService)
  const watchlist = (process.env.WATCHLIST || 'BTC/USDT,ETH/USDT,SOL/USDT,BNB/USDT,XRP/USDT,ADA/USDT,DOGE/USDT,AVAX/USDT,DOT/USDT,LINK/USDT,UNI/USDT,ATOM/USDT').split(',').map((p) => p.trim());

  console.log(`🚀 Создание НЕМЕДЛЕННЫХ триггеров для пар: ${watchlist.join(', ')}`);

  for (let i = 0; i < watchlist.length; i++) {
    const pair = watchlist[i];
    // Создаем триггер с задержкой 30 секунд + 5 секунд на каждую пару (чтобы не все сработали одновременно)
    const immediateTimeout = Date.now() + 30000 + (i * 5000); // 30 сек + 5 сек на пару

    const triggerConditions = [
      {
        type: 'timeout',
        value: immediateTimeout,
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
        [pair, 'Immediate trigger - manual activation after position close', JSON.stringify(triggerConditions), null, new Date()],
      );

      const triggerTime = new Date(immediateTimeout).toLocaleTimeString();
      console.log(`✅ ${pair}: триггер на ${triggerTime} (через ${Math.round((immediateTimeout - Date.now()) / 1000)} сек)`);
    } catch (error) {
      console.error(`❌ Ошибка при создании триггера для ${pair}:`, error);
    }
  }

  await pool.end();
  console.log('\n🎯 Немедленные триггеры созданы! LLM запросы начнутся через 30 секунд - 2 минуты.');
}

createImmediateTriggers().catch(console.error);
