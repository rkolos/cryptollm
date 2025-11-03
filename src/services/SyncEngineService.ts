import { ConfigService } from './ConfigService.js';
import { DatabaseService } from './DatabaseService.js';
import { PairActorManagerService } from './PairActorManagerService.js';
import { LoggingService } from './LoggingService.js';
import { ExchangeRulesService } from './ExchangeRulesService.js';
import { GuaranteedOrderExecutionService } from './GuaranteedOrderExecutionService.js';
import { OrderNotFoundError } from '../errors/ExchangeErrors.js';
import Decimal from 'decimal.js';
import type { IExchangeService, IDecimalOrder, IDecimalBalance, DecimalValue } from '../interfaces/IExchangeService.js';
import type winston from 'winston';
import type { PoolClient } from 'pg';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DecimalConstructor = Decimal as any;

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
  target_stop_loss_price?: string | null;
  target_take_profit_price?: string | null;
  target_trailing_stop_json?: unknown | null;
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

interface DbTrade {
  id: number;
  timestamp: Date;
  exchange_trade_id: string;
  exchange_order_id: string;
  pair: string;
  side: 'buy' | 'sell';
  price: string;
  amount: string;
  fee_cost: string;
  fee_currency: string;
  realized_pnl_usd: string | null;
  created_at: Date;
}

interface ReconstructedPosition {
  side: 'long' | 'short';
  amount: DecimalValue;
  average_entry_price: DecimalValue;
  total_fee_cost: DecimalValue;
}

export class SyncEngineService {
  private static instance: SyncEngineService | undefined;
  private readonly logger: winston.Logger;
  private readonly configService: ConfigService;
  private readonly databaseService: DatabaseService;
  private readonly exchangeService: IExchangeService;
  private readonly pairActorManager: PairActorManagerService;
  private readonly exchangeRulesService: ExchangeRulesService;
  private readonly guaranteedOrderService: GuaranteedOrderExecutionService;

  private constructor(
    configService: ConfigService,
    databaseService: DatabaseService,
    exchangeService: IExchangeService,
    pairActorManager: PairActorManagerService,
    exchangeRulesService: ExchangeRulesService,
    guaranteedOrderService: GuaranteedOrderExecutionService,
  ) {
    this.configService = configService;
    this.databaseService = databaseService;
    this.exchangeService = exchangeService;
    this.pairActorManager = pairActorManager;
    this.exchangeRulesService = exchangeRulesService;
    this.guaranteedOrderService = guaranteedOrderService;
    this.logger = LoggingService.getInstance().getLogger('SyncEngine');
    this.logger.info('SyncEngineService initialized.');
  }

