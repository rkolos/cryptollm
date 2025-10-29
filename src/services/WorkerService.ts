import * as ccxt from 'ccxt';
import Decimal from 'decimal.js';
import { LoggingService } from './LoggingService.js';
import { ValidatorService } from './ValidatorService.js';
import { GuaranteedOrderExecutionService } from './GuaranteedOrderExecutionService.js';
import { DatabaseService } from './DatabaseService.js';
import { EventBusService } from './EventBusService.js';
import { NotificationService } from './NotificationService.js';
import { GlobalStateService } from './GlobalStateService.js';
import { AccountStateService } from './AccountStateService.js';
import { ExchangeRulesService } from './ExchangeRulesService.js';
import { ConfigService } from './ConfigService.js';
import type { LLMDecision } from '../interfaces/ILLMTypes.js';
import type {
  AccountState,
  MarketData,
  StrategyContext,
  CalculatedAmounts,
  DecimalValue,
} from '../interfaces/IValidatorTypes.js';
import type { IDecimalOrder } from '../interfaces/IExchangeService.js';
import { InsufficientFundsError } from '../errors/ExchangeErrors.js';
import type winston from 'winston';
import type { PoolClient } from 'pg';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DecimalConstructor = Decimal as any;

/**
 * WorkerService - Диспетчер "Исполнителя"
 * Полный цикл исполнения решения LLM: валидация -> исполнение -> логирование
 */
export class WorkerService {
  private static instance: WorkerService | undefined;
  private readonly logger: winston.Logger;
  private readonly validatorService: ValidatorService;
  private readonly executionService: GuaranteedOrderExecutionService;
  private readonly databaseService: DatabaseService;
  private readonly eventBus: EventBusService;
  private readonly notificationService: NotificationService;
  private readonly globalStateService: GlobalStateService;
  private readonly accountStateService: AccountStateService;
  private readonly exchangeRulesService: ExchangeRulesService;
  private readonly configService: ConfigService;

  private constructor(
    validatorService: ValidatorService,
    executionService: GuaranteedOrderExecutionService,
    databaseService: DatabaseService,
    eventBus: EventBusService,
    notificationService: NotificationService,
    globalStateService: GlobalStateService,
    accountStateService: AccountStateService,
    exchangeRulesService: ExchangeRulesService,
    configService: ConfigService,
  ) {
    this.validatorService = validatorService;
    this.executionService = executionService;
    this.databaseService = databaseService;
    this.eventBus = eventBus;
    this.notificationService = notificationService;
    this.globalStateService = globalStateService;
    this.accountStateService = accountStateService;
    this.exchangeRulesService = exchangeRulesService;
    this.configService = configService;
    this.logger = LoggingService.getInstance().getLogger('Worker');
    this.logger.info('WorkerService initialized.');
  }

  public static getInstance(
    validatorService: ValidatorService,
    executionService: GuaranteedOrderExecutionService,
    databaseService: DatabaseService,
    eventBus: EventBusService,
    notificationService: NotificationService,
    globalStateService: GlobalStateService,
    accountStateService: AccountStateService,
    exchangeRulesService: ExchangeRulesService,
    configService: ConfigService,
  ): WorkerService {
    if (!WorkerService.instance) {
      WorkerService.instance = new WorkerService(
        validatorService,
        executionService,
        databaseService,
        eventBus,
        notificationService,
        globalStateService,
        accountStateService,
        exchangeRulesService,
        configService,
      );
    }
    return WorkerService.instance;
  }

