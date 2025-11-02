import { config } from 'dotenv';
import ccxt from 'ccxt';
import { ConfigService } from '../src/services/ConfigService.js';

config();

/**
 * Скрипт для проверки доступных пар на бирже
 */
async function checkAvailablePairs() {
  ConfigService.load();
  const configService = ConfigService.getInstance();
  const watchlist = configService.getWatchlist();
  const appMode = configService.getAppMode();

  const API_KEY = process.env.BINANCE_API_KEY;
  const API_SECRET = process.env.BINANCE_API_SECRET;

  if (!API_KEY || !API_SECRET) {
    console.error('❌ BINANCE_API_KEY или BINANCE_API_SECRET не установлены в .env файле.');
    process.exit(1);
  }

  try {
    const exchange = new ccxt.binance({
      apiKey: API_KEY,
      secret: API_SECRET,
      enableRateLimit: true,
      sandbox: appMode === 'testnet',
      options: {
        defaultType: 'spot',
      },
    });

    if (appMode === 'testnet') {
      exchange.setSandboxMode(true);
    }

    exchange.enableTimeSync = true;

    console.log('\n📡 Загрузка маркетов с биржи...');
    await exchange.loadMarkets();

    const availableMarkets = Object.keys(exchange.markets);
    console.log(`\n✅ Загружено маркетов: ${availableMarkets.length}`);

    console.log('\n📋 Проверка пар из watchlist:');
    console.log(`   Watchlist: ${watchlist.join(', ')}\n`);

    const unavailablePairs: string[] = [];
    const availablePairs: string[] = [];

    for (const pair of watchlist) {
      if (exchange.markets[pair]) {
        availablePairs.push(pair);
        console.log(`   ✅ ${pair} - доступна`);
      } else {
        unavailablePairs.push(pair);
        console.log(`   ❌ ${pair} - НЕ доступна`);

        // Попробуем найти альтернативные варианты
        const alternatives = availableMarkets.filter((m) => m.toLowerCase().includes(pair.split('/')[0].toLowerCase()));
        if (alternatives.length > 0) {
          console.log(`      Возможные альтернативы: ${alternatives.slice(0, 5).join(', ')}`);
        }
      }
    }

    console.log(`\n📊 Итого:`);
    console.log(`   Доступно: ${availablePairs.length}/${watchlist.length}`);
    console.log(`   Недоступно: ${unavailablePairs.length}/${watchlist.length}`);

    if (unavailablePairs.length > 0) {
      console.log(`\n⚠️  Недоступные пары: ${unavailablePairs.join(', ')}`);
      console.log(`\n💡 Рекомендация: Удалите эти пары из watchlist или из базы данных.`);
    }

    await exchange.close();
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('\n❌ Ошибка:', errorMessage);
    process.exit(1);
  }
}

checkAvailablePairs().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
