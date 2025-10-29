import { ConfigService } from './ConfigService.js';
import { DatabaseService } from './DatabaseService.js';
import { PairActorManagerService } from './PairActorManagerService.js';
import { LoggingService } from './LoggingService.js';
import { OrderNotFoundError } from '../errors/ExchangeErrors.js';
import type { IExchangeService, IDecimalOrder, IDecimalBalance } from '../interfaces/IExchangeService.js';
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

      // Получаем "сырые" данные о состоянии параллельно через Promise.allSettled
      const results = await Promise.allSettled([
        this.exchangeService.fetchOpenOrders(pair),
        this.databaseService.query('SELECT * FROM ActiveOrders WHERE pair = $1', [pair]),
        this.databaseService.query('SELECT * FROM ActivePositions WHERE pair = $1', [pair]),
        this.exchangeService.fetchBalance(),
      ]);

      // Обработка ошибок: если любой запрос провалился, выходим
      if (results[0].status === 'rejected') {
        this.logger.error(`[${pair}] (SyncEngine) Ошибка при получении ордеров с биржи:`, results[0].reason);
        return;
      }
      if (results[1].status === 'rejected') {
        this.logger.error(`[${pair}] (SyncEngine) Ошибка при получении ордеров из БД:`, results[1].reason);
        return;
      }
      if (results[2].status === 'rejected') {
        this.logger.error(`[${pair}] (SyncEngine) Ошибка при получении позиций из БД:`, results[2].reason);
        return;
      }
      if (results[3].status === 'rejected') {
        this.logger.error(`[${pair}] (SyncEngine) Ошибка при получении баланса:`, results[3].reason);
        return;
      }

      const exchangeOrders = results[0].value as IDecimalOrder[];
      const dbOrders = results[1].value.rows as unknown[] as DbOrder[];
      const dbPositions = results[2].value.rows as unknown[] as DbPosition[];
      const exchangeBalance = results[3].value as IDecimalBalance;

      // Вызываем логику сверки в строгой последовательности

      // (Задача 5.1: Ордера-зомби / Исполненные офлайн)
      await this._reconcileOrders(
        pair,
        exchangeOrders, // Реальное состояние
        dbOrders, // Наше состояние
      );

      // (STUB - Задача 5.1.1: "Судебная" сверка)
      await this._reconcilePositionsForensic(
        pair,
        dbPositions, // Наши позиции
        dbOrders, // Наши ордера
        exchangeBalance, // Баланс для проверки
      );

      // (STUB - Задача 5.1.2: Исполнение OPEN_LIMIT)
      await this._reconcileOpenLimitOrders(
        pair,
        exchangeOrders, // Реальное состояние
        dbOrders, // Наши ордера
      );

      this.logger.info(`[${pair}] (SyncEngine) Сверка [${pair}] ЗАВЕРШЕНА.`);
    });
  }

  // (Задача 5.1: Логика Сверки - Ордера)
  private async _reconcileOrders(pair: string, exchangeOrders: IDecimalOrder[], dbOrders: DbOrder[]): Promise<void> {
    this.logger.debug(`[${pair}] Запуск сверки ордеров...`);

    // Создаем Set для быстрого поиска
    const dbOrderIds = new Set(dbOrders.map((o) => o.exchange_order_id));
    const exchangeOrderIds = new Set(exchangeOrders.map((o) => o.id));

    // Сценарий 3 ("Зомби"): Ордера на бирже есть, но нет в БД
    for (const exchangeOrder of exchangeOrders) {
      if (!dbOrderIds.has(exchangeOrder.id)) {
        this.logger.warn(`[${pair}] Обнаружен ордер-зомби [${exchangeOrder.id}] по [${pair}]! Немедленно отменяем...`);
        try {
          await this.exchangeService.cancelOrder(exchangeOrder.id, pair);
          this.logger.info(`[${pair}] Ордер-зомби [${exchangeOrder.id}] успешно отменен.`);
        } catch (error) {
          // Если ордер уже не существует (OrderNotFoundError), это нормально
          if (error instanceof OrderNotFoundError) {
            this.logger.debug(`[${pair}] Ордер [${exchangeOrder.id}] уже не существует на бирже.`);
          } else {
            this.logger.error(`[${pair}] Ошибка при отмене ордера-зомби [${exchangeOrder.id}]:`, error);
            // Продолжаем обработку других ордеров
          }
        }
      }
    }

    // Сценарий 4 ("Призраки"): Ордера в БД есть, но нет на бирже
    const ghostOrders = dbOrders.filter((dbOrder) => !exchangeOrderIds.has(dbOrder.exchange_order_id));
    if (ghostOrders.length > 0) {
      this.logger.info(
        `[${pair}] Обнаружено ${ghostOrders.length} ордеров-призраков. Выполняем атомарную очистку БД...`,
      );

      // Атомарно удаляем призраки из ActiveOrders и TSL_State
      await this.databaseService.executeInTransaction(async (client) => {
        for (const ghostOrder of ghostOrders) {
          this.logger.info(`[${pair}] Ордер [${ghostOrder.exchange_order_id}] исполнился офлайн. Удаляем из БД...`);

          // Удаляем из ActiveOrders
          await client.query('DELETE FROM ActiveOrders WHERE exchange_order_id = $1', [ghostOrder.exchange_order_id]);

          // Удаляем связанный TSL, если он был
          await client.query('DELETE FROM TSL_State WHERE current_stop_order_id = $1', [ghostOrder.exchange_order_id]);
        }
      });

      this.logger.info(`[${pair}] Атомарная очистка ордеров-призраков завершена.`);
    }
  }

  // (STUB - Задача 5.1.1: Логика Сверки - "Судебная" Сверка Позиций)
  private async _reconcilePositionsForensic(
    pair: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _dbPositions: DbPosition[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _dbOrders: DbOrder[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _exchangeBalance: IDecimalBalance,
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