  /**
   * Главный метод-диспетчер
   * Вызывается из WatcherOrchestrator внутри PairActorManager
   */
  public async execute(
    decision: LLMDecision,
    llm_decision_log_id: string,
    accountState: AccountState,
    strategyContext: StrategyContext,
    marketData: MarketData,
  ): Promise<void> {
    const pair = decision.pair;
    const logIdShort = llm_decision_log_id.substring(0, 8);
    this.logger.info(`[${pair}] Worker принял задачу (Log ID: ${logIdShort}). Action: ${decision.action}`);

    let validationResult: CalculatedAmounts | null = null;

    // --- Шаг 1: ВАЛИДАЦИЯ ---
    try {
      // HOLD не требует валидации
      if (decision.action === 'HOLD') {
        this.logger.debug(`[${pair}] Action: HOLD. Валидация не требуется.`);
      } else {
        const exchangeRules = this.exchangeRulesService.getRules(pair);

        // Вызов Валидатора
        validationResult = this.validatorService.validateDecision(
          decision,
          accountState,
          strategyContext,
          marketData,
          exchangeRules,
        );
        this.logger.debug(
          `[${pair}] Валидация успешна. Rounded Amount: ${validationResult.roundedAmountCoin.toString()}`,
        );
      }
    } catch (validationError) {
      // Провал Валидации
      const errorMessage = validationError instanceof Error ? validationError.message : String(validationError);
      this.logger.error(`[${pair}] ПРОВАЛ ВАЛИДАЦИИ: ${errorMessage}`);

      // Обновляем лог в БД
      await this._updateDecisionLog(llm_decision_log_id, 'rejected_by_validator', errorMessage, null);

      // Отправляем уведомление
      this.notificationService.sendAlert(`[${pair}] РЕШЕНИЕ ОТКЛОНЕНО: ${errorMessage}`, false);

      return; // Остановка
    }

    // --- Шаг 2: ИСПОЛНЕНИЕ ---
    try {
      // Передаем validationResult, т.к. там уже рассчитаны все суммы
      switch (decision.action) {
        case 'OPEN_LONG':
        case 'OPEN_SHORT':
          await this.handleOpenPosition(decision, validationResult!);
          break;

        case 'CLOSE_POSITION':
          await this.handleClosePosition(decision, validationResult!);
          break;

        case 'MODIFY_POSITION':
          await this.handleModifyPosition(decision, validationResult!);
          break;

        case 'CANCEL_ORDERS':
          await this.handleCancelOrders(decision, validationResult!);
          break;

        case 'HOLD':
          // Ничего не делаем
          break;
      }

      // Успех
      this.logger.info(`[${pair}] Исполнение УСПЕШНО: ${decision.action}`);

      // Публикация События (Задача 7.1.3)
      this.eventBus.emitTradeExecuted(pair);

      // Обновляем лог в БД
      await this._updateDecisionLog(llm_decision_log_id, 'accepted', null, null);

      // Отправляем уведомление со сводной информацией о торговле для действий OPEN/CLOSE
      // (т.е. для действий, которые изменяют позиции)
      if (decision.action === 'OPEN_LONG' || decision.action === 'OPEN_SHORT' || decision.action === 'CLOSE_POSITION') {
        this.notificationService.sendTradingSummary(
          decision.action,
          pair,
          decision.justification || 'Обоснование не предоставлено',
        );
      } else {
        // Для других действий отправляем обычное уведомление с обоснованием
        this.notificationService.sendAlert(
          `[${pair}] ИСПОЛНЕНО: ${decision.action}\n\n🤖 Обоснование LLM:\n${decision.justification || 'Обоснование не предоставлено'}`,
          true, // Включить AccountState
        );
      }
    } catch (executionError) {
      // Провал Исполнения
      const errorMessage = executionError instanceof Error ? executionError.message : String(executionError);
      this.logger.error(`[${pair}] КРИТИЧЕСКАЯ ОШИБКА ИСПОЛНЕНИЯ: ${errorMessage}`);

      // Обработка ошибки уникальности (unique violation) - позиция уже существует
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dbError = executionError as any;
      if (dbError.code === '23505') {
        // unique_violation
        this.logger.error(
          `[${pair}] Ошибка уникальности БД (23505)! Позиция, вероятно, уже существует. Запуск принудительной синхронизации...`,
        );
        this.notificationService.sendAlert(
          `[${pair}] КРИТИЧЕСКАЯ ОШИБКА СИНХРОНИЗАЦИИ (23505)! Попытка открыть уже открытую позицию. Требуется проверка.`,
          false,
        );
        // Принудительно обновляем кэш, т.к. он явно не совпадает с БД
        await this.accountStateService.refreshNow();
      }

      // Обновляем лог в БД
      await this._updateDecisionLog(llm_decision_log_id, 'failed_by_worker', null, errorMessage);

      // Отправляем уведомление
      this.notificationService.sendAlert(`[${pair}] ОШИБКА ИСПОЛНЕНИЯ: ${errorMessage}`, true);

      // Специальная обработка InsufficientFunds
      if (executionError instanceof InsufficientFundsError || executionError instanceof ccxt.InsufficientFunds) {
        this.logger.error(`[${pair}] InsufficientFundsError! Активация Глобальной Паузы.`);
        this.notificationService.sendAlert(
          `[FATAL] НЕДОСТАТОЧНО СРЕДСТВ! Бот ПРИОСТАНОВЛЕН. Требуется ручное вмешательство.`,
          true,
        );
        // Ставим на паузу
        this.globalStateService.pause();
        // Принудительно обновляем кэш баланса
        await this.accountStateService.refreshNow();
      }

      // Пробрасываем ошибку выше, чтобы PairActorManager ее "увидел"
      throw executionError;
    }
  }

  /**
   * Вспомогательный метод: Обновляет LLM_Decision_Log в БД
   */
  private async _updateDecisionLog(
    logId: string,
    status: 'rejected_by_validator' | 'accepted' | 'failed_by_worker',
    validatorError: string | null,
    workerError: string | null,
  ): Promise<void> {
    try {
      await this.databaseService.query(
        `UPDATE LLM_Decision_Log
         SET
            decision_result = $2,
            validator_error_message = $3,
            worker_error_message = $4
         WHERE id = $1`,
        [logId, status, validatorError, workerError],
      );
    } catch (dbError) {
      const errorMessage = dbError instanceof Error ? dbError.message : String(dbError);
      this.logger.error(`[FATAL] Не удалось обновить LLM_Decision_Log (ID: ${logId}): ${errorMessage}`);
    }
  }

  // --- РЕАЛИЗАЦИЯ: Задачи 7.2 - 7.5 ---

  /**
   * Обработчик открытия позиции (Market или Limit)
   */
  private async handleOpenPosition(decision: LLMDecision, validationResult: CalculatedAmounts): Promise<void> {
    const { type } = decision.parameters;

    if (type === 'market') {
      // Логика Задачи 7.2
      await this._handleOpenMarketPosition(decision, validationResult);
    } else if (type === 'limit') {
      // Логика Задачи 7.2.1
      await this._handleOpenLimitPosition(decision, validationResult);
    } else {
      throw new Error(`[${decision.pair}] Неизвестный тип ордера в handleOpenPosition: ${type}`);
    }
  }

