import Decimal from 'decimal.js';
import { LoggingService } from './LoggingService.js';
import { AccountStateService } from './AccountStateService.js';
import { PairActorManagerService } from './PairActorManagerService.js';
import { GuaranteedOrderExecutionService } from './GuaranteedOrderExecutionService.js';
import { DatabaseService } from './DatabaseService.js';
import type { IDecimalTicker, DecimalValue } from '../interfaces/IExchangeService.js';
import type { TSLRule } from '../interfaces/IValidatorTypes.js';
import type winston from 'winston';
import type { PoolClient } from 'pg';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DecimalConstructor = Decimal as any;

interface TSLUpdateResult {
  newStopPrice: DecimalValue;
  newPriceSeen: DecimalValue;
}

export class TSLHandlerService {
  private static instance: TSLHandlerService | undefined;
  private readonly logger: winston.Logger;
  private readonly accountStateService: AccountStateService;
  private readonly pairActorManager: PairActorManagerService;
  private readonly guaranteedExecutor: GuaranteedOrderExecutionService;
  private readonly databaseService: DatabaseService;

  private constructor(
    accountStateService: AccountStateService,
    pairActorManager: PairActorManagerService,
    guaranteedExecutor: GuaranteedOrderExecutionService,
    databaseService: DatabaseService,
  ) {
    this.accountStateService = accountStateService;
    this.pairActorManager = pairActorManager;
    this.guaranteedExecutor = guaranteedExecutor;
    this.databaseService = databaseService;
    this.logger = LoggingService.getInstance().getLogger('TSLHandler');
    this.logger.info('TSLHandlerService initialized.');
  }

  public static getInstance(
    accountStateService: AccountStateService,
    pairActorManager: PairActorManagerService,
    guaranteedExecutor: GuaranteedOrderExecutionService,
    databaseService: DatabaseService,
  ): TSLHandlerService {
    if (!TSLHandlerService.instance) {
      TSLHandlerService.instance = new TSLHandlerService(
        accountStateService,
        pairActorManager,
        guaranteedExecutor,
        databaseService,
      );
    }
    return TSLHandlerService.instance;
  }

  /**
   * Обработчик тика (вызывается на каждый обновленный тикер)
   * КРИТИЧНО: Метод НЕ async и НЕ содержит await верхнего уровня
   */
  public handleTicker(ticker: IDecimalTicker): void {
    try {
      const pair = ticker.symbol;

      // Получаем состояние из кэша (синхронно)
      const state = this.accountStateService.getAccountState();
      const tslRule = state.tslRules.get(pair);

      // Если для этой пары нет TSL, выходим
      if (!tslRule) {
        return;
      }

      // Получаем текущую цену
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const currentPriceDecimal = ticker.last as any;
      const currentPrice = new DecimalConstructor(currentPriceDecimal.toString());

      // Вызываем приватный обработчик логики
      const requiredUpdate = this._calculateTSL(tslRule, currentPrice);

      // Если обновление требуется
      if (requiredUpdate) {
        this.logger.info(
          `(TSLHandler) [${pair}] TSL UPDATE: Цена ${currentPrice.toString()}. Двигаем SL с ${tslRule.state.currentStopPrice.toString()} на ${requiredUpdate.newStopPrice.toString()}`,
        );

        // (Задача 9.3) Вызов "Актора" (Fire-and-Forget)
        this.pairActorManager
          .execute(pair, async () => {
            await this._updateStopLossOrder(pair, tslRule, requiredUpdate.newStopPrice, currentPrice);
          })
          .catch((e) => {
            this.logger.error(`(TSLHandler) [${pair}] КРИТИЧЕСКАЯ ОШИБКА в акторе: ${String(e)}`, e);
          });
      }
    } catch (error) {
      this.logger.error(`(TSLHandler) [${ticker.symbol}] КРИТИЧЕСКИЙ СБОЙ: ${String(error)}`, error);
      // Не бросаем ошибку, чтобы не "убить" WS-цикл
    }
  }

