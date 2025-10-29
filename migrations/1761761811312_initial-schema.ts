import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { MigrationBuilder } from 'node-pg-migrate';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const up = async (pgm: MigrationBuilder) => {
  const sqlPath = join(__dirname, 'sql', '001_initial_schema.sql');
  const sql = readFileSync(sqlPath, 'utf-8');
  await pgm.sql(sql);
};

export const down = async (pgm: MigrationBuilder) => {
  await pgm.sql('DROP TABLE IF EXISTS "LLM_Decision_Log";');
  await pgm.sql('DROP TABLE IF EXISTS "TradeHistory";');
  await pgm.sql('DROP TABLE IF EXISTS "LLM_Triggers";');
  await pgm.sql('DROP TABLE IF EXISTS "TSL_State";');
  await pgm.sql('DROP TABLE IF EXISTS "ActiveOrders";');
  await pgm.sql('DROP TABLE IF EXISTS "ActivePositions";');
};