  /**
   * Реализация OPEN (Market) - Задача 7.2
   * Немедленное открытие позиции через market ордер
   */
  private async _handleOpenMarketPosition(decision: LLMDecision, validationResult: CalculatedAmounts): Promise<void> {
    const { pair, parameters, action } = decision;
    const { stop_loss_price, take_profit_price, trailing_stop_config } = parameters;
    const { roundedAmountCoin } = validationResult;

    const side: 'buy' | 'sell' = action === 'OPEN_LONG' ? 'buy' : 'sell';
    const oppositeSide: 'buy' | 'sell' = side === 'buy' ? 'sell' : 'buy';

    this.logger.debug(
      `[${pair}] Запуск _handleOpenMarketPosition. Side: ${side}, Amount: ${roundedAmountCoin.toString()}`,
    );

    // КРИТИЧНО: Market ордер исполняется немедленно, его нельзя отменить
    // Но SL/TP ордера можно отменить, если БД операция упадет
    // Поэтому создаем SL/TP ДО транзакции БД

    // --- Шаг 1: Создание Market ордера (исполняется немедленно) ---
    const marketOrder = await this.executionService.createOrderWithRetry(pair, 'market', side, roundedAmountCoin);

    // Извлекаем РЕАЛЬНЫЕ данные исполнения
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orderAny = marketOrder as any;
    const realEntryPrice = orderAny.average || orderAny.price;
    const realAmount = orderAny.filled || orderAny.amount;
    const realFeeCost = orderAny.fee?.cost ?? new DecimalConstructor(0);
    const realTimestamp = orderAny.timestamp ?? Date.now();

    if (!realEntryPrice || !realAmount) {
      throw new Error(
        `[${pair}] КРИТИЧЕСКАЯ ОШИБКА: Market ордер ${marketOrder.id} вернул 'null' price или 'null' amount.`,
      );
    }

    this.logger.debug(
      `[${pair}] Market ордер ${marketOrder.id} исполнен. Price: ${realEntryPrice.toString()}, Amount: ${realAmount.toString()}`,
    );

    // Конвертируем DecimalValue в Decimal для вычислений
    const entryPriceDecimal = new DecimalConstructor(realEntryPrice.toString());
    const amountDecimal = new DecimalConstructor(realAmount.toString());
    const feeCostDecimal = new DecimalConstructor(realFeeCost.toString() || '0');

    // --- Шаг 2: Создание SL/TP ордеров ДО транзакции БД ---
    let slOrder: IDecimalOrder | null = null;
    let tpOrder: IDecimalOrder | null = null;

    try {
      // Создаем SL
      if (stop_loss_price !== null && stop_loss_price !== undefined) {
        const slPriceDecimal = new DecimalConstructor(stop_loss_price.toString());
        const slPriceParams = { stopPrice: slPriceDecimal.toNumber() };

        slOrder = await this.executionService.createOrderWithRetry(
          pair,
          'stop_loss_limit',
          oppositeSide,
          amountDecimal,
          slPriceDecimal,
          slPriceParams,
        );
        this.logger.debug(`[${pair}] SL ордер ${slOrder.id} создан на бирже.`);
      }

      // Создаем TP
      if (take_profit_price !== null && take_profit_price !== undefined) {
        const tpPriceDecimal = new DecimalConstructor(take_profit_price.toString());

        tpOrder = await this.executionService.createOrderWithRetry(
          pair,
          'limit',
          oppositeSide,
          amountDecimal,
          tpPriceDecimal,
        );
        this.logger.debug(`[${pair}] TP ордер ${tpOrder.id} создан на бирже.`);
      }

      // --- Шаг 3: Сохранение Состояния в БД (Атомарно) ---
      try {
        await this.databaseService.executeInTransaction(async (client: PoolClient): Promise<void> => {
          // 1. Сохранить Позицию
          await client.query(
            `INSERT INTO ActivePositions (
              pair, side, amount, average_entry_price, total_fee_cost, stop_loss_price
            ) VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              pair,
              action === 'OPEN_LONG' ? 'long' : 'short',
              amountDecimal.toNumber(),
              entryPriceDecimal.toNumber(),
              feeCostDecimal.toNumber(),
              stop_loss_price !== null && stop_loss_price !== undefined ? stop_loss_price : null,
            ],
          );

          // 2. Сохранить Историю (вход)
          // Для exchange_trade_id используем order.id + timestamp для уникальности
          const exchangeTradeId = `${marketOrder.id}-${realTimestamp}`;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const feeCurrency = (orderAny.fee?.currency as string) || 'USDT';

          await client.query(
            `INSERT INTO TradeHistory (
              timestamp, exchange_trade_id, exchange_order_id, pair, side, price, amount, fee_cost, fee_currency
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              new Date(realTimestamp),
              exchangeTradeId,
              marketOrder.id,
              pair,
              side,
              entryPriceDecimal.toNumber(),
              amountDecimal.toNumber(),
              feeCostDecimal.toNumber(),
              feeCurrency,
            ],
          );

          // 3. Сохранить SL ордер
          if (slOrder) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const slOrderAny = slOrder as any;
            const slPrice = slOrderAny.price || slOrderAny.stopPrice || stop_loss_price;
            const slPriceDecimal = new DecimalConstructor(slPrice.toString());

            await client.query(
              `INSERT INTO ActiveOrders (
                exchange_order_id, pair, status, type, side, price, amount
              ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [
                slOrder.id,
                pair,
                slOrder.status || 'open',
                'stop_loss_limit',
                slOrder.side,
                slPriceDecimal.toNumber(),
                amountDecimal.toNumber(),
              ],
            );
          }

          // 4. Сохранить TP ордер
          if (tpOrder) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const tpOrderAny = tpOrder as any;
            const tpPrice = tpOrderAny.price || take_profit_price;
            const tpPriceDecimal = new DecimalConstructor(tpPrice.toString());

            await client.query(
              `INSERT INTO ActiveOrders (
                exchange_order_id, pair, status, type, side, price, amount
              ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [
                tpOrder.id,
                pair,
                tpOrder.status || 'open',
                'take_profit_limit',
                tpOrder.side,
                tpPriceDecimal.toNumber(),
                amountDecimal.toNumber(),
              ],
            );
          }

          // 5. Сохранить TSL (если есть)
          if (trailing_stop_config && slOrder) {
            const tslConfigJson = JSON.stringify(trailing_stop_config);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const slOrderAny = slOrder as any;
            const slPrice = slOrderAny.price || slOrderAny.stopPrice || stop_loss_price;
            const slPriceDecimal = new DecimalConstructor(slPrice.toString());

            await client.query(
              `INSERT INTO TSL_State (
                pair, current_stop_price, current_stop_order_id, price_seen, rule_config_json
              ) VALUES ($1, $2, $3, $4, $5)`,
              [
                pair,
                slPriceDecimal.toNumber(),
                slOrder.id,
                entryPriceDecimal.toNumber(), // Начальная "пиковая" цена = цена входа
                tslConfigJson,
              ],
            );
          }

          this.logger.info(`[${pair}] Атомарная транзакция (OPEN Market) УСПЕШНА.`);
        });
      } catch (dbError) {
        // КРИТИЧЕСКИЙ СБОЙ: БД операция упала, но SL/TP ордера уже созданы на бирже
        // Отменяем их, чтобы избежать "зомби" ордеров
        this.logger.error(`[${pair}] КРИТИЧЕСКИЙ СБОЙ: БД транзакция провалилась. Отменяем SL/TP ордера...`, dbError);

        const cancelPromises: Promise<void>[] = [];
        if (slOrder !== null) {
          const slOrderId = slOrder.id;
          cancelPromises.push(
            this.executionService.cancelOrderWithRetry(slOrderId, pair).catch((cancelError) => {
              this.logger.error(`[${pair}] Не удалось отменить SL ордер ${slOrderId}:`, cancelError);
            }),
          );
        }
        if (tpOrder !== null) {
          const tpOrderId = tpOrder.id;
          cancelPromises.push(
            this.executionService.cancelOrderWithRetry(tpOrderId, pair).catch((cancelError) => {
              this.logger.error(`[${pair}] Не удалось отменить TP ордер ${tpOrderId}:`, cancelError);
            }),
          );
        }

        await Promise.allSettled(cancelPromises);
        this.logger.warn(
          `[${pair}] SL/TP ордера отменены. Позиция открыта (market ордер исполнен), но не записана в БД. SyncEngine восстановит состояние при следующей сверке.`,
        );

        // Пробрасываем ошибку выше
        throw dbError;
      }
    } catch (orderError) {
      // Ошибка при создании SL/TP ордеров - пробрасываем выше
      // Market ордер уже исполнен, позиция открыта, но без SL/TP
      this.logger.error(`[${pair}] Ошибка при создании SL/TP ордеров:`, orderError);
      throw orderError;
    }
  }

