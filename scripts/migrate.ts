import 'dotenv/config';
import { ConfigService } from '../src/services/ConfigService.js';
import { runner } from 'node-pg-migrate';

async function main() {
  ConfigService.load();

  const direction = process.argv[2];

  if (!direction || (direction !== 'up' && direction !== 'down')) {
    console.error('Usage: npm run migrate:run -- [up|down]');
    process.exit(1);
  }

  const dbConfig = ConfigService.getInstance().getDbConfig();
  const databaseUrl = `postgresql://${dbConfig.user}:${dbConfig.password}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`;

  try {
    await runner({
      databaseUrl,
      dir: 'migrations',
      direction: direction as 'up' | 'down',
      migrationsTable: 'pgmigrations',
      count: Infinity,
    });

    console.log(`Migration ${direction} completed successfully.`);
  } catch (error) {
    console.error(`Migration ${direction} failed:`, error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
