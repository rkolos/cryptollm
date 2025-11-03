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

async function restoreXRPPosition() {
  console.log('🔧 Восстановление позиции XRP/USDT в БД...\n');

  try {
    // Проверяем текущие позиции XRP
    const existingPosition = await pool.query('SELECT * FROM activepositions WHERE pair = $1', ['XRP/USDT']);

    if (existingPosition.rows.length > 0) {
      console.log('⚠️  Позиция XRP/USDT уже существует в БД:', existingPosition.rows[0]);
      return;
    }

    // Получаем последний лог LLM для XRP для понимания параметров позиции
    const lastLLMLog = await pool.query(
      `SELECT response_payload_json
       FROM llm_decision_log
       WHERE triggered_pair = $1 AND decision_result = 'accepted'
       ORDER BY timestamp DESC LIMIT 1`,
      ['XRP/USDT'],
    );

    let entryPrice = '2.5499'; // Значение из логов по умолчанию
    let amount = '170'; // Текущий баланс на бирже

    if (lastLLMLog.rows.length > 0) {
      try {
        const response = lastLLMLog.rows[0].response_payload_json;
        console.log('📝 Найден последний успешный лог LLM для XRP');

        // Ищем упоминание о позиции в justification
        const justification = response.decisions?.[0]?.justification || '';
        const priceMatch = justification.match(/средней цене ([\d.]+)/);
        const amountMatch = justification.match(/объемом ([\d.]+) единиц/);

        if (priceMatch) {
          entryPrice = priceMatch[1];
          console.log(`📊 Извлечена средняя цена входа: ${entryPrice}`);
        }

        if (amountMatch) {
          amount = amountMatch[1];
          console.log(`📊 Извлечено количество: ${amount}`);
        }
      } catch (error) {
        console.log('⚠️  Не удалось извлечь данные из лога LLM, использую значения по умолчанию');
      }
    }

    // Создаем позицию в БД
    const insertQuery = `
      INSERT INTO activepositions (
        pair, side, amount, average_entry_price, total_fee_cost, created_at
      ) VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (pair) DO UPDATE SET
        side = EXCLUDED.side,
        amount = EXCLUDED.amount,
        average_entry_price = EXCLUDED.average_entry_price,
        total_fee_cost = EXCLUDED.total_fee_cost
    `;

    await pool.query(insertQuery, [
      'XRP/USDT',
      'long', // Предполагаем long позицию
      amount,
      entryPrice,
      '0.00000000', // Без комиссий
    ]);

    console.log(`✅ Позиция XRP/USDT восстановлена:`);
    console.log(`   - Количество: ${amount}`);
    console.log(`   - Средняя цена входа: ${entryPrice}`);
    console.log(`   - Сторона: long`);

    // Проверяем результат
    const result = await pool.query('SELECT * FROM activepositions WHERE pair = $1', ['XRP/USDT']);

    if (result.rows.length > 0) {
      console.log('\n📋 Финальное состояние позиции:');
      console.log(result.rows[0]);
    }
  } catch (error) {
    console.error('❌ Ошибка при восстановлении позиции XRP:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

restoreXRPPosition().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