  /**
   * Реализация OPEN (Limit) - Задача 7.2.1
   * Отложенное открытие позиции через limit ордер
   */
  private async _handleOpenLimitPosition(decision: LLMDecision, validationResult: CalculatedAmounts): Promise<void> {
    const { pair, parameters, action } = decision;
    const { price, stop_loss_price, take_profit_price, trailing_stop_config } = parameters;
    const { roundedAmountCoin } = validationResult;

    const side: 'buy' | 'sell' = action === 'OPEN_LONG' ? 'buy' : 'sell';

    this.logger.debug(
      `[${pair}] Запуск _handleOpenLimitPosition. Side: ${side}, Amount: ${roundedAmountCoin.toString()}, Price: ${price}`,
    );

    // Проверка наличия цены для limit ордера
    if (!price) {
      throw new Error(`[${pair}] КРИТИЧЕСКАЯ ОШИБКА: Для limit ордера требуется параметр price.`);
    }

    // Критично: Вся операция выполняется в ОДНОЙ транзакции
    await this.databaseService.executeInTransaction(async (client: PoolClient): Promise<void> => {
      // --- Шаг 1: Создание Limit ордера ---
      // НЕ ЖДАТЬ ИСПОЛНЕНИЯ - ордер остается открытым
      const limitPriceDecimal = new DecimalConstructor(price.toString());
      const amountDecimal = new DecimalConstructor(roundedAmountCoin.toString());

      const limitOrder = await this.executionService.createOrderWithRetry(
        pair,
        'limit',
        side,
        amountDecimal,
        limitPriceDecimal,
      );

      this.logger.debug(`[${pair}] Limit ордер ${limitOrder.id} создан (status: ${limitOrder.status || 'open'}).`);

      // --- Шаг 2: Сохранение Limit ордера в БД (Атомарно) ---
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const orderAny = limitOrder as any;
      const orderPrice = orderAny.price || limitPriceDecimal;
      const orderPriceDecimal = new DecimalConstructor(orderPrice.toString());

      // Подготовка JSON для trailing_stop_config
      const tslConfigJson = trailing_stop_config ? JSON.stringify(trailing_stop_config) : null;

      // Сохраняем limit_open ордер с target полями
      await client.query(
        `INSERT INTO ActiveOrders (
          exchange_order_id, pair, status, type, side, price, amount,
          target_stop_loss_price, target_take_profit_price, target_trailing_stop_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          limitOrder.id,
          pair,
          limitOrder.status || 'open',
          'limit_open',
          side,
          orderPriceDecimal.toNumber(),
          amountDecimal.toNumber(),
          stop_loss_price !== null && stop_loss_price !== undefined ? stop_loss_price : null,
          take_profit_price !== null && take_profit_price !== undefined ? take_profit_price : null,
          tslConfigJson,
        ],
      );

      this.logger.info(
        `[${pair}] Атомарная транзакция (OPEN Limit) УСПЕШНА. Ордер ${limitOrder.id} сохранен с target полями.`,
      );
    });
  }

  /**
   * Обработчик закрытия позиции (Market или Limit)
   */
  private async handleClosePosition(decision: LLMDecision, validationResult: CalculatedAmounts): Promise<void> {
    const { type } = decision.parameters;

    if (type === 'market') {
      // Логика Задачи 7.3
      await this._handleCloseMarketPosition(decision, validationResult);
    } else if (type === 'limit') {
      // Логика Задачи 7.3.1
      await this._handleCloseLimitPosition(decision, validationResult);
    } else {
      throw new Error(`[${decision.pair}] Неизвестный тип ордера в handleClosePosition: ${type}`);
    }
  }

  /**
   * Реализация CLOSE_POSITION (Market) - Задача 7.3
   * Немедленное закрытие позиции через market ордер
   */
  private async _handleCloseMarketPosition(
    decision: LLMDecision,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _validationResult: CalculatedAmounts,
  ): Promise<void> {
    const { pair } = decision;

    this.logger.debug(`[${pair}] Запуск _handleCloseMarketPosition.`);

    // Критично: Вся операция выполняется в ОДНОЙ транзакции
    await this.databaseService.executeInTransaction(async (client: PoolClient): Promise<void> => {
      // --- Шаг 1: Получить Позицию из БД (и заблокировать строку) ---
      // Мы должны получить точное кол-во, сторону, цену входа и комиссию ПЕРЕД закрытием
      const positionResult = await client.query(
        `SELECT amount, side, average_entry_price, total_fee_cost FROM ActivePositions WHERE pair = $1 FOR UPDATE`,
        [pair],
      );

      if (positionResult.rowCount === 0) {
        // Это может случиться, если SL сработал за мгновение до этого
        this.logger.warn(
          `[${pair}] Попытка закрыть позицию, которая уже не существует в БД. (Возможно, SL/TP сработал?)`,
        );
        throw new Error(`[${pair}] (ОШИБКА СИНХРОНИЗАЦИИ) Позиция для закрытия не найдена в ActivePositions.`);
      }

      const currentPosition = positionResult.rows[0];
      const positionAmountDecimal = new DecimalConstructor(currentPosition.amount.toString());
      const positionSide = currentPosition.side as 'long' | 'short';

      // Определяем ордер на закрытие
      const closeSide: 'buy' | 'sell' = positionSide === 'long' ? 'sell' : 'buy';

      this.logger.debug(
        `[${pair}] Закрытие ${positionSide} позиции. Объем: ${positionAmountDecimal.toString()}, Сторона ордера: ${closeSide}.`,
      );

      // --- Шаг 2: (Архитектура 7.3) - НЕ отменять ордера ---
      // Мы НЕ вызываем cancelAllOrders здесь, чтобы избежать "гонок".
      // Вместо этого мы атомарно удалим их из ActiveOrders (Шаг 4).
      // "Осиротевшие" ордера на бирже будут очищены "Сверщиком" (SyncEngine 5.1).

      // --- Шаг 3: Создание Market ордера на Закрытие ---
      const closeMarketOrder = await this.executionService.createOrderWithRetry(
        pair,
        'market',
        closeSide,
        positionAmountDecimal,
      );

      // Извлекаем РЕАЛЬНЫЕ данные исполнения
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const orderAny = closeMarketOrder as any;
      const realClosePrice = orderAny.average || orderAny.price;
      const realAmount = orderAny.filled || orderAny.amount;
      const realFeeCost = orderAny.fee?.cost ?? new DecimalConstructor(0);
      const realTimestamp = orderAny.timestamp ?? Date.now();

      if (!realClosePrice || !realAmount) {
        throw new Error(
          `[${pair}] КРИТИЧЕСКАЯ ОШИБКА: Market ордер (Закрытие) ${closeMarketOrder.id} вернул 'null' price или 'null' amount.`,
        );
      }

      this.logger.debug(
        `[${pair}] Market ордер (Закрытие) ${closeMarketOrder.id} исполнен. Price: ${realClosePrice.toString()}, Amount: ${realAmount.toString()}`,
      );

      // Конвертируем DecimalValue в Decimal для вычислений
      const closePriceDecimal = new DecimalConstructor(realClosePrice.toString());
      const amountDecimal = new DecimalConstructor(realAmount.toString());
      const closeFeeCostDecimal = new DecimalConstructor(realFeeCost.toString() || '0');

      // --- Расчет Realized PnL ---
      const entryPriceDecimal = new DecimalConstructor(currentPosition.average_entry_price.toString());
      const entryFeeCostDecimal = new DecimalConstructor(currentPosition.total_fee_cost?.toString() || '0');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entryFeeDecimal = entryFeeCostDecimal as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const closeFeeDecimal = closeFeeCostDecimal as any;

      let realizedPnlUsd: DecimalValue;
      if (positionSide === 'long') {
        // Для LONG: PnL = (close_price - entry_price) * amount - entry_fee - close_fee
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const priceDiffDecimal = (closePriceDecimal as any).minus(entryPriceDecimal);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const amountDecimalForCalc = amountDecimal as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const grossPnl = priceDiffDecimal.mul(amountDecimalForCalc);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const totalFees = (entryFeeDecimal as any).plus(closeFeeDecimal);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        realizedPnlUsd = grossPnl.minus(totalFees) as DecimalValue;
      } else {
        // Для SHORT: PnL = (entry_price - close_price) * amount - entry_fee - close_fee
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const priceDiffDecimal = (entryPriceDecimal as any).minus(closePriceDecimal);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const amountDecimalForCalc = amountDecimal as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const grossPnl = priceDiffDecimal.mul(amountDecimalForCalc);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const totalFees = (entryFeeDecimal as any).plus(closeFeeDecimal);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        realizedPnlUsd = grossPnl.minus(totalFees) as DecimalValue;
      }

      // Логируем PnL
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const realizedPnlDecimal = realizedPnlUsd as any;
      this.logger.info(
        `[${pair}] Realized PnL: ${realizedPnlDecimal.toFixed(2)} USDT (Entry: ${entryPriceDecimal.toString()}, Close: ${closePriceDecimal.toString()}, Amount: ${amountDecimal.toString()})`,
      );

      // --- Шаг 4: Атомарная Очистка БД ---

      // 1. Удалить Позицию
      await client.query(`DELETE FROM ActivePositions WHERE pair = $1`, [pair]);

      // 2. Удалить ВСЕ связанные ордера (SL, TP, Limit)
      await client.query(`DELETE FROM ActiveOrders WHERE pair = $1`, [pair]);

      // 3. Удалить ВСЕ связанные TSL
      await client.query(`DELETE FROM TSL_State WHERE pair = $1`, [pair]);

      // 4. Сохранить Историю (выход) с calculated PnL
      // Для exchange_trade_id используем order.id + timestamp для уникальности
      const exchangeTradeId = `${closeMarketOrder.id}-${realTimestamp}`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const feeCurrency = (orderAny.fee?.currency as string) || 'USDT';

      await client.query(
        `INSERT INTO TradeHistory (
          timestamp, exchange_trade_id, exchange_order_id, pair, side, price, amount, fee_cost, fee_currency, realized_pnl_usd
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          new Date(realTimestamp),
          exchangeTradeId,
          closeMarketOrder.id,
          pair,
          closeSide, // Сторона ордера ('buy' или 'sell')
          closePriceDecimal.toNumber(),
          amountDecimal.toNumber(),
          closeFeeCostDecimal.toNumber(),
          feeCurrency,
          realizedPnlDecimal.toNumber(),
        ],
      );

      this.logger.info(`[${pair}] Атомарная транзакция (CLOSE Market) УСПЕШНА.`);
    });
  }

