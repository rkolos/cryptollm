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
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  STRATEGY_ROLE: z.string().min(1),
  STRATEGY_STYLE: z.string().min(1),
  RISK_DEFAULT_PERCENT: z.coerce.number().positive(),
  RISK_MAX_PER_TRADE_PERCENT: z.coerce.number().positive(),
  RISK_MAX_TOTAL_PORTFOLIO_PERCENT: z.coerce.number().positive(),
  RISK_DESIRED_RR_RATIO: z.coerce.number().positive(),
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
    };
  }

  public getTelegramConfig() {
    return {
      botToken: this.config.TELEGRAM_BOT_TOKEN,
      chatId: this.config.TELEGRAM_CHAT_ID,
    };
  }

  public getStrategyContext() {
    return {
      role: this.config.STRATEGY_ROLE,
      style: this.config.STRATEGY_STYLE,
    };
  }

  public getRiskRules() {
    return {
      defaultRiskPercent: this.config.RISK_DEFAULT_PERCENT,
      maxAllowedRiskPercent: this.config.RISK_MAX_PER_TRADE_PERCENT,
      maxTotalPortfolioRiskPercent: this.config.RISK_MAX_TOTAL_PORTFOLIO_PERCENT,
      desiredRiskRewardRatio: this.config.RISK_DESIRED_RR_RATIO,
    };
  }
}
