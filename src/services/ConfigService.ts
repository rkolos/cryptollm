import { z } from 'zod';
import dotenv from 'dotenv';

const configSchema = z.object({
  APP_MODE: z.enum(['production', 'testnet', 'dry_run']),
  BINANCE_API_KEY: z.string().min(1),
  BINANCE_API_SECRET: z.string().min(1),
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive(),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().min(1),
  WATCHLIST: z.string().min(1),
  LLM_API_URL: z.string().url().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL_NAME: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  STRATEGY_ROLE: z.string().min(1),
  STRATEGY_STYLE: z.string().min(1),
  STRATEGY_CONTEXT: z.string().optional(),
  RISK_RULES: z.string().optional(),
  RISK_DEFAULT_PERCENT: z.coerce.number().positive(),
  RISK_MAX_PER_TRADE_PERCENT: z.coerce.number().positive(),
  RISK_MAX_TOTAL_PORTFOLIO_PERCENT: z.coerce.number().positive(),
  RISK_DESIRED_RR_RATIO: z.coerce.number().positive(),
  DRY_RUN_INITIAL_USDT: z.coerce.number().positive().optional(),
  WORKER_LOCAL_EXECUTION_BALANCE_PERCENT: z.coerce.number().min(0).max(1).optional(),
});

type AppConfig = z.infer<typeof configSchema>;

export class ConfigService {
  private static instance: ConfigService | undefined;
  private readonly config: AppConfig;

  private constructor(config: AppConfig) {
    this.config = config;
  }

  public static load(): void {
    dotenv.config();

    try {
      const parsedConfig = configSchema.parse(process.env);
      ConfigService.instance = new ConfigService(parsedConfig);
      console.log('Config loaded and validated successfully.');
    } catch (error) {
      if (error instanceof z.ZodError) {
        console.error('Failed to validate .env configuration:');
        error.issues.forEach((issue) => {
          const path = issue.path.length > 0 ? issue.path.join('.') : 'root';
          console.error(`  - ${path}: ${issue.message}`);
        });
      } else {
        console.error('An unexpected error occurred during config load:', error);
      }
      process.exit(1);
    }
  }

  public static getInstance(): ConfigService {
    if (!ConfigService.instance) {
      throw new Error('ConfigService must be loaded before use (call load())');
    }
    return ConfigService.instance;
  }

  public getAppMode(): AppConfig['APP_MODE'] {
    return this.config.APP_MODE;
  }

  public getBinanceConfig() {
    return {
      apiKey: this.config.BINANCE_API_KEY,
      secret: this.config.BINANCE_API_SECRET,
    };
  }

  public getDbConfig() {
    return {
      host: this.config.DB_HOST,
      port: this.config.DB_PORT,
      user: this.config.DB_USER,
      password: this.config.DB_PASSWORD,
      database: this.config.DB_NAME,
    };
  }

  public getWatchlist(): string[] {
    return this.config.WATCHLIST.split(',')
      .map((pair) => pair.trim())
      .filter((pair) => pair.length > 0);
  }

  public getLlmConfig() {
    return {
      apiUrl: this.config.LLM_API_URL,
      apiKey: this.config.LLM_API_KEY,
      modelName: this.config.LLM_MODEL_NAME,
    };
  }

  public getTelegramConfig() {
    return {
      botToken: this.config.TELEGRAM_BOT_TOKEN,
      chatId: this.config.TELEGRAM_CHAT_ID,
    };
  }

  public getStrategyContext() {
    // Для демо-счетов используем максимально агрессивный профиль
    const isDemoAccount = this.config.APP_MODE === 'testnet' || this.config.APP_MODE === 'dry_run';

    if (isDemoAccount) {
      return {
        role: 'aggressive_trader',
        style: 'high_frequency_swing',
      };
    }

    // Если задана STRATEGY_CONTEXT как JSON, используем её
    if (this.config.STRATEGY_CONTEXT) {
      try {
        const strategyContext = JSON.parse(this.config.STRATEGY_CONTEXT);
        return strategyContext;
      } catch (error) {
        console.warn('Failed to parse STRATEGY_CONTEXT JSON, falling back to legacy format:', error);
      }
    }

    // Fallback к legacy формату
    return {
      role: this.config.STRATEGY_ROLE,
      style: this.config.STRATEGY_STYLE,
    };
  }

  public getRiskRules() {
    // Для демо-счетов (testnet/dry_run) используем максимально агрессивные настройки
    const isDemoAccount = this.config.APP_MODE === 'testnet' || this.config.APP_MODE === 'dry_run';

    if (isDemoAccount) {
      // Максимально агрессивные настройки для быстрого тестирования
      return {
        defaultRiskPercent: 20.0, // Высокий дефолтный риск
        maxAllowedRiskPercent: 50.0, // Можно рисковать половиной портфеля на одной сделке
        maxTotalPortfolioRiskPercent: 100.0, // Можно рисковать всем портфелем
        desiredRiskRewardRatio: 1.0, // Даже 1:1 приемлемо для агрессивной торговли
      };
    }

    // Если задана RISK_RULES как JSON, используем её
    if (this.config.RISK_RULES) {
      try {
        const riskRules = JSON.parse(this.config.RISK_RULES);
        return {
          defaultRiskPercent: riskRules.default_risk_per_trade_percent,
          maxAllowedRiskPercent: riskRules.max_allowed_risk_per_trade_percent,
          maxTotalPortfolioRiskPercent: riskRules.max_total_portfolio_risk_percent,
          desiredRiskRewardRatio: riskRules.desired_risk_reward_ratio,
        };
      } catch (error) {
        console.warn('Failed to parse RISK_RULES JSON, falling back to legacy format:', error);
      }
    }

    // Для production используем значения из конфигурации
    return {
      defaultRiskPercent: this.config.RISK_DEFAULT_PERCENT,
      maxAllowedRiskPercent: this.config.RISK_MAX_PER_TRADE_PERCENT,
      maxTotalPortfolioRiskPercent: this.config.RISK_MAX_TOTAL_PORTFOLIO_PERCENT,
      desiredRiskRewardRatio: this.config.RISK_DESIRED_RR_RATIO,
    };
  }

  public getDryRunInitialBalance(): number {
    return this.config.DRY_RUN_INITIAL_USDT ?? 10000;
  }

  public getSlowCycleIntervalMs(): number {
    // Дефолтное значение 10 минут (600000 мс)
    // Уменьшено частоты проверки триггеров для снижения нагрузки на API
    return 600000;
  }

  public getLocalExecutionBalancePercent(): number {
    // Дефолтное значение 10% (0.10) от доступного баланса для локального выполнения
    // Используется когда валидатор отклоняет решение из-за превышения баланса
    return this.config.WORKER_LOCAL_EXECUTION_BALANCE_PERCENT ?? 0.1;
  }

  /**
   * Получить дефолтный интервал для fallback timeout триггера (в минутах)
   * Используется когда модель не установила триггеры (пустой массив)
   */
  public getDefaultTriggerTimeoutMinutes(): number {
    // Дефолтное значение: 30 минут
    // Это гарантирует, что пара будет проверена через разумный промежуток времени
    return 30;
  }
}