  /**
   * Реализация CLOSE_POSITION (Limit) - Задача 7.3.1
   * Отложенное закрытие позиции через limit ордер (Take Profit)
   */
  private async _handleCloseLimitPosition(
    decision: LLMDecision,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _validationResult: CalculatedAmounts,
  ): Promise<void> {
    const { pair, parameters } = decision;
    const { price: limitPrice } = parameters;

    // Проверка наличия цены для limit ордера
    if (!limitPrice) {
      throw new Error(`[${pair}] (ОШИБКА ВАЛИДАТОРА) CLOSE_POSITION (Limit) требует параметр 'price'.`);
    }

    this.logger.debug(`[${pair}] Запуск _handleCloseLimitPosition. Price: ${limitPrice}`);

    // Критично: Вся операция выполняется в ОДНОЙ транзакции
    await this.databaseService.executeInTransaction(async (client: PoolClient): Promise<void> => {
      // --- Шаг 1: Получить Позицию из БД (и заблокировать строку) ---
      const positionResult = await client.query(`SELECT amount, side FROM ActivePositions WHERE pair = $1 FOR UPDATE`, [
        pair,
      ]);

      if (positionResult.rowCount === 0) {
        this.logger.warn(`[${pair}] Попытка установить Limit Close для позиции, которая не существует в БД.`);
        throw new Error(`[${pair}] (ОШИБКА СИНХРОНИЗАЦИИ) Позиция для Limit Close не найдена в ActivePositions.`);
      }

      const currentPosition = positionResult.rows[0];
      const positionAmountDecimal = new DecimalConstructor(currentPosition.amount.toString());
      const positionSide = currentPosition.side as 'long' | 'short';

      // Определяем ордер на закрытие
      const closeSide: 'buy' | 'sell' = positionSide === 'long' ? 'sell' : 'buy';

      this.logger.debug(
        `[${pair}] Установка Limit Close (TP) для ${positionSide} позиции. Объем: ${positionAmountDecimal.toString()}, Сторона: ${closeSide}.`,
      );

      // --- Шаг 2: Создание Limit ордера на Закрытие ---
      // НЕ ЖДАТЬ ИСПОЛНЕНИЯ - ордер остается открытым
      const limitPriceDecimal = new DecimalConstructor(limitPrice.toString());

      const limitCloseOrder = await this.executionService.createOrderWithRetry(
        pair,
        'limit',
        closeSide,
        positionAmountDecimal,
        limitPriceDecimal,
      );

      this.logger.debug(
        `[${pair}] Limit ордер (Закрытие) ${limitCloseOrder.id} создан (status: ${limitCloseOrder.status || 'open'}).`,
      );

      // --- Шаг 3: Атомарная Запись Ордера в БД ---
      // Мы НЕ удаляем позицию, т.к. ордер еще не исполнен
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const orderAny = limitCloseOrder as any;
      const orderPrice = orderAny.price || limitPriceDecimal;
      const orderPriceDecimal = new DecimalConstructor(orderPrice.toString());

      await client.query(
        `INSERT INTO ActiveOrders (
          exchange_order_id, pair, status, type, side, price, amount
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (exchange_order_id) DO UPDATE SET
          status = excluded.status,
          price = excluded.price,
          amount = excluded.amount`,
        [
          limitCloseOrder.id,
          pair,
          limitCloseOrder.status || 'open',
          'limit_close', // Наш внутренний тип
          closeSide,
          orderPriceDecimal.toNumber(),
          positionAmountDecimal.toNumber(),
        ],
      );

      this.logger.info(
        `[${pair}] Атомарная транзакция (CLOSE Limit) УСПЕШНА. Ордер ${limitCloseOrder.id} сохранен как limit_close.`,
      );
    });
  }

