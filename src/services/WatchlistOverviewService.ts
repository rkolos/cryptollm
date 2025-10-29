import { ConfigService } from './ConfigService.js';
import { LoggingService } from './LoggingService.js';
import { MarketDataService } from './MarketDataService.js';
import { TAEngineService } from './TAEngineService.js';
import type { IExchangeService } from '../interfaces/IExchangeService.js';
import type { WatchlistOverviewItem, DecimalValue } from '../interfaces/ITATypes.js';
import type winston from 'winston';

export class WatchlistOverviewService {
  private static instance: WatchlistOverviewService | undefined;
  private readonly logger: winston.Logger;
  private readonly configService: ConfigService;
  private readonly exchangeService: IExchangeService;
  private readonly marketDataService: MarketDataService;
  private readonly taEngineService: TAEngineService;

  private constructor(
    configService: ConfigService,
    exchangeService: IExchangeService,
    marketDataService: MarketDataService,
    taEngineService: TAEngineService,
  ) {
    this.configService = configService;
    this.exchangeService = exchangeService;
    this.marketDataService = marketDataService;
    this.taEngineService = taEngineService;
    this.logger = LoggingService.getInstance().getLogger('WatchlistOverview');
    this.logger.info('WatchlistOverviewService initialized.');
  }

  public static getInstance(
    configService: ConfigService,
    exchangeService: IExchangeService,
    marketDataService: MarketDataService,
    taEngineService: TAEngineService,
  ): WatchlistOverviewService {
    if (!WatchlistOverviewService.instance) {
      WatchlistOverviewService.instance = new WatchlistOverviewService(
        configService,
        exchangeService,
        marketDataService,
        taEngineService,
      );
    }
    return WatchlistOverviewService.instance;
  }

  private async _fetchSinglePairOverview(pair: string): Promise<WatchlistOverviewItem> {
    try {
      // Параллельное получение ticker и OHLCV
      const [ticker, ohlcv] = await Promise.all([
        this.exchangeService.fetchTicker(pair),
        this.marketDataService.fetchOHLCV(pair, '1h', undefined, 50),
      ]);

      // Извлечение current_price
      const currentPrice = ticker.last || null;

      // Расчет RSI через TAEngineService
      let rsi1h: DecimalValue | null = null;
      if (ohlcv.length > 0) {
        const analysis = this.taEngineService.getAnalysis(ohlcv, []);
        rsi1h = analysis.rsi;
      }

      return {
        pair,
        current_price: currentPrice,
        rsi_1h: rsi1h,
      };
    } catch (error) {
      this.logger.warn(`Error fetching overview for pair ${pair}:`, error);
      return {
        pair,
        current_price: null,
        rsi_1h: null,
      };
    }
  }

  public async fetchWatchlistOverview(triggeredPair: string): Promise<WatchlistOverviewItem[]> {
    try {
      // Получение полного watchlist и фильтрация triggeredPair
      const watchlist = this.configService.getWatchlist();
      const pairsToProcess = watchlist.filter((pair) => pair !== triggeredPair);

      if (pairsToProcess.length === 0) {
        this.logger.debug(`No pairs to process for watchlist overview (triggeredPair: ${triggeredPair})`);
        return [];
      }

      this.logger.debug(`Fetching watchlist overview for ${pairsToProcess.length} pairs (excluding ${triggeredPair})`);

      // Параллельный сбор данных для всех пар с использованием Promise.allSettled
      const results = await Promise.allSettled(pairsToProcess.map((pair) => this._fetchSinglePairOverview(pair)));

      // Обработка результатов
      const overview: WatchlistOverviewItem[] = [];

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const pair = pairsToProcess[i];

        if (result.status === 'fulfilled') {
          overview.push(result.value);
        } else {
          this.logger.warn(`Failed to fetch overview for pair ${pair}:`, result.reason);
          overview.push({
            pair,
            current_price: null,
            rsi_1h: null,
          });
        }
      }

      this.logger.debug(`Watchlist overview completed: ${overview.length} items`);
      return overview;
    } catch (error) {
      this.logger.error('Fatal error in fetchWatchlistOverview:', error);
      return [];
    }
  }
}
