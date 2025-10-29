import { ConfigService } from './services/ConfigService.js';
import { LoggingService } from './services/LoggingService.js';
import { GlobalStateService } from './services/GlobalStateService.js';
import { DatabaseService } from './services/DatabaseService.js';

async function main() {
  ConfigService.load();

  LoggingService.initialize();

  GlobalStateService.getInstance();

  await DatabaseService.initialize();

  const logger = LoggingService.getInstance().getLogger('Application');
  logger.info('Core services initialized: ConfigService, LoggingService, GlobalStateService, DatabaseService');
  logger.info(`APP_MODE set to: ${ConfigService.getInstance().getAppMode()}`);

  logger.info('Service starting...');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