  /**
   * Приватный метод для расчета необходимости обновления TSL
   * Чистая, синхронная функция, использующая decimal.js
   */
  private _calculateTSL(tslRule: TSLRule, currentPrice: DecimalValue): TSLUpdateResult | null {
    const { position, state, rule } = tslRule;

    // Логика для 'long' позиции
    if (position.side === 'long') {
      // Если текущая цена выше максимальной цены, которую мы видели
      if (currentPrice.greaterThan(state.priceSeen)) {
        // Рассчитываем новый стоп: текущая_цена * (1 - расстояние / 100)
        const one = new DecimalConstructor(1);
        const distancePercent = new DecimalConstructor(rule.distance).dividedBy(100);
        const newStopPrice = currentPrice.times(one.minus(distancePercent));

        // Если новый стоп выше текущего стопа, обновляем
        if (newStopPrice.greaterThan(state.currentStopPrice)) {
          return {
            newStopPrice,
            newPriceSeen: currentPrice,
          };
        }
      }
    } else {
      // Логика для 'short' позиции
      // Если текущая цена ниже минимальной цены, которую мы видели
      if (currentPrice.lessThan(state.priceSeen)) {
        // Рассчитываем новый стоп: текущая_цена * (1 + расстояние / 100)
        const one = new DecimalConstructor(1);
        const distancePercent = new DecimalConstructor(rule.distance).dividedBy(100);
        const newStopPrice = currentPrice.times(one.plus(distancePercent));

        // Если новый стоп ниже текущего стопа, обновляем
        if (newStopPrice.lessThan(state.currentStopPrice)) {
          return {
            newStopPrice,
            newPriceSeen: currentPrice,
          };
        }
      }
    }

    // Обновление не требуется
    return null;
  }

  /**
   * Приватный метод для обновления стоп-лосс ордера
   * Этот метод всегда выполняется внутри "актора" (PairActorManager)
   */
  private async _updateStopLossOrder(
    pair: string,
    tslRule: TSLRule,
    newStopPrice: DecimalValue,
    currentPrice: DecimalValue,
  ): Promise<void> {
    this.logger.info(`[${pair}] (TSL) Начало обновления SL ордера...`);

    try {
      // Шаг 1: Отмена старого SL (гарантированно)
      await this.guaranteedExecutor.cancelOrderWithRetry(tslRule.state.currentStopOrderId, pair);
      this.logger.info(`[${pair}] (TSL) Старый SL ордер [${tslRule.state.currentStopOrderId}] отменен.`);

      // Шаг 2: Создание нового SL (гарантированно)
      const position = tslRule.position;
      const oppositeSide: 'buy' | 'sell' = position.side === 'long' ? 'sell' : 'buy';

      // Используем STOP_LOSS_LIMIT для защиты от проскальзывания
      const newSlOrder = await this.guaranteedExecutor.createOrderWithRetry(
        pair,
        'STOP_LOSS_LIMIT',
        oppositeSide,
        position.amount,
        newStopPrice,
        { stopPrice: newStopPrice.toString() },
      );

      this.logger.info(`[${pair}] (TSL) Новый SL ордер [${newSlOrder.id}] создан на бирже.`);

      // Шаг 3: Атомарное обновление БД (критично)
      await this.databaseService.executeInTransaction(async (client: PoolClient) => {
        // 1. Обновить TSL_State
        await client.query(
          `UPDATE TSL_State 
           SET current_stop_price = $1, current_stop_order_id = $2, price_seen = $3, updated_at = NOW()
           WHERE pair = $4`,
          [newStopPrice.toString(), newSlOrder.id, currentPrice.toString(), pair],
        );

        // 2. Удалить старый ActiveOrders
        await client.query('DELETE FROM ActiveOrders WHERE exchange_order_id = $1', [
          tslRule.state.currentStopOrderId,
        ]);

        // 3. Добавить новый ActiveOrders
        await client.query(
          `INSERT INTO ActiveOrders (exchange_order_id, pair, type, side, status, price, amount)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            newSlOrder.id,
            pair,
            'stop_loss_limit',
            oppositeSide,
            'open',
            newStopPrice.toString(),
            position.amount.toString(),
          ],
        );
      });

      this.logger.info(`[${pair}] (TSL) Обновление SL ордера завершено успешно.`);
    } catch (error) {
      this.logger.error(`[${pair}] (TSL) Ошибка при обновлении SL ордера:`, error);
      throw error; // Пробрасываем ошибку для обработки в акторе
    }
  }
}

