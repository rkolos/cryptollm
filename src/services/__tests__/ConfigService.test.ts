import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ConfigService } from '../ConfigService.js';

describe('ConfigService', () => {
  const originalEnv = process.env;
  const originalExit = process.exit;

  beforeEach(() => {
    vi.clearAllMocks();
    // Очищаем instance для каждого теста
    (ConfigService as any).instance = undefined;
    process.env = { ...originalEnv };
    process.exit = vi.fn() as any;
  });

  afterEach(() => {
    process.env = originalEnv;
    process.exit = originalExit;
  });

  describe('load', () => {
    it('должен успешно загрузить валидную конфигурацию', () => {
      process.env = {
        APP_MODE: 'dry_run',
        BINANCE_API_KEY: 'test_key',
        BINANCE_API_SECRET: 'test_secret',
        DB_HOST: 'localhost',
        DB_PORT: '5432',
        DB_USER: 'test_user',
        DB_PASSWORD: 'test_password',
        DB_NAME: 'test_db',
        WATCHLIST: 'BTC/USDT,ETH/USDT',
        STRATEGY_ROLE: 'conservative',
        STRATEGY_STYLE: 'scalping',
        RISK_DEFAULT_PERCENT: '1.0',
        RISK_MAX_PER_TRADE_PERCENT: '2.0',
        RISK_MAX_TOTAL_PORTFOLIO_PERCENT: '10.0',
        RISK_DESIRED_RR_RATIO: '2.0',
      };

      ConfigService.load();
      const instance = ConfigService.getInstance();

      expect(instance).toBeDefined();
      expect(instance.getAppMode()).toBe('dry_run');
      expect(instance.getWatchlist()).toEqual(['BTC/USDT', 'ETH/USDT']);
    });

    it('должен завершить процесс при невалидной конфигурации', () => {
      process.env = {
        APP_MODE: 'invalid_mode', // Невалидное значение
        BINANCE_API_KEY: 'test_key',
        BINANCE_API_SECRET: 'test_secret',
        DB_HOST: 'localhost',
        DB_PORT: '5432',
        DB_USER: 'test_user',
        DB_PASSWORD: 'test_password',
        DB_NAME: 'test_db',
        WATCHLIST: 'BTC/USDT',
        STRATEGY_ROLE: 'conservative',
        STRATEGY_STYLE: 'scalping',
        RISK_DEFAULT_PERCENT: '1.0',
        RISK_MAX_PER_TRADE_PERCENT: '2.0',
        RISK_MAX_TOTAL_PORTFOLIO_PERCENT: '10.0',
        RISK_DESIRED_RR_RATIO: '2.0',
      };

      ConfigService.load();

      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('должен завершить процесс при отсутствии обязательных полей', () => {
      process.env = {
        APP_MODE: 'dry_run',
        // Отсутствуют обязательные поля
      };

      ConfigService.load();

      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });

  describe('getInstance', () => {
    it('должен выбросить ошибку если конфигурация не загружена', () => {
      (ConfigService as any).instance = undefined;

      expect(() => {
        ConfigService.getInstance();
      }).toThrow();
    });
  });

  describe('getters', () => {
    beforeEach(() => {
      process.env = {
        APP_MODE: 'testnet',
        BINANCE_API_KEY: 'test_key',
        BINANCE_API_SECRET: 'test_secret',
        DB_HOST: 'localhost',
        DB_PORT: '5432',
        DB_USER: 'test_user',
        DB_PASSWORD: 'test_password',
        DB_NAME: 'test_db',
        WATCHLIST: 'BTC/USDT,ETH/USDT',
        LLM_API_URL: 'https://api.example.com',
        LLM_API_KEY: 'llm_key',
        LLM_MODEL_NAME: 'gpt-4',
        TELEGRAM_BOT_TOKEN: 'telegram_token',
        TELEGRAM_CHAT_ID: '123456',
        STRATEGY_ROLE: 'aggressive',
        STRATEGY_STYLE: 'swing',
        RISK_DEFAULT_PERCENT: '1.5',
        RISK_MAX_PER_TRADE_PERCENT: '3.0',
        RISK_MAX_TOTAL_PORTFOLIO_PERCENT: '15.0',
        RISK_DESIRED_RR_RATIO: '2.5',
        DRY_RUN_INITIAL_USDT: '5000',
      };

      ConfigService.load();
    });

    it('должен вернуть правильный APP_MODE', () => {
      const instance = ConfigService.getInstance();
      expect(instance.getAppMode()).toBe('testnet');
    });

    it('должен вернуть правильный watchlist', () => {
      const instance = ConfigService.getInstance();
      expect(instance.getWatchlist()).toEqual(['BTC/USDT', 'ETH/USDT']);
    });

    it('должен вернуть правильную конфигурацию БД', () => {
      const instance = ConfigService.getInstance();
      const dbConfig = instance.getDbConfig();

      expect(dbConfig.host).toBe('localhost');
      expect(dbConfig.port).toBe(5432);
      expect(dbConfig.user).toBe('test_user');
      expect(dbConfig.password).toBe('test_password');
      expect(dbConfig.database).toBe('test_db');
    });

    it('должен вернуть правильную конфигурацию LLM', () => {
      const instance = ConfigService.getInstance();
      const llmConfig = instance.getLlmConfig();

      expect(llmConfig.apiUrl).toBe('https://api.example.com');
      expect(llmConfig.apiKey).toBe('llm_key');
      expect(llmConfig.modelName).toBe('gpt-4');
    });

    it('должен вернуть правильную конфигурацию Telegram', () => {
      const instance = ConfigService.getInstance();
      const telegramConfig = instance.getTelegramConfig();

      expect(telegramConfig.botToken).toBe('telegram_token');
      expect(telegramConfig.chatId).toBe('123456');
    });

    it('должен вернуть правильные правила риска', () => {
      const instance = ConfigService.getInstance();
      const riskRules = instance.getRiskRules();

      expect(riskRules.defaultRiskPercent).toBe(1.5);
      expect(riskRules.maxAllowedRiskPercent).toBe(3.0);
      expect(riskRules.maxTotalPortfolioRiskPercent).toBe(15.0);
      expect(riskRules.desiredRiskRewardRatio).toBe(2.5);
    });

    it('должен вернуть правильный баланс для dry_run', () => {
      const instance = ConfigService.getInstance();
      const balance = instance.getDryRunInitialBalance();

      expect(balance).toBe(5000);
    });
  });
});

