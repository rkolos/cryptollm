import { ConfigService } from './services/ConfigService.js';
import { LoggingService } from './services/LoggingService.js';

async function main() {
  ConfigService.load();

  LoggingService.initialize();

  const logger = LoggingService.getInstance().getLogger('Application');

  logger.info('LoggingService initialized.');
  logger.info(`APP_MODE set to: ${ConfigService.getInstance().getAppMode()}`);

  logger.info('Service starting...');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
