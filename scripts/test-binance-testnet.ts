import { config } from 'dotenv';
import ccxt from 'ccxt';

config(); // Load environment variables from .env file

const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
const APP_MODE = process.env.APP_MODE;

if (!API_KEY || !API_SECRET) {
  console.error('❌ BINANCE_API_KEY или BINANCE_API_SECRET не установлены в .env файле.');
  process.exit(1);
}

if (APP_MODE !== 'testnet') {
  console.warn('⚠️  APP_MODE не установлен в "testnet". Текущее значение:', APP_MODE);
  console.warn('   Установите APP_MODE=testnet в .env для использования песочницы.');
}

async function testBinanceTestnet() {
  console.log('🔍 Проверка подключения к Binance Testnet...\n');

  try {
    // Создаем экземпляр биржи с sandbox режимом
    const exchange = new ccxt.binance({
      apiKey: API_KEY,
      secret: API_SECRET,
      enableRateLimit: true,
      sandbox: true, // Включаем sandbox режим сразу
      options: {
        defaultType: 'spot',
        recvWindow: 10000, // Увеличиваем окно времени до 10 секунд
      },
    });

    // Также устанавливаем через метод для совместимости
    exchange.setSandboxMode(true);

    // Включаем автоматическую синхронизацию времени
    exchange.enableTimeSync = true;

    // Синхронизируем время явно перед первым запросом
    console.log('   ⏰ Синхронизация времени с сервером...');
    try {
      // Делаем простой запрос для синхронизации времени
      await exchange.loadMarkets();

      // Если после загрузки маркетов все еще есть проблема, делаем явный запрос времени
      try {
        const serverTime = await exchange.fetchTime();
        const localTime = Date.now();
        const timeDiff = serverTime - localTime;
        console.log(`   ✅ Время синхронизировано (разница: ${timeDiff}ms)`);

        // Устанавливаем timeDifference явно для CCXT
        if (exchange.timeDifference === undefined || Math.abs(exchange.timeDifference - timeDiff) > 100) {
          exchange.timeDifference = timeDiff;
          console.log(`   🔧 Установлен timeDifference: ${timeDiff}ms`);
        }

        if (exchange.timeDifference !== undefined) {
          console.log(`   📊 CCXT timeDifference: ${exchange.timeDifference}ms`);
        }
      } catch (timeError) {
        // Игнорируем ошибку получения времени, продолжаем
        console.log('   ⚠️  Не удалось получить время сервера, но продолжаем...');
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('Timestamp')) {
        console.log('   ⚠️  Первая попытка синхронизации не удалась, повторная попытка...');
        // Даем CCXT второй шанс синхронизировать время
        await new Promise((resolve) => setTimeout(resolve, 2000));
        // Пробуем еще раз загрузить маркеты
        try {
          await exchange.loadMarkets();
        } catch (retryError: unknown) {
          // Если все еще ошибка, продолжаем - возможно ключи неверны
          const retryErrorMessage = retryError instanceof Error ? retryError.message : String(retryError);
          console.log(`   ⚠️  Повторная попытка не удалась: ${retryErrorMessage}`);
        }
      } else {
        throw error;
      }
    }

    console.log('📡 Тестирование подключения...');
    console.log('   API URL:', exchange.urls.api.public || exchange.urls.api);
    console.log('   Sandbox Mode:', exchange.sandbox ? '✅ Включен' : '❌ Выключен');
    console.log('   Time Sync:', exchange.enableTimeSync ? '✅ Включена' : '❌ Выключена');
    console.log('');

    // Проверка 1: Получение баланса
    console.log('1️⃣  Проверка баланса...');
    try {
      // Повторная попытка после синхронизации времени
      // recvWindow уже установлен в options экземпляра
      const balance = await exchange.fetchBalance();
      console.log('   ✅ Баланс получен успешно!');
      console.log('   📊 Доступные активы:');

      const currencies = Object.keys(balance).filter(
        (key) => balance[key].free > 0 || balance[key].used > 0 || balance[key].total > 0,
      );

      if (currencies.length === 0) {
        console.log('   ⚠️  Нет активов с ненулевым балансом');
      } else {
        currencies.slice(0, 10).forEach((currency) => {
          const { free, used, total } = balance[currency];
          if (total > 0) {
            console.log(`      ${currency}: свободно=${free}, используется=${used}, всего=${total}`);
          }
        });
        if (currencies.length > 10) {
          console.log(`      ... и еще ${currencies.length - 10} активов`);
        }
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('Timestamp')) {
        console.error('   ❌ Ошибка синхронизации времени:', errorMessage);
        console.error('');
        console.error('   🔍 Диагностика:');
        console.error('      - Sandbox Mode: ✅ Включен');
        console.error('      - API URL: testnet.binance.vision ✅');
        console.error('      - Время синхронизировано: ✅');
        console.error('');
        console.error('   ⚠️  ВАЖНО: Эта ошибка может означать:');
        console.error('      1. Вы используете ключи от ОСНОВНОГО Binance аккаунта вместо Testnet');
        console.error('      2. Ключи от Testnet созданы недавно и еще не активированы');
        console.error('      3. Проблема с синхронизацией времени на стороне CCXT');
        console.error('');
        console.error('   💡 Проверьте:');
        console.error('      ✓ Убедитесь, что получили ключи именно с https://testnet.binance.vision/');
        console.error('      ✓ Не используйте ключи от основного аккаунта binance.com');
        console.error('      ✓ Проверьте, что ключи скопированы полностью без пробелов');
        console.error('      ✓ Убедитесь, что в .env установлен APP_MODE=testnet');
        console.error('');
        console.error('   💡 Альтернативное решение:');
        console.error('      Попробуйте перезапустить проект - иногда помогает при первом подключении');
      } else {
        console.error('   ❌ Ошибка при получении баланса:', errorMessage);
        if (errorMessage.includes('401') || errorMessage.includes('403')) {
          console.error('   ⚠️  Возможно, ключи от testnet аккаунта не установлены или неверны.');
        }
      }
      throw error;
    }

    console.log('');

    // Проверка 2: Получение тикера
    console.log('2️⃣  Проверка получения рыночных данных...');
    try {
      const ticker = await exchange.fetchTicker('BTC/USDT');
      console.log('   ✅ Рыночные данные получены успешно!');
      console.log(`   📈 BTC/USDT: последняя цена = ${ticker.last}`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('   ❌ Ошибка при получении тикера:', errorMessage);
      throw error;
    }

    console.log('');

    // Проверка 3: Проверка статуса аккаунта
    console.log('3️⃣  Проверка статуса аккаунта...');
    try {
      await exchange.fetchBalance();
      console.log('   ✅ Аккаунт активен и доступен!');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('   ❌ Ошибка при проверке аккаунта:', errorMessage);
      throw error;
    }

    console.log('');
    console.log('✅ Все проверки пройдены успешно!');
    console.log('🎉 Binance Testnet подключен и работает корректно.');
    console.log('');
    console.log('📝 Следующие шаги:');
    console.log('   1. Убедитесь, что APP_MODE=testnet в .env');
    console.log('   2. Запустите проект: npm start');
    console.log('   3. Все операции будут выполняться в тестовом окружении');

    await exchange.close();
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('');
    console.error('❌ Ошибка подключения к Binance Testnet:');
    console.error('   Сообщение:', errorMessage);
    console.error('');
    console.error('🔧 Возможные причины:');
    console.error('   1. API ключи не от testnet аккаунта');
    console.error('   2. Неверные API ключи или секрет');
    console.error('   3. Проблемы с сетью');
    console.error('');
    console.error('📖 Инструкция по получению testnet ключей:');
    console.error('   1. Перейдите на https://testnet.binance.vision/');
    console.error('   2. Войдите через GitHub');
    console.error('   3. Создайте API ключи в разделе API Management');
    console.error('   4. Обновите BINANCE_API_KEY и BINANCE_API_SECRET в .env');
    process.exit(1);
  }
}

testBinanceTestnet();
