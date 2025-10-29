import Decimal from 'decimal.js';
import { ConfigService } from './ConfigService.js';
import { LoggingService } from './LoggingService.js';
import type { IExchangeService } from '../interfaces/IExchangeService.js';
import type { IMarketRules } from '../interfaces/IMarketRules.js';
import type winston from 'winston';

export class ExchangeRulesService {
  private static instance: ExchangeRulesService | undefined;
  private readonly rulesCache: Map<string, IMarketRules> = new Map();
  private readonly logger: winston.Logger;

  private constructor() {
    this.logger = LoggingService.getInstance().getLogger('ExchangeRules');
  }

  public static async initialize(exchangeService: IExchangeService, configService: ConfigService): Promise<void> {
    if (ExchangeRulesService.instance) {
      throw new Error('ExchangeRulesService has already been initialized.');
    }

    const logger = LoggingService.getInstance().getLogger('ExchangeRules');
    logger.info('Initializing ExchangeRulesService...');

    await exchangeService.loadMarkets();
    const rawMarkets = exchangeService.getRawMarkets();
    const watchlist = configService.getWatchlist();

    for (const pair of watchlist) {
      const market = rawMarkets[pair] as Record<string, unknown> | undefined;

      if (!market) {
        logger.error(`FATAL: Pair ${pair} not found in exchange markets.`);
        process.exit(1);
      }

      try {
        const rules = ExchangeRulesService.parseMarketRules(market);
        ExchangeRulesService.instance = ExchangeRulesService.instance || new ExchangeRulesService();
        ExchangeRulesService.instance.rulesCache.set(pair, rules);
        logger.debug(`Rules loaded for ${pair}: minNotional=${rules.minNotional}, takerFee=${rules.takerFee}`);
      } catch (error) {
        logger.error(`Failed to parse rules for ${pair}:`, error);
        process.exit(1);
      }
    }

    logger.info(`ExchangeRulesService initialized. Loaded rules for ${watchlist.length} pairs.`);
  }

  private static parseMarketRules(market: Record<string, unknown>): IMarketRules {
    const limits = (market.limits as Record<string, unknown>) || {};
    const cost = (limits.cost as Record<string, unknown>) || {};
    const fees = (market.fees as Record<string, unknown>) || {};
    const taker = (fees.taker as number | string | undefined) ?? 0.001;
    const precision = (market.precision as Record<string, unknown>) || {};

    const minNotional = cost.min !== undefined && cost.min !== null ? new Decimal(String(cost.min)) : new Decimal(10);

    const takerFeeValue = new Decimal(String(taker));

    const amountPrecision =
      precision.amount !== undefined && precision.amount !== null
        ? new Decimal(String(precision.amount))
        : new Decimal('0.00000001');

    const pricePrecision =
      precision.price !== undefined && precision.price !== null
        ? new Decimal(String(precision.price))
        : new Decimal('0.01');

    return {
      minNotional,
      takerFee: takerFeeValue,
      precision: {
        amount: amountPrecision,
        price: pricePrecision,
      },
    };
  }

  public static getInstance(): ExchangeRulesService {
    if (!ExchangeRulesService.instance) {
      throw new Error('ExchangeRulesService has not been initialized. Call initialize() first.');
    }
    return ExchangeRulesService.instance;
  }

  public getRules(pair: string): IMarketRules {
    const rules = this.rulesCache.get(pair);
    if (!rules) {
      throw new Error(`Rules not found for pair: ${pair}. Make sure the pair is in watchlist.`);
    }
    return rules;
  }
}
