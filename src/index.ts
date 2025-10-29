import { ConfigService } from './services/ConfigService.js';

async function main() {
  ConfigService.load();

  console.log('Service starting...');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
