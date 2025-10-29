import { ConfigService } from './ConfigService.js';
import { DatabaseService } from './DatabaseService.js';
import { PairActorManagerService } from './PairActorManagerService.js';
import { LoggingService } from './LoggingService.js';
import type { IExchangeService, IDecimalOrder } from '../interfaces/IExchangeService.js';
import type winston from 'winston';

interface DbOrder {
  id: number;
  exchange_order_id: string;
  pair: string;
  type: string;
  side: 'buy' | 'sell';
  status: string;
  price: string;
  amount: string;
  created_at: Date;
}

interface DbPosition {
  id: number;
  pair: string;
  side: 'long' | 'short';
  amount: string;
  average_entry_price: string;
  total_fee_cost: string;
  stop_loss_price: string | null;
  created_at: Date;
}

export class SyncEngineService {
  private static instance: SyncEngineService | undefined;
  private readonly logger: winston.Logger;
  private readonly configService: ConfigService;
  private readonly databaseService: DatabaseService;
  private readonly exchangeService: IExchangeService;
  private readonly pairActorManager: PairActorManagerService;

  private constructor(
    configService: ConfigService,
    databaseService: DatabaseService,
    exchangeService: IExchangeService,
    pairActorManager: PairActorManagerService,
  ) {
    this.configService = configService;
    this.databaseService = databaseService;
    this.exchangeService = exchangeService;
    this.pairActorManager = pairActorManager;
    this.logger = LoggingService.getInstance().getLogger('SyncEngine');
    this.logger.info('SyncEngineService initialized.');
  }

  public static getInstance(
    configService: ConfigService,
    databaseService: DatabaseService,
    exchangeService: IExchangeService,
    pairActorManager: PairActorManagerService,
  ): SyncEngineService {
    if (!SyncEngineService.instance) {
      SyncEngineService.instance = new SyncEngineService(
        configService,
        databaseService,
        exchangeService,
        pairActorManager,
      );
    }
    return SyncEngineService.instance;
  }

  /**
   * Выполняет сверку для *всех* пар в watchlist.
   * Вызывается из SlowCycleService.
   */
  public async reconcileStateAll(): Promise<void> {
    const watchlist = this.configService.getWatchlist();
    this.logger.info(`Запуск плановой сверки для ${watchlist.length} пар...`);

    // Используем for...of для последовательного выполнения,
    // чтобы распределить нагрузку на API биржи во времени.
    for (const pair of watchlist) {
      await this.reconcileStateForPair(pair);
    }

    this.logger.info('Плановая сверка завершена.');
  }

  /**
   * Вызывает сверку состояния для пары
   * *внутри* защищенной очереди (актора).
   */
  public async reconcileStateForPair(pair: string): Promise<void> {
    this.logger.debug(`[${pair}] (SyncEngine) Задача на сверку [${pair}] добавлена в очередь...`);

    // (Критично - Задача 9.2) Оборачиваем всю логику в execute
    await this.pairActorManager.execute(pair, async () => {
      this.logger.info(`[${pair}] (SyncEngine) Сверка [${pair}] ЗАПУЩЕНА.`);

      // Получаем "сырые" данные о состоянии
      const [exchangeOrders, dbOrders, dbPositions] = await Promise.all([
        this.exchangeService.fetchOpenOrders(pair),
        this.databaseService.query('SELECT * FROM ActiveOrders WHERE pair = $1', [pair]),
        this.databaseService.query('SELECT * FROM ActivePositions WHERE pair = $1', [pair]),
      ]);

      // Вызываем заглушки, которые будут реализованы в 5.1.x

      // (STUB - Задача 5.1: Ордера-зомби / Исполненные офлайн)
      await this._reconcileOrders(
        pair,
        exchangeOrders, // Реальное состояние
        dbOrders.rows as unknown[] as DbOrder[], // Наше состояние
      );

      // (STUB - Задача 5.1.1: "Судебная" сверка)
      await this._reconcilePositionsForensic(
        pair,
        dbPositions.rows as unknown[] as DbPosition[], // Наши позиции
        dbOrders.rows as unknown[] as DbOrder[], // Наши ордера
      );

      // (STUB - Задача 5.1.2: Исполнение OPEN_LIMIT)
      await this._reconcileOpenLimitOrders(
        pair,
        exchangeOrders, // Реальное состояние
        dbOrders.rows as unknown[] as DbOrder[], // Наши ордера
      );

      this.logger.info(`[${pair}] (SyncEngine) Сверка [${pair}] ЗАВЕРШЕНА.`);
    });
  }

  // (STUB - Задача 5.1: Логика Сверки - Ордера)
  private async _reconcileOrders(
    pair: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _exchangeOrders: IDecimalOrder[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _dbOrders: DbOrder[],
  ): Promise<void> {
    this.logger.debug(`[${pair}] (STUB) _reconcileOrders...`);
    // Логика Сценариев 3 и 4 из `about.md` будет здесь
  }

  // (STUB - Задача 5.1.1: Логика Сверки - "Судебная" Сверка Позиций)
  private async _reconcilePositionsForensic(
    pair: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _dbPositions: DbPosition[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _dbOrders: DbOrder[],
  ): Promise<void> {
    this.logger.debug(`[${pair}] (STUB) _reconcilePositionsForensic...`);
    // Логика "судебной" сверки на основе TradeHistory будет здесь
  }

  // (STUB - Задача 5.1.2: Логика Сверки - Исполнение OPEN_LIMIT)
  private async _reconcileOpenLimitOrders(
    pair: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _exchangeOrders: IDecimalOrder[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _dbOrders: DbOrder[],
  ): Promise<void> {
    this.logger.debug(`[${pair}] (STUB) _reconcileOpenLimitOrders...`);
    // Логика обработки частично/полностью исполненных OPEN_LIMIT будет здесь
  }
}
