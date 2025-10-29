import Decimal from 'decimal.js';
import { LoggingService } from './LoggingService.js';
import type {
  IExchangeService,
  IDecimalOHLCV,
  IDecimalOrderBook,
  IDecimalTrade,
} from '../interfaces/IExchangeService.js';
import type { AggregatedOrderBook, RecentTrade, DetailedMarketData, DecimalValue } from '../interfaces/ITATypes.js';
import type winston from 'winston';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DecimalConstructor = Decimal as any;

export class MarketDataService {
  private static instance: MarketDataService | undefined;
  private readonly logger: winston.Logger;
  private readonly exchangeService: IExchangeService;

  private constructor(exchangeService: IExchangeService) {
    this.exchangeService = exchangeService;
    this.logger = LoggingService.getInstance().getLogger('MarketData');
    this.logger.info('MarketDataService initialized.');
  }

  public static getInstance(exchangeService: IExchangeService): MarketDataService {
    if (!MarketDataService.instance) {
      MarketDataService.instance = new MarketDataService(exchangeService);
    }
    return MarketDataService.instance;
  }

  private toDecimal(value: number | string | DecimalValue | null | undefined): DecimalValue | null {
    if (value === null || value === undefined) {
      return null;
    }
    // Проверяем, является ли уже DecimalValue (имеет метод toNumber)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof value === 'object' && (value as any).toNumber) {
      return value as DecimalValue;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return new DecimalConstructor(String(value)) as DecimalValue;
    } catch {
      return null;
    }
  }

  public async fetchOHLCV(pair: string, timeframe: string, since?: number, limit?: number): Promise<IDecimalOHLCV[]> {
    try {
      return await this.exchangeService.fetchOHLCV(pair, timeframe, since, limit);
    } catch (error) {
      this.logger.error(`Error fetching OHLCV for ${pair}:`, error);
      return [];
    }
  }

  public async fetchRecentTrades(pair: string, limit: number = 50): Promise<RecentTrade[]> {
    try {
      const trades = await this.exchangeService.fetchMyTrades(pair, undefined, limit);
      return trades.map((trade) => ({
        timestamp: trade.timestamp,
        price: trade.price,
        amount: trade.amount,
        side: trade.side,
      }));
    } catch (error) {
      this.logger.error(`Error fetching recent trades for ${pair}:`, error);
      return [];
    }
  }

  public async fetchAggregatedOrderBook(pair: string, depth: number = 100): Promise<AggregatedOrderBook | null> {
    try {
      const orderBook = await this.exchangeService.fetchOrderBook(pair, depth);

      if (!orderBook.bids || orderBook.bids.length === 0 || !orderBook.asks || orderBook.asks.length === 0) {
        this.logger.warn(`Empty order book for ${pair}`);
        return {
          best_bid: null,
          best_ask: null,
          spread: null,
          aggregated_bid_volume_0_5_percent: null,
          aggregated_ask_volume_0_5_percent: null,
        };
      }

      // Получаем лучшие цены
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bestBid = orderBook.bids[0]?.[0] as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bestAsk = orderBook.asks[0]?.[0] as any;

      if (!bestBid || !bestAsk) {
        this.logger.warn(`Invalid best bid/ask for ${pair}`);
        return {
          best_bid: null,
          best_ask: null,
          spread: null,
          aggregated_bid_volume_0_5_percent: null,
          aggregated_ask_volume_0_5_percent: null,
        };
      }

      // Определение лимитов: bid_limit = best_bid * 0.995, ask_limit = best_ask * 1.005
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bidLimitPrice = bestBid.mul(new DecimalConstructor(0.995)) as DecimalValue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const askLimitPrice = bestAsk.mul(new DecimalConstructor(1.005)) as DecimalValue;

      // Агрегация объемов bids (price >= bid_limit_price)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let aggregatedBidVolume = new DecimalConstructor(0) as any;
      for (const bid of orderBook.bids) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const price = bid[0] as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const amount = bid[1] as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (price.gte(bidLimitPrice)) {
          aggregatedBidVolume = aggregatedBidVolume.plus(amount);
        } else {
          break; // Bids отсортированы по убыванию, дальше уже не подходят
        }
      }

      // Агрегация объемов asks (price <= ask_limit_price)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let aggregatedAskVolume = new DecimalConstructor(0) as any;
      for (const ask of orderBook.asks) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const price = ask[0] as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const amount = ask[1] as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (price.lte(askLimitPrice)) {
          aggregatedAskVolume = aggregatedAskVolume.plus(amount);
        } else {
          break; // Asks отсортированы по возрастанию, дальше уже не подходят
        }
      }

      // Расчет спреда
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const spread = bestAsk.sub(bestBid) as DecimalValue;

      return {
        best_bid: bestBid as DecimalValue,
        best_ask: bestAsk as DecimalValue,
        spread: spread,
        aggregated_bid_volume_0_5_percent: aggregatedBidVolume as DecimalValue,
        aggregated_ask_volume_0_5_percent: aggregatedAskVolume as DecimalValue,
      };
    } catch (error) {
      this.logger.error(`Error fetching aggregated order book for ${pair}:`, error);
      return {
        best_bid: null,
        best_ask: null,
        spread: null,
        aggregated_bid_volume_0_5_percent: null,
        aggregated_ask_volume_0_5_percent: null,
      };
    }
  }

  public async fetchDetailedMarketData(
    pair: string,
    timeframe: string,
    ohlcvLimit?: number,
    tradesLimit: number = 50,
  ): Promise<DetailedMarketData> {
    try {
      // Параллельный сбор данных через Promise.all
      const [ohlcv, orderBook, recentTrades] = await Promise.all([
        this.fetchOHLCV(pair, timeframe, undefined, ohlcvLimit),
        this.fetchAggregatedOrderBook(pair, 100),
        this.fetchRecentTrades(pair, tradesLimit),
      ]);

      return {
        ohlcv,
        orderBook,
        recentTrades,
      };
    } catch (error) {
      this.logger.error(`Error fetching detailed market data for ${pair}:`, error);
      // Возвращаем отказоустойчивую структуру
      return {
        ohlcv: [],
        orderBook: null,
        recentTrades: [],
      };
    }
  }
}
