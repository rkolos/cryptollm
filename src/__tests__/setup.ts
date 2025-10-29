import { beforeAll } from 'vitest';
import { LoggingService } from '../services/LoggingService.js';
import { ConfigService } from '../services/ConfigService.js';

// Инициализация сервисов для всех тестов
beforeAll(() => {
  // Устанавливаем минимальные переменные окружения для тестов
  process.env.APP_MODE = 'dry_run';
  process.env.BINANCE_API_KEY = 'test_key';
  process.env.BINANCE_API_SECRET = 'test_secret';
  process.env.DB_HOST = 'localhost';
  process.env.DB_PORT = '5432';
  process.env.DB_USER = 'test_user';
  process.env.DB_PASSWORD = 'test_password';
  process.env.DB_NAME = 'test_db';
  process.env.WATCHLIST = 'BTC/USDT';
  process.env.STRATEGY_ROLE = 'test';
  process.env.STRATEGY_STYLE = 'test';
  process.env.RISK_DEFAULT_PERCENT = '1.0';
  process.env.RISK_MAX_PER_TRADE_PERCENT = '2.0';
  process.env.RISK_MAX_TOTAL_PORTFOLIO_PERCENT = '10.0';
  process.env.RISK_DESIRED_RR_RATIO = '2.0';

  // Загружаем конфигурацию и инициализируем логирование
  ConfigService.load();
  LoggingService.initialize();
});