  public static getInstance(
    configService: ConfigService,
    databaseService: DatabaseService,
    exchangeService: IExchangeService,
    pairActorManager: PairActorManagerService,
    exchangeRulesService: ExchangeRulesService,
    guaranteedOrderService: GuaranteedOrderExecutionService,
  ): SyncEngineService {
    if (!SyncEngineService.instance) {
      SyncEngineService.instance = new SyncEngineService(
        configService,
        databaseService,
        exchangeService,
        pairActorManager,
        exchangeRulesService,
        guaranteedOrderService,
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
    // Добавляем таймаут для каждой пары, чтобы зависание одной пары не блокировало остальные
    for (const pair of watchlist) {
      // Добавляем задержку между парами, чтобы не перегружать API (500ms между парами)
      if (watchlist.indexOf(pair) > 0) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      try {
        // Таймаут 30 секунд на пару - если сверка зависла или ждет слишком долго, пропускаем
        const reconcilePromise = this.reconcileStateForPair(pair);
        const timeoutPromise = new Promise<void>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Таймаут сверки для пары ${pair} (30 секунд)`));
          }, 30000); // 30 секунд на пару
        });

        await Promise.race([reconcilePromise, timeoutPromise]);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('Таймаут')) {
          this.logger.warn(
            `[${pair}] Сверка для пары превысила таймаут (30 секунд). Возможно, очередь занята другой операцией. Продолжаем со следующей парой...`,
          );
        } else {
          this.logger.error(`[${pair}] Ошибка при сверке пары:`, error);
        }
        // Продолжаем выполнение для остальных пар
      }
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

      // Задача 5.1.1: "Судебная" сверка позиций
      await this._reconcilePositionsForensic(
        pair,
        dbPositions, // Наши позиции
        dbOrders, // Наши ордера
        exchangeBalance, // Баланс для проверки
      );

      // Задача 5.1.2: Исполнение OPEN_LIMIT ордеров
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
          await this.guaranteedOrderService.cancelOrderWithRetry(exchangeOrder.id, pair);
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

  // (Задача 5.1.1: Логика Сверки - "Судебная" Сверка Позиций)
  private async _reconcilePositionsForensic(
    pair: string,
    dbPositions: DbPosition[],
    _dbOrders: DbOrder[],
    exchangeBalance: IDecimalBalance,
  ): Promise<void> {
    // Условие запуска: баланс базового актива > 0 И позиции в БД нет
    const baseAsset = this.getBaseAsset(pair);
    const baseAssetBalance = exchangeBalance[baseAsset]?.total;

    if (!baseAssetBalance) {
      this.logger.debug(`[${pair}] Баланс базового актива ${baseAsset} не найден. Пропускаем судебную сверку.`);
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const balanceDecimal = baseAssetBalance as any as DecimalValue;
    const balanceValue = new DecimalConstructor(balanceDecimal.toString());

    if (!balanceValue.greaterThan(0) || dbPositions.length > 0) {
      this.logger.debug(
        `[${pair}] Условие для судебной сверки не выполнено: balance=${balanceValue}, dbPositions=${dbPositions.length}`,
      );
      return;
    }

    this.logger.info(
      `[${pair}] Запуск судебной сверки: баланс ${baseAsset}=${balanceValue}, позиций в БД=0. Восстанавливаем позицию...`,
    );

    // Вся логика восстановления в транзакции
    await this.databaseService.executeInTransaction(async (client) => {
      // Шаг 1: Сбор истории сделок
      const [exchangeTradesResult, dbTradesResult] = await Promise.all([
        this.exchangeService.fetchMyTrades(pair, undefined, 1000), // Получаем последние 1000 сделок
        client.query('SELECT * FROM TradeHistory WHERE pair = $1 ORDER BY timestamp ASC', [pair]),
      ]);

      const exchangeTrades = exchangeTradesResult;
      const dbTrades = dbTradesResult.rows as unknown[] as DbTrade[];

      // Шаг 2: Находим недостающие сделки
      const dbTradeIds = new Set(dbTrades.map((t) => t.exchange_trade_id));
      const missingTrades = exchangeTrades.filter((t) => !dbTradeIds.has(t.id));

      if (missingTrades.length > 0) {
        this.logger.info(
          `[${pair}] Обнаружено ${missingTrades.length} недостающих сделок. Вставляем в TradeHistory...`,
        );

        // Вставляем недостающие сделки
        for (const trade of missingTrades) {
          await client.query(
            `INSERT INTO TradeHistory (timestamp, exchange_trade_id, exchange_order_id, pair, side, price, amount, fee_cost, fee_currency, realized_pnl_usd)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (exchange_trade_id) DO NOTHING`,
            [
              new Date(trade.timestamp),
              trade.id,
              trade.order,
              trade.symbol,
              trade.side,
              trade.price.toString(),
              trade.amount.toString(),
              trade.fee.cost.toString(),
              trade.fee.currency,
              null, // realized_pnl_usd будет рассчитан позже
            ],
          );
        }
      }

      // Шаг 3: Реконструкция позиции из истории
      const reconstructedPosition = await this._reconstructPositionFromHistory(pair, client);

      if (!reconstructedPosition) {
        this.logger.info(
          `[${pair}] После реконструкции позиция закрыта (totalAmount <= 0). Восстановление не требуется.`,
        );
        return;
      }

      // Шаг 4: Вставляем восстановленную позицию
      this.logger.info(
        `[${pair}] Восстанавливаем позицию: side=${reconstructedPosition.side}, amount=${reconstructedPosition.amount}, avgPrice=${reconstructedPosition.average_entry_price}`,
      );

      await client.query(
        `INSERT INTO ActivePositions (pair, side, amount, average_entry_price, total_fee_cost, stop_loss_price)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (pair) DO UPDATE SET
           side = EXCLUDED.side,
           amount = EXCLUDED.amount,
           average_entry_price = EXCLUDED.average_entry_price,
           total_fee_cost = EXCLUDED.total_fee_cost,
           stop_loss_price = EXCLUDED.stop_loss_price`,
        [
          pair,
          reconstructedPosition.side,
          reconstructedPosition.amount.toString(),
          reconstructedPosition.average_entry_price.toString(),
          reconstructedPosition.total_fee_cost.toString(),
          null, // stop_loss_price = NULL для восстановленных позиций
        ],
      );

      this.logger.info(`[${pair}] Позиция успешно восстановлена в БД.`);
    });
  }

  /**
   * Вспомогательный метод для реконструкции позиции из истории сделок
   */
  private async _reconstructPositionFromHistory(
    pair: string,
    client: PoolClient,
  ): Promise<ReconstructedPosition | null> {
    const historyResult = await client.query('SELECT * FROM TradeHistory WHERE pair = $1 ORDER BY timestamp ASC', [
      pair,
    ]);

    const historyTrades = historyResult.rows as unknown[] as DbTrade[];

    if (historyTrades.length === 0) {
      return null;
    }

    // Используем decimal.js для точных расчетов
    let totalAmount = new DecimalConstructor(0);
    let totalCost = new DecimalConstructor(0);
    let totalFeeCost = new DecimalConstructor(0);

    // Определяем тип позиции по первой сделке
    const firstTrade = historyTrades[0];
    if (!firstTrade) {
      return null;
    }
    const isLongPosition = firstTrade.side === 'buy';

    for (const trade of historyTrades) {
      const amount = new DecimalConstructor(trade.amount);
      const price = new DecimalConstructor(trade.price);
      const feeCost = new DecimalConstructor(trade.fee_cost);

      if (isLongPosition) {
        // Для LONG позиций:
        // buy - открытие/увеличение позиции, добавляем amount и cost
        // sell - закрытие/уменьшение позиции, вычитаем amount и cost
        if (trade.side === 'buy') {
          totalAmount = totalAmount.plus(amount);
          totalCost = totalCost.plus(amount.mul(price));
        } else {
          // sell - уменьшаем позицию
          totalAmount = totalAmount.minus(amount);
          totalCost = totalCost.minus(amount.mul(price));
        }
      } else {
        // Для SHORT позиций:
        // sell - открытие/увеличение позиции (totalAmount становится отрицательным), добавляем cost
        // buy - закрытие/уменьшение позиции (totalAmount становится менее отрицательным), вычитаем cost
        if (trade.side === 'sell') {
          totalAmount = totalAmount.minus(amount); // SHORT: отрицательное значение
          totalCost = totalCost.plus(amount.mul(price)); // Добавляем cost при открытии SHORT
        } else {
          // buy - закрытие SHORT, уменьшаем отрицательное totalAmount
          totalAmount = totalAmount.plus(amount);
          totalCost = totalCost.minus(amount.mul(price)); // Вычитаем cost при закрытии SHORT
        }
      }

      totalFeeCost = totalFeeCost.plus(feeCost);
    }

    // Если позиция закрыта (totalAmount = 0 или противоположного знака), возвращаем null
    if (
      totalAmount.isZero() ||
      (isLongPosition && totalAmount.lessThanOrEqualTo(0)) ||
      (!isLongPosition && totalAmount.greaterThanOrEqualTo(0))
    ) {
      return null;
    }

    // Определяем сторону позиции
    const side: 'long' | 'short' = totalAmount.greaterThan(0) ? 'long' : 'short';

    // Рассчитываем среднюю цену входа
    // Для LONG: totalCost положительный, делим на положительный totalAmount
    // Для SHORT: totalCost положительный (накоплен при открытии), делим на абсолютное значение отрицательного totalAmount
    const averageEntryPrice = totalCost.abs().div(totalAmount.abs());

    return {
      side,
      amount: totalAmount.abs() as DecimalValue,
      average_entry_price: averageEntryPrice as DecimalValue,
      total_fee_cost: totalFeeCost as DecimalValue,
    };
  }

  /**
   * Извлекает базовый актив из торговой пары (e.g., 'BTC' из 'BTC/USDT')
   */
  private getBaseAsset(pair: string): string {
    const parts = pair.split('/');
    if (parts.length !== 2) {
      throw new Error(`Invalid pair format: ${pair}`);
    }
    const baseAsset = parts[0];
    if (!baseAsset || baseAsset.length === 0) {
      throw new Error(`Invalid pair format: ${pair}`);
    }
    return baseAsset;
  }

  // (Задача 5.1.2: Логика Сверки - Исполнение OPEN_LIMIT)
  private async _reconcileOpenLimitOrders(
    pair: string,
    exchangeOrders: IDecimalOrder[],
    dbOrders: DbOrder[],
  ): Promise<void> {
    // Поиск ордеров с type === 'limit_open' и status === 'open'
    const limitOpenOrders = dbOrders.filter((o) => o.type === 'limit_open' && o.status === 'open');

    if (limitOpenOrders.length === 0) {
      return;
    }

    // Создаем Set для быстрого поиска ордеров на бирже
    const exchangeOrderMap = new Map<string, IDecimalOrder>();
    for (const order of exchangeOrders) {
      exchangeOrderMap.set(order.id, order);
    }

    // Обрабатываем каждый limit_open ордер
    for (const dbOrder of limitOpenOrders) {
      const exchangeOrder = exchangeOrderMap.get(dbOrder.exchange_order_id);

      // Условие конвертации: ордера нет на бирже ИЛИ ордер есть, но status === 'closed' и filled > 0
      const shouldConvert =
        !exchangeOrder ||
        (exchangeOrder.status === 'closed' &&
          exchangeOrder.filled &&
          new DecimalConstructor(exchangeOrder.filled.toString()).greaterThan(0));

      if (!shouldConvert) {
        continue;
      }

      this.logger.info(
        `[${pair}] Обнаружен исполненный limit_open ордер [${dbOrder.exchange_order_id}]. Конвертируем в активную позицию...`,
      );

      try {
        // Шаг 1: Получение реальных деталей исполнения через fetchMyTrades
        const trades = await this.exchangeService.fetchMyTrades(pair, undefined, 100);
        const orderTrades = trades.filter((t) => t.order === dbOrder.exchange_order_id);

        if (orderTrades.length === 0) {
          this.logger.warn(
            `[${pair}] Не найдено сделок для ордера [${dbOrder.exchange_order_id}]. Пропускаем конвертацию.`,
          );
          continue;
        }

        // Рассчитываем реальные значения
        let realAmount = new DecimalConstructor(0);
        let realCost = new DecimalConstructor(0);
        let realFeeCost = new DecimalConstructor(0);
        let feeCurrency = 'USDT';

        for (const trade of orderTrades) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const amountDecimal = trade.amount as any;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const costDecimal = trade.cost as any;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const feeCostDecimal = (trade.fee?.cost as any) || new DecimalConstructor(0);

          realAmount = realAmount.plus(new DecimalConstructor(amountDecimal.toString()));
          realCost = realCost.plus(new DecimalConstructor(costDecimal.toString()));
          realFeeCost = realFeeCost.plus(new DecimalConstructor(feeCostDecimal.toString()));
          if (trade.fee?.currency) {
            feeCurrency = trade.fee.currency;
          }
        }

        // Проверка деления на ноль (защита от edge cases)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const realAmountAny = realAmount as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const zero = new DecimalConstructor(0);
        if (realAmountAny.isZero() || realAmountAny.eq(zero)) {
          this.logger.error(
            `[${pair}] КРИТИЧЕСКАЯ ОШИБКА: realAmount равен нулю при расчете realEntryPrice. Пропускаем ордер ${dbOrder.exchange_order_id}.`,
          );
          continue; // Пропускаем этот ордер
        }

        const realEntryPrice = realCost.div(realAmount);

        // Определяем сторону позиции
        const positionSide: 'long' | 'short' = dbOrder.side === 'buy' ? 'long' : 'short';
        const oppositeSide: 'buy' | 'sell' = dbOrder.side === 'buy' ? 'sell' : 'buy';

        // Шаг 2: Создание SL/TP ордеров ДО транзакции БД
        let slOrderId: string | null = null;
        let tpOrderId: string | null = null;

        if (dbOrder.target_stop_loss_price) {
          try {
            const slPrice = new DecimalConstructor(dbOrder.target_stop_loss_price);
            // Используем stop_loss_limit для защиты от проскальзывания
            const slOrder = await this.guaranteedOrderService.createOrderWithRetry(
              pair,
              'stop_loss_limit',
              oppositeSide,
              realAmount as DecimalValue,
              slPrice as DecimalValue,
              { stopPrice: slPrice.toString() },
            );
            slOrderId = slOrder.id;
            this.logger.info(`[${pair}] SL ордер [${slOrderId}] создан на бирже.`);
          } catch (error) {
            this.logger.error(`[${pair}] Ошибка при создании SL ордера:`, error);
            // Продолжаем без SL, но логируем критическую ошибку
          }
        }

        if (dbOrder.target_take_profit_price) {
          try {
            const tpPrice = new DecimalConstructor(dbOrder.target_take_profit_price);
            // TP - это обычный Limit ордер
            const tpOrder = await this.guaranteedOrderService.createOrderWithRetry(
              pair,
              'limit',
              oppositeSide,
              realAmount as DecimalValue,
              tpPrice as DecimalValue,
            );
            tpOrderId = tpOrder.id;
            this.logger.info(`[${pair}] TP ордер [${tpOrderId}] создан на бирже.`);
          } catch (error) {
            this.logger.error(`[${pair}] Ошибка при создании TP ордера:`, error);
            // Продолжаем без TP, но логируем критическую ошибку
          }
        }

        // Шаг 3: Атомарное обновление БД
        try {
          await this.databaseService.executeInTransaction(async (client) => {
            // 3.1. Удаляем старый limit_open ордер
            await client.query('DELETE FROM ActiveOrders WHERE exchange_order_id = $1', [dbOrder.exchange_order_id]);

            // 3.2. Вставляем новую ActivePosition
            await client.query(
              `INSERT INTO ActivePositions (pair, side, amount, average_entry_price, total_fee_cost, stop_loss_price)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (pair) DO UPDATE SET
                 side = EXCLUDED.side,
                 amount = EXCLUDED.amount,
                 average_entry_price = EXCLUDED.average_entry_price,
                 total_fee_cost = EXCLUDED.total_fee_cost,
                 stop_loss_price = EXCLUDED.stop_loss_price`,
              [
                pair,
                positionSide,
                realAmount.toString(),
                realEntryPrice.toString(),
                realFeeCost.toString(),
                dbOrder.target_stop_loss_price || null,
              ],
            );

            // 3.3. Вставляем SL ордер, если был создан
            if (slOrderId) {
              await client.query(
                `INSERT INTO ActiveOrders (exchange_order_id, pair, type, side, status, price, amount)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                  slOrderId,
                  pair,
                  'stop_loss_limit',
                  oppositeSide,
                  'open',
                  dbOrder.target_stop_loss_price,
                  realAmount.toString(),
                ],
              );
            }

            // 3.4. Вставляем TP ордер, если был создан
            if (tpOrderId) {
              await client.query(
                `INSERT INTO ActiveOrders (exchange_order_id, pair, type, side, status, price, amount)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                  tpOrderId,
                  pair,
                  'take_profit_limit',
                  oppositeSide,
                  'open',
                  dbOrder.target_take_profit_price,
                  realAmount.toString(),
                ],
              );
            }

            // 3.5. Вставляем все сделки в TradeHistory (не только последнюю)
            // Это важно для правильного расчета средней цены и учета частичного исполнения
            for (const trade of orderTrades) {
              const { randomUUID } = await import('crypto');
              const uniqueSuffix = randomUUID().substring(0, 8);
              const exchangeTradeId = `${trade.id}-${trade.timestamp}-${uniqueSuffix}`;

              await client.query(
                `INSERT INTO TradeHistory (timestamp, exchange_trade_id, exchange_order_id, pair, side, price, amount, fee_cost, fee_currency, realized_pnl_usd)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 ON CONFLICT (exchange_trade_id) DO NOTHING`,
                [
                  new Date(trade.timestamp),
                  exchangeTradeId,
                  dbOrder.exchange_order_id,
                  pair,
                  trade.side || dbOrder.side, // Используем side из сделки, если доступен
                  trade.price.toString(),
                  trade.amount.toString(),
                  trade.fee?.cost?.toString() || '0',
                  trade.fee?.currency || feeCurrency,
                  null, // realized_pnl_usd будет рассчитан позже
                ],
              );
            }

            // 3.6. Если был указан trailing_stop, создаем TSL_State
            if (dbOrder.target_trailing_stop_json && slOrderId) {
              const tslConfig = dbOrder.target_trailing_stop_json as { type: string; distance: number };
              await client.query(
                `INSERT INTO TSL_State (pair, current_stop_price, current_stop_order_id, price_seen, rule_config_json)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (pair) DO UPDATE SET
                   current_stop_price = EXCLUDED.current_stop_price,
                   current_stop_order_id = EXCLUDED.current_stop_order_id,
                   price_seen = EXCLUDED.price_seen,
                   rule_config_json = EXCLUDED.rule_config_json`,
                [pair, dbOrder.target_stop_loss_price, slOrderId, realEntryPrice.toString(), JSON.stringify(tslConfig)],
              );
            }
          });

          this.logger.info(`[${pair}] Конвертация limit_open ордера [${dbOrder.exchange_order_id}] завершена успешно.`);
        } catch (error) {
          // КРИТИЧЕСКИЙ сбой: транзакция провалилась, но SL/TP уже созданы на бирже
          // Отменяем их, чтобы избежать "зомби" ордеров
          this.logger.error(
            `[${pair}] КРИТИЧЕСКИЙ СБОЙ: Транзакция БД провалилась после создания SL/TP ордеров. Отменяем ордера...`,
            error,
          );

          const cancelPromises: Promise<void>[] = [];
          if (slOrderId) {
            cancelPromises.push(
              this.guaranteedOrderService.cancelOrderWithRetry(slOrderId, pair).catch((cancelError) => {
                this.logger.error(`[${pair}] Не удалось отменить SL ордер ${slOrderId}:`, cancelError);
              }),
            );
          }
          if (tpOrderId) {
            cancelPromises.push(
              this.guaranteedOrderService.cancelOrderWithRetry(tpOrderId, pair).catch((cancelError) => {
                this.logger.error(`[${pair}] Не удалось отменить TP ордер ${tpOrderId}:`, cancelError);
              }),
            );
          }

          await Promise.allSettled(cancelPromises);
          this.logger.warn(
            `[${pair}] SL/TP ордера отменены. Позиция открыта (limit_open исполнен), но не записана в БД. SyncEngine восстановит состояние при следующей сверке.`,
          );
          // Не пробрасываем ошибку дальше, чтобы не сломать SyncEngine
        }
      } catch (error) {
        this.logger.error(`[${pair}] Ошибка при обработке limit_open ордера [${dbOrder.exchange_order_id}]:`, error);
        // Продолжаем обработку других ордеров
      }
    }
  }
}