  /**
   * Реализация MODIFY_POSITION - Задача 7.4
   * Изменение SL/TP существующей позиции, включая TSL
   */
  private async handleModifyPosition(
    decision: LLMDecision,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _validationResult: CalculatedAmounts,
  ): Promise<void> {
    const { pair, parameters } = decision;
    const { new_stop_loss_price, new_take_profit_price, new_trailing_stop_config } = parameters;

    this.logger.debug(`[${pair}] Запуск handleModifyPosition...`);

    // КРИТИЧНО: Отмена и создание ордеров на бирже должны происходить ДО транзакции БД
    // Если БД операция упадет, нужно отменить созданные ордера

    // --- Шаг 1: Получить информацию о позиции (БЕЗ блокировки, для чтения) ---
    const positionCheckResult = await this.databaseService.query(
      `SELECT
        p.side, p.amount,
        (SELECT exchange_order_id FROM ActiveOrders WHERE pair = $1 AND type = 'stop_loss_limit' LIMIT 1) as current_sl_id,
        (SELECT exchange_order_id FROM ActiveOrders WHERE pair = $1 AND type = 'take_profit_limit' LIMIT 1) as current_tp_id,
        (SELECT current_stop_order_id FROM TSL_State WHERE pair = $1 LIMIT 1) as current_tsl_sl_id
      FROM ActivePositions p
      WHERE p.pair = $1`,
      [pair],
    );

    if (positionCheckResult.rowCount === 0) {
      this.logger.warn(`[${pair}] Попытка MODIFY_POSITION для несуществующей позиции.`);
      throw new Error(`[${pair}] (ОШИБКА СИНХРОНИЗАЦИИ) Позиция для MODIFY не найдена в ActivePositions.`);
    }

    const pos = positionCheckResult.rows[0];
    const oppositeSide: 'buy' | 'sell' = pos.side === 'long' ? 'sell' : 'buy';
    const positionAmountDecimal = new DecimalConstructor(pos.amount.toString());
    let newSlOrder: IDecimalOrder | null = null;
    let newTpOrder: IDecimalOrder | null = null;
    const ordersToCancel: string[] = [];

    // --- Шаг 2: Обработка нового Stop Loss (если запрошен) ДО транзакции БД ---
    if (new_stop_loss_price !== null && new_stop_loss_price !== undefined) {
      this.logger.debug(`[${pair}] Модификация SL. Новая цена: ${new_stop_loss_price}`);

      // 2.1. Отмена старого SL на бирже
      const oldSlId = pos.current_tsl_sl_id || pos.current_sl_id;
      if (oldSlId) {
        try {
          await this.executionService.cancelOrderWithRetry(oldSlId, pair);
          ordersToCancel.push(oldSlId);
          this.logger.debug(`[${pair}] Старый SL ордер ${oldSlId} отменен на бирже.`);
        } catch (cancelError) {
          this.logger.warn(`[${pair}] Не удалось отменить старый SL ордер ${oldSlId}:`, cancelError);
          // Продолжаем работу, возможно ордер уже исполнен или отменен
        }
      }

      // 2.2. Создание нового SL на бирже
      const slPriceDecimal = new DecimalConstructor(new_stop_loss_price.toString());
      const slPriceParams = { stopPrice: slPriceDecimal.toNumber() };

      try {
        newSlOrder = await this.executionService.createOrderWithRetry(
          pair,
          'stop_loss_limit',
          oppositeSide,
          positionAmountDecimal,
          slPriceDecimal,
          slPriceParams,
        );
        this.logger.debug(`[${pair}] Новый SL ордер ${newSlOrder.id} создан на бирже.`);
      } catch (createError) {
        this.logger.error(`[${pair}] Не удалось создать новый SL ордер:`, createError);
        throw createError;
      }
    }

    // --- Шаг 3: Обработка нового Take Profit (если запрошен) ДО транзакции БД ---
    if (new_take_profit_price !== null && new_take_profit_price !== undefined) {
      this.logger.debug(`[${pair}] Модификация TP. Новая цена: ${new_take_profit_price}`);

      // 3.1. Отмена старого TP на бирже
      if (pos.current_tp_id) {
        try {
          await this.executionService.cancelOrderWithRetry(pos.current_tp_id, pair);
          ordersToCancel.push(pos.current_tp_id);
          this.logger.debug(`[${pair}] Старый TP ордер ${pos.current_tp_id} отменен на бирже.`);
        } catch (cancelError) {
          this.logger.warn(`[${pair}] Не удалось отменить старый TP ордер ${pos.current_tp_id}:`, cancelError);
        }
      }

      // 3.2. Создание нового TP на бирже
      const tpPriceDecimal = new DecimalConstructor(new_take_profit_price.toString());

      try {
        newTpOrder = await this.executionService.createOrderWithRetry(
          pair,
          'limit',
          oppositeSide,
          positionAmountDecimal,
          tpPriceDecimal,
        );
        this.logger.debug(`[${pair}] Новый TP ордер ${newTpOrder.id} создан на бирже.`);
      } catch (createError) {
        this.logger.error(`[${pair}] Не удалось создать новый TP ордер:`, createError);
        // Если SL был создан, отменяем его
        if (newSlOrder) {
          try {
            await this.executionService.cancelOrderWithRetry(newSlOrder.id, pair);
          } catch (cancelError) {
            this.logger.error(`[${pair}] Не удалось отменить только что созданный SL ордер:`, cancelError);
          }
        }
        throw createError;
      }
    }

    // --- Шаг 4: Атомарное обновление БД ---
    try {
      await this.databaseService.executeInTransaction(async (client: PoolClient): Promise<void> => {
        // Блокируем позицию для обновления
        const queryResult = await client.query(`SELECT side, amount FROM ActivePositions WHERE pair = $1 FOR UPDATE`, [
          pair,
        ]);

        if (queryResult.rowCount === 0) {
          throw new Error(`[${pair}] Позиция исчезла из БД во время MODIFY.`);
        }

        // 4.1. Удаляем старые ордера из БД
        for (const orderId of ordersToCancel) {
          await client.query(`DELETE FROM ActiveOrders WHERE exchange_order_id = $1`, [orderId]);
          await client.query(`DELETE FROM TSL_State WHERE current_stop_order_id = $1`, [orderId]);
        }

        // 4.2. Сохранение нового SL в БД
        if (newSlOrder) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const slOrderAny = newSlOrder as any;
          const slPrice = slOrderAny.price || slOrderAny.stopPrice || new_stop_loss_price;
          const slPriceDecimalForDb = new DecimalConstructor(slPrice.toString());

          await client.query(
            `INSERT INTO ActiveOrders (exchange_order_id, pair, status, type, side, price, amount)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              newSlOrder.id,
              pair,
              newSlOrder.status || 'open',
              'stop_loss_limit',
              newSlOrder.side,
              slPriceDecimalForDb.toNumber(),
              positionAmountDecimal.toNumber(),
            ],
          );

          // Обновляем цену в ActivePositions
          await client.query(`UPDATE ActivePositions SET stop_loss_price = $1 WHERE pair = $2`, [
            slPriceDecimalForDb.toNumber(),
            pair,
          ]);

          // 4.3. Логика сохранения/обновления TSL (если запрошен)
          if (new_trailing_stop_config) {
            this.logger.debug(`[${pair}] (Re)Configuring TSL...`);
            const tslConfigJson = JSON.stringify(new_trailing_stop_config);

            await client.query(
              `INSERT INTO TSL_State (pair, current_stop_price, current_stop_order_id, price_seen, rule_config_json)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (pair) DO UPDATE SET
                 current_stop_price = excluded.current_stop_price,
                 current_stop_order_id = excluded.current_stop_order_id,
                 price_seen = excluded.price_seen,
                 rule_config_json = excluded.rule_config_json,
                 updated_at = NOW()`,
              [pair, slPriceDecimalForDb.toNumber(), newSlOrder.id, slPriceDecimalForDb.toNumber(), tslConfigJson],
            );
          } else if (ordersToCancel.length > 0) {
            // Если TSL был отключен, удаляем его состояние
            await client.query(`DELETE FROM TSL_State WHERE pair = $1`, [pair]);
          }
        }

        // 4.4. Сохранение нового TP в БД
        if (newTpOrder) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const tpOrderAny = newTpOrder as any;
          const tpPrice = tpOrderAny.price || new_take_profit_price;
          const tpPriceDecimalForDb = new DecimalConstructor(tpPrice.toString());

          await client.query(
            `INSERT INTO ActiveOrders (exchange_order_id, pair, status, type, side, price, amount)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              newTpOrder.id,
              pair,
              newTpOrder.status || 'open',
              'take_profit_limit',
              newTpOrder.side,
              tpPriceDecimalForDb.toNumber(),
              positionAmountDecimal.toNumber(),
            ],
          );
        }

        this.logger.info(`[${pair}] Атомарная транзакция (MODIFY_POSITION) УСПЕШНА.`);
      });
    } catch (dbError) {
      // КРИТИЧЕСКИЙ СБОЙ: БД операция упала, но новые ордера уже созданы на бирже
      // Отменяем их, чтобы избежать "зомби" ордеров
      this.logger.error(`[${pair}] КРИТИЧЕСКИЙ СБОЙ: БД транзакция провалилась. Отменяем новые ордера...`, dbError);

      const cancelPromises: Promise<void>[] = [];
      if (newSlOrder) {
        cancelPromises.push(
          this.executionService.cancelOrderWithRetry(newSlOrder.id, pair).catch((cancelError) => {
            this.logger.error(`[${pair}] Не удалось отменить новый SL ордер ${newSlOrder.id}:`, cancelError);
          }),
        );
      }
      if (newTpOrder) {
        cancelPromises.push(
          this.executionService.cancelOrderWithRetry(newTpOrder.id, pair).catch((cancelError) => {
            this.logger.error(`[${pair}] Не удалось отменить новый TP ордер ${newTpOrder.id}:`, cancelError);
          }),
        );
      }

      await Promise.allSettled(cancelPromises);
      this.logger.warn(
        `[${pair}] Новые ордера отменены. Старые ордера уже отменены, позиция в несогласованном состоянии. SyncEngine восстановит состояние при следующей сверке.`,
      );

      // Пробрасываем ошибку выше
      throw dbError;
    }
  }

  /**
   * Реализация CANCEL_ORDERS - Задача 7.5
   * Отмена ордеров (limit, SL) без закрытия позиции
   */
  private async handleCancelOrders(
    decision: LLMDecision,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _validationResult: CalculatedAmounts,
  ): Promise<void> {
    const { pair, parameters } = decision;
    const orderIdToCancel = parameters.order_id;

    this.logger.debug(`[${pair}] Запуск handleCancelOrders...`);

    // Критично: Вся операция выполняется в ОДНОЙ транзакции
    await this.databaseService.executeInTransaction(async (client: PoolClient): Promise<void> => {
      if (orderIdToCancel) {
        // --- Сценарий A: Отмена КОНКРЕТНОГО ордера ---
        this.logger.debug(`[${pair}] Отмена конкретного ордера: ${orderIdToCancel}`);

        // Шаг 1: Отмена на Бирже
        await this.executionService.cancelOrderWithRetry(orderIdToCancel, pair);

        // Шаг 2: Атомарная очистка БД

        // 2.1. Удаляем из ActiveOrders
        await client.query(`DELETE FROM ActiveOrders WHERE exchange_order_id = $1`, [orderIdToCancel]);

        // 2.2. (Критично) Удаляем связанный TSL, если он был
        // Если мы отменили SL, TSL больше недействителен
        await client.query(`DELETE FROM TSL_State WHERE current_stop_order_id = $1`, [orderIdToCancel]);
      } else {
        // --- Сценарий Б: Отмена ВСЕХ ордеров по паре ---
        this.logger.debug(`[${pair}] Отмена ВСЕХ ордеров...`);

        // Шаг 1: Получить ВСЕ ID ордеров из БД
        // Мы должны сделать это *до* отмены, чтобы получить полный список
        const ordersResult = await client.query(
          `SELECT exchange_order_id FROM ActiveOrders WHERE pair = $1 FOR UPDATE`,
          [pair],
        );
        const orderIdsToCancel: string[] = ordersResult.rows.map((r) => r.exchange_order_id as string);

        if (orderIdsToCancel.length === 0) {
          this.logger.warn(`[${pair}] Нет ордеров для отмены.`);
          return;
        }

        // Шаг 2: Отмена ВСЕХ ордеров на Бирже
        for (const orderId of orderIdsToCancel) {
          // Отменяем по одному, используя Guaranteed service
          try {
            await this.executionService.cancelOrderWithRetry(orderId, pair);
          } catch (error) {
            // Логируем ошибку, но продолжаем отмену остальных ордеров
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.warn(`[${pair}] Не удалось отменить ордер ${orderId}: ${errorMessage}`);
          }
        }

        // Шаг 3: Атомарная очистка БД

        // 3.1. Удаляем ВСЕ ордера по паре
        await client.query(`DELETE FROM ActiveOrders WHERE pair = $1`, [pair]);

        // 3.2. Удаляем ВСЕ TSL по паре
        await client.query(`DELETE FROM TSL_State WHERE pair = $1`, [pair]);
      }

      this.logger.info(`[${pair}] Атомарная транзакция (CANCEL Orders) УСПЕШНА.`);
    });
  }
}
