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
import type { IExchangeService, IDecimalOrder } from '../interfaces/IExchangeService.js';
import { InsufficientFundsError } from '../errors/ExchangeErrors.js';
import { ValidationError } from '../errors/ValidationError.js';
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
  private readonly exchangeService: IExchangeService;
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
    exchangeService: IExchangeService,
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
    this.exchangeService = exchangeService;
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
    exchangeService: IExchangeService,
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
        exchangeService,
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

      // Проверяем, является ли это ошибкой превышения баланса для действий OPEN_LONG/OPEN_SHORT
      const isBalanceError =
        validationError instanceof ValidationError &&
        (errorMessage.includes('превышает доступный баланс') || errorMessage.includes('превышает')) &&
        (decision.action === 'OPEN_LONG' || decision.action === 'OPEN_SHORT');

      if (isBalanceError) {
        // ЛОКАЛЬНОЕ ВЫПОЛНЕНИЕ: Пересчитываем размер позиции на основе доступного баланса
        this.logger.info(
          `[${pair}] Попытка локального выполнения с пересчетом размера позиции на основе доступного баланса`,
        );

        try {
          // Получаем доступный баланс
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const availableBalanceDecimal = accountState.available_quote_balance as any;
          // Получаем процент баланса для локального выполнения из конфигурации (по умолчанию 10%)
          const localExecutionPercentValue = this.configService.getLocalExecutionBalancePercent();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const localExecutionPercent = new DecimalConstructor(localExecutionPercentValue);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const maxUsdForOrder = availableBalanceDecimal.mul(localExecutionPercent) as DecimalValue;

          // Получаем цену входа
          const entryPrice = decision.parameters.price || (marketData.current_price as DecimalValue);
          if (!entryPrice) {
            throw new Error(`[${pair}] Не удалось определить цену входа для локального выполнения`);
          }

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const entryPriceDecimal = entryPrice as any;

          // Получаем цену стоп-лосса или устанавливаем автоматически (10% от суммы покупки)
          let stopLossPrice = decision.parameters.stop_loss_price;
          if (!stopLossPrice) {
            // Автоматическая установка SL: 10% ниже цены входа для LONG, 10% выше для SHORT
            const slPercent = new DecimalConstructor(10); // 10%
            const hundred = new DecimalConstructor(100);
            if (decision.action === 'OPEN_LONG') {
              // Для LONG: SL = entryPrice * (1 - 0.10) = entryPrice * 0.90
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const slMultiplier = hundred.minus(slPercent).div(hundred) as any;
              stopLossPrice = entryPriceDecimal.mul(slMultiplier).toNumber();
            } else {
              // Для SHORT: SL = entryPrice * (1 + 0.10) = entryPrice * 1.10
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const slMultiplier = hundred.plus(slPercent).div(hundred) as any;
              stopLossPrice = entryPriceDecimal.mul(slMultiplier).toNumber();
            }
            this.logger.info(
              `[${pair}] Автоматическая установка SL: ${stopLossPrice} (10% от цены входа ${entryPriceDecimal.toString()})`,
            );
          }

          // Получаем цену тейк-профита или устанавливаем автоматически (10% от суммы покупки)
          let takeProfitPrice = decision.parameters.take_profit_price;
          if (!takeProfitPrice) {
            // Автоматическая установка TP: 10% выше цены входа для LONG, 10% ниже для SHORT
            const tpPercent = new DecimalConstructor(10); // 10%
            const hundred = new DecimalConstructor(100);
            if (decision.action === 'OPEN_LONG') {
              // Для LONG: TP = entryPrice * (1 + 0.10) = entryPrice * 1.10
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const tpMultiplier = hundred.plus(tpPercent).div(hundred) as any;
              takeProfitPrice = entryPriceDecimal.mul(tpMultiplier).toNumber();
            } else {
              // Для SHORT: TP = entryPrice * (1 - 0.10) = entryPrice * 0.90
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const tpMultiplier = hundred.minus(tpPercent).div(hundred) as any;
              takeProfitPrice = entryPriceDecimal.mul(tpMultiplier).toNumber();
            }
            this.logger.info(
              `[${pair}] Автоматическая установка TP: ${takeProfitPrice} (10% от цены входа ${entryPriceDecimal.toString()})`,
            );
          }

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const stopLossPriceDecimal = stopLossPrice as any;

          // Рассчитываем дистанцию до стопа (как в оригинальной формуле)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const distanceToStop = entryPriceDecimal.sub(stopLossPriceDecimal).abs() as DecimalValue;

          // Проверяем, что дистанция не нулевая
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const zero = new DecimalConstructor(0);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const distanceDecimal = distanceToStop as any;
          if (distanceDecimal.isZero() || distanceDecimal.eq(zero)) {
            throw new Error(`[${pair}] Дистанция до стопа равна нулю, локальное выполнение невозможно`);
          }

          // Рассчитываем максимальное количество монет на основе доступного баланса
          // Используем формулу: amountCoin = maxUsdForOrder / entryPrice
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const maxAmountCoin = maxUsdForOrder.div(entryPriceDecimal) as DecimalValue;

          // Получаем правила биржи для округления
          const exchangeRules = this.exchangeRulesService.getRules(pair);
          const precision = exchangeRules.precision;

          // Округляем amount по правилам биржи
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const maxAmountCoinDecimal = maxAmountCoin as any;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const amountPrecisionDecimal = precision.amount as any;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const amountPrecisionE = amountPrecisionDecimal.e !== undefined ? Math.abs(amountPrecisionDecimal.e) : 0;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const amountMultiplier = new DecimalConstructor(10).pow(amountPrecisionE);
          // Округляем вниз до нужной точности
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const roundedAmountCoin = maxAmountCoinDecimal
            .mul(amountMultiplier)
            .floor()
            .div(amountMultiplier) as DecimalValue;

          // Пересчитываем стоимость ордера
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const roundedAmountCoinDecimal = roundedAmountCoin as any;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const roundedAmountUsd = roundedAmountCoinDecimal.mul(entryPriceDecimal) as DecimalValue;

          // Рассчитываем реальный USD@Risk на основе пересчитанного размера
          // Формула: usdAtRisk = amountCoin * distanceToStop
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const recalculatedUsdAtRisk = roundedAmountCoinDecimal.mul(distanceDecimal) as DecimalValue;

          // Пересчитываем цены SL/TP пропорционально изменению размера позиции
          // Сохраняем процентное расстояние до SL/TP относительно цены входа
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const hundred = new DecimalConstructor(100);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const originalStopLossPriceDecimal = stopLossPrice as any;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const originalTakeProfitPriceDecimal = takeProfitPrice as any;

          // Рассчитываем процентное расстояние от цены входа до SL
          const slDistancePercentDecimal = entryPriceDecimal
            .sub(originalStopLossPriceDecimal)
            .abs()
            .div(entryPriceDecimal)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .mul(hundred) as any;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const slDistancePercent = slDistancePercentDecimal as any;

          // Рассчитываем процентное расстояние от цены входа до TP
          const tpDistancePercentDecimal = originalTakeProfitPriceDecimal
            .sub(entryPriceDecimal)
            .abs()
            .div(entryPriceDecimal)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .mul(hundred) as any;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const tpDistancePercent = tpDistancePercentDecimal as any;

          // Применяем процентное расстояние к новой цене входа (которая не изменилась, но для консистентности)
          // Для LONG: SL ниже entryPrice, TP выше entryPrice
          // Для SHORT: SL выше entryPrice, TP ниже entryPrice
          let recalculatedStopLossPrice: number;
          let recalculatedTakeProfitPrice: number;

          if (decision.action === 'OPEN_LONG') {
            // LONG: SL = entryPrice * (1 - slDistancePercent/100), TP = entryPrice * (1 + tpDistancePercent/100)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const slMultiplier = hundred.minus(slDistancePercent).div(hundred) as any;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const tpMultiplier = hundred.plus(tpDistancePercent).div(hundred) as any;
            recalculatedStopLossPrice = entryPriceDecimal.mul(slMultiplier).toNumber();
            recalculatedTakeProfitPrice = entryPriceDecimal.mul(tpMultiplier).toNumber();
          } else {
            // SHORT: SL = entryPrice * (1 + slDistancePercent/100), TP = entryPrice * (1 - tpDistancePercent/100)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const slMultiplier = hundred.plus(slDistancePercent).div(hundred) as any;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const tpMultiplier = hundred.minus(tpDistancePercent).div(hundred) as any;
            recalculatedStopLossPrice = entryPriceDecimal.mul(slMultiplier).toNumber();
            recalculatedTakeProfitPrice = entryPriceDecimal.mul(tpMultiplier).toNumber();
          }

          // Обновляем параметры решения с пересчитанными ценами SL/TP
          decision.parameters.stop_loss_price = recalculatedStopLossPrice;
          decision.parameters.take_profit_price = recalculatedTakeProfitPrice;

          this.logger.info(
            `[${pair}] Пересчет SL/TP: SL=${recalculatedStopLossPrice.toFixed(8)} (было ${originalStopLossPriceDecimal.toFixed(8)}), TP=${recalculatedTakeProfitPrice.toFixed(8)} (было ${originalTakeProfitPriceDecimal.toFixed(8)})`,
          );

          // Проверяем minNotional
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const minNotionalDecimal = exchangeRules.minNotional as any;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const roundedAmountUsdDecimal = roundedAmountUsd as any;

          if (roundedAmountUsdDecimal.lt(minNotionalDecimal)) {
            this.logger.warn(
              `[${pair}] После пересчета размер позиции $${roundedAmountUsdDecimal.toFixed(2)} ниже биржевого минимума $${minNotionalDecimal.toString()}. Локальное выполнение невозможно.`,
            );
            // Не можем выполнить локально, продолжаем стандартную обработку отклонения
          } else {
            // Проверяем, что размер больше нуля
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const zero = new DecimalConstructor(0);
            if (roundedAmountCoinDecimal.isZero() || roundedAmountCoinDecimal.eq(zero)) {
              this.logger.warn(`[${pair}] После пересчета размер позиции стал 0. Локальное выполнение невозможно.`);
              // Не можем выполнить локально, продолжаем стандартную обработку отклонения
            } else {
              // Создаем модифицированный validationResult для локального выполнения
              const localValidationResult: CalculatedAmounts = {
                rawAmountCoin: roundedAmountCoin,
                rawAmountUsd: roundedAmountUsd,
                roundedAmountCoin: roundedAmountCoin,
                roundedAmountUsd: roundedAmountUsd,
                roundedEntryPrice: entryPrice,
                usdAtRisk: recalculatedUsdAtRisk, // Реальный риск на основе дистанции до стопа
                entryPrice: entryPrice,
              };

              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const recalculatedUsdAtRiskDecimal = recalculatedUsdAtRisk as any;
              this.logger.info(
                `[${pair}] ✅ ЛОКАЛЬНОЕ ВЫПОЛНЕНИЕ: Пересчитанный размер позиции ${roundedAmountCoinDecimal.toString()} монет ($${roundedAmountUsdDecimal.toFixed(2)}), реальный риск: $${recalculatedUsdAtRiskDecimal.toFixed(2)}, SL=${decision.parameters.stop_loss_price?.toFixed(8)}, TP=${decision.parameters.take_profit_price?.toFixed(8)}`,
              );

              // Обновляем лог в БД с пометкой о локальном выполнении
              // Статус будет обновлен на 'accepted' после успешного выполнения
              await this._updateDecisionLog(
                llm_decision_log_id,
                'rejected_by_validator',
                `${errorMessage} [ЛОКАЛЬНОЕ ВЫПОЛНЕНИЕ: Пересчитан размер до $${roundedAmountUsdDecimal.toFixed(2)}]`,
                null,
              );

              // Отправляем уведомление о локальном выполнении
              this.notificationService.sendAlert(
                `[${pair}] ⚠️ ЛОКАЛЬНОЕ ВЫПОЛНЕНИЕ: Решение было отклонено валидатором из-за превышения баланса, но выполняется с пересчитанным размером $${roundedAmountUsdDecimal.toFixed(2)} (вместо запрошенного)`,
                false,
              );

              // Переходим к выполнению с пересчитанным размером
              validationResult = localValidationResult;
              // Выходим из catch блока и продолжаем выполнение
            }
          }
        } catch (localExecutionError) {
          const localErrorMessage =
            localExecutionError instanceof Error ? localExecutionError.message : String(localExecutionError);
          this.logger.error(`[${pair}] ОШИБКА ЛОКАЛЬНОГО ВЫПОЛНЕНИЯ: ${localErrorMessage}`);
          // Если локальное выполнение не удалось, продолжаем стандартную обработку отклонения
        }
      }

      // Если не было локального выполнения или оно не удалось, продолжаем стандартную обработку отклонения
      if (!validationResult) {
        // Обновляем лог в БД
        await this._updateDecisionLog(llm_decision_log_id, 'rejected_by_validator', errorMessage, null);

        // Отправляем уведомление
        this.notificationService.sendAlert(`[${pair}] РЕШЕНИЕ ОТКЛОНЕНО: ${errorMessage}`, false);

        return; // Остановка
      }
      // Если validationResult был установлен (локальное выполнение успешно), продолжаем выполнение
    }

    // --- Шаг 2: ИСПОЛНЕНИЕ ---
    try {
      // Передаем validationResult, т.к. там уже рассчитаны все суммы
      switch (decision.action) {
        case 'OPEN_LONG':
        case 'OPEN_SHORT':
          await this.handleOpenPosition(decision, validationResult!);
          // Обновляем кэш AccountStateService после открытия позиции
          try {
            await this.accountStateService.refreshNow();
            this.logger.debug(`[${pair}] Кэш AccountStateService обновлен после открытия позиции`);
          } catch (error) {
            this.logger.error(`[${pair}] Ошибка при обновлении кэша после открытия позиции:`, error);
            // Не критичная ошибка - продолжаем выполнение
          }
          break;

        case 'CLOSE_POSITION':
          await this.handleClosePosition(decision, validationResult!);
          // Обновляем кэш AccountStateService после закрытия позиции
          try {
            await this.accountStateService.refreshNow();
            this.logger.debug(`[${pair}] Кэш AccountStateService обновлен после закрытия позиции`);
          } catch (error) {
            this.logger.error(`[${pair}] Ошибка при обновлении кэша после закрытия позиции:`, error);
            // Не критичная ошибка - продолжаем выполнение
          }
          break;

        case 'MODIFY_POSITION':
          await this.handleModifyPosition(decision, validationResult!);
          // Обновляем кэш AccountStateService после модификации позиции
          try {
            await this.accountStateService.refreshNow();
            this.logger.debug(`[${pair}] Кэш AccountStateService обновлен после модификации позиции`);
          } catch (error) {
            this.logger.error(`[${pair}] Ошибка при обновлении кэша после модификации позиции:`, error);
            // Не критичная ошибка - продолжаем выполнение
          }
          break;

        case 'CANCEL_ORDERS':
          await this.handleCancelOrders(decision, validationResult!);
          // Обновляем кэш AccountStateService после отмены ордеров
          try {
            await this.accountStateService.refreshNow();
            this.logger.debug(`[${pair}] Кэш AccountStateService обновлен после отмены ордеров`);
          } catch (error) {
            this.logger.error(`[${pair}] Ошибка при обновлении кэша после отмены ордеров:`, error);
            // Не критичная ошибка - продолжаем выполнение
          }
          break;

        case 'HOLD':
          // Ничего не делаем
          break;

        default: {
          // Защита от неожиданных значений action (TypeScript должен гарантировать exhaustiveness)
          const exhaustiveCheck: never = decision.action;
          throw new Error(`[${pair}] Неизвестный action: ${String(exhaustiveCheck)}`);
        }
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
        // Для других действий отправляем обычное уведомление без обоснования
        this.notificationService.sendAlert(
          `[${pair}] ИСПОЛНЕНО: ${decision.action}`,
          false, // Не включать AccountState
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

    // Автоматическая установка SL/TP если модель не указала их (10% от суммы покупки)
    let finalStopLossPrice = stop_loss_price;
    let finalTakeProfitPrice = take_profit_price;

    if (!finalStopLossPrice || !finalTakeProfitPrice) {
      const slTpPercent = new DecimalConstructor(10); // 10%
      const hundred = new DecimalConstructor(100);

      if (!finalStopLossPrice) {
        // Автоматическая установка SL: 10% ниже цены входа для LONG, 10% выше для SHORT
        if (action === 'OPEN_LONG') {
          // Для LONG: SL = entryPrice * (1 - 0.10) = entryPrice * 0.90
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const slMultiplier = hundred.minus(slTpPercent).div(hundred) as any;
          finalStopLossPrice = entryPriceDecimal.mul(slMultiplier).toNumber();
        } else {
          // Для SHORT: SL = entryPrice * (1 + 0.10) = entryPrice * 1.10
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const slMultiplier = hundred.plus(slTpPercent).div(hundred) as any;
          finalStopLossPrice = entryPriceDecimal.mul(slMultiplier).toNumber();
        }
        this.logger.info(
          `[${pair}] Автоматическая установка SL: ${finalStopLossPrice?.toFixed(8) || 'N/A'} (10% от цены входа ${entryPriceDecimal.toString()})`,
        );
      }

      if (!finalTakeProfitPrice) {
        // Автоматическая установка TP: 10% выше цены входа для LONG, 10% ниже для SHORT
        if (action === 'OPEN_LONG') {
          // Для LONG: TP = entryPrice * (1 + 0.10) = entryPrice * 1.10
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const tpMultiplier = hundred.plus(slTpPercent).div(hundred) as any;
          finalTakeProfitPrice = entryPriceDecimal.mul(tpMultiplier).toNumber();
        } else {
          // Для SHORT: TP = entryPrice * (1 - 0.10) = entryPrice * 0.90
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const tpMultiplier = hundred.minus(slTpPercent).div(hundred) as any;
          finalTakeProfitPrice = entryPriceDecimal.mul(tpMultiplier).toNumber();
        }
        this.logger.info(
          `[${pair}] Автоматическая установка TP: ${finalTakeProfitPrice?.toFixed(8) || 'N/A'} (10% от цены входа ${entryPriceDecimal.toString()})`,
        );
      }

      // Обновляем параметры решения для сохранения в БД
      // Проверяем, что значения установлены (они должны быть установлены после блоков выше)
      if (finalStopLossPrice === null || finalStopLossPrice === undefined) {
        throw new Error(
          `[${pair}] КРИТИЧЕСКАЯ ОШИБКА: finalStopLossPrice не установлен после автоматической установки`,
        );
      }
      if (finalTakeProfitPrice === null || finalTakeProfitPrice === undefined) {
        throw new Error(
          `[${pair}] КРИТИЧЕСКАЯ ОШИБКА: finalTakeProfitPrice не установлен после автоматической установки`,
        );
      }

      decision.parameters.stop_loss_price = finalStopLossPrice;
      decision.parameters.take_profit_price = finalTakeProfitPrice;
    }

    // --- Шаг 2: Создание SL/TP ордеров ДО транзакции БД ---
    let slOrder: IDecimalOrder | null = null;
    let tpOrder: IDecimalOrder | null = null;

    try {
      // Создаем SL
      if (finalStopLossPrice !== null && finalStopLossPrice !== undefined) {
        try {
          const slPriceDecimal = new DecimalConstructor(finalStopLossPrice.toString());
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
        } catch (slError) {
          // Если не удалось создать SL из-за недостатка средств, логируем предупреждение
          const slErrorMessage = slError instanceof Error ? slError.message : String(slError);
          // Расширенная проверка различных вариантов ошибок недостатка средств
          const isInsufficientFundsError =
            slErrorMessage.includes('Insufficient funds') ||
            slErrorMessage.includes('insufficient balance') ||
            slErrorMessage.includes('InsufficientFundsError') ||
            (slError instanceof Error && slError.name === 'InsufficientFundsError');

          if (isInsufficientFundsError) {
            this.logger.warn(
              `[${pair}] Не удалось создать SL ордер из-за недостатка средств: ${slErrorMessage}. Продолжаем без SL.`,
            );
            slOrder = null;
          } else {
            throw slError; // Пробрасываем другие ошибки
          }
        }
      }

      // Создаем TP
      if (finalTakeProfitPrice !== null && finalTakeProfitPrice !== undefined) {
        try {
          const tpPriceDecimal = new DecimalConstructor(finalTakeProfitPrice.toString());

          tpOrder = await this.executionService.createOrderWithRetry(
            pair,
            'limit',
            oppositeSide,
            amountDecimal,
            tpPriceDecimal,
          );
          this.logger.debug(`[${pair}] TP ордер ${tpOrder.id} создан на бирже.`);
        } catch (tpError) {
          // Если не удалось создать TP из-за недостатка средств, логируем предупреждение
          const tpErrorMessage = tpError instanceof Error ? tpError.message : String(tpError);
          // Расширенная проверка различных вариантов ошибок недостатка средств
          const isInsufficientFundsError =
            tpErrorMessage.includes('Insufficient funds') ||
            tpErrorMessage.includes('insufficient balance') ||
            tpErrorMessage.includes('InsufficientFundsError') ||
            (tpError instanceof Error && tpError.name === 'InsufficientFundsError');

          if (isInsufficientFundsError) {
            this.logger.warn(
              `[${pair}] Не удалось создать TP ордер из-за недостатка средств: ${tpErrorMessage}. Продолжаем без TP.`,
            );
            tpOrder = null;
          } else {
            throw tpError; // Пробрасываем другие ошибки
          }
        }
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
              finalStopLossPrice !== null && finalStopLossPrice !== undefined ? finalStopLossPrice : null,
            ],
          );

          // 2. Сохранить Историю (вход)
          // Для exchange_trade_id используем order.id + timestamp + UUID для гарантированной уникальности
          const { randomUUID } = await import('crypto');
          const uniqueSuffix = randomUUID().substring(0, 8);
          const exchangeTradeId = `${marketOrder.id}-${realTimestamp}-${uniqueSuffix}`;
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
            const slPrice = slOrderAny.price || slOrderAny.stopPrice || finalStopLossPrice;
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
            const tpPrice = tpOrderAny.price || finalTakeProfitPrice;
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
            const slPrice = slOrderAny.price || slOrderAny.stopPrice || finalStopLossPrice;
            const slPriceDecimal = new DecimalConstructor(slPrice.toString());

            await client.query(
              `INSERT INTO TSL_State (
                pair, current_stop_price, current_stop_order_id, price_seen, rule_config_json
              ) VALUES ($1, $2, $3, $4, $5)`,
              [
                pair,
                slPriceDecimal.toNumber(),
                slOrder.id,
                entryPriceDecimal.toNumber(), // Начальная price_seen = цена входа (для LONG будет обновляться вверх, для SHORT вниз)
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
    const { pair, parameters } = decision;
    const { amount_percent } = parameters;

    this.logger.debug(`[${pair}] Запуск _handleCloseMarketPosition.`);

    // Критично: Вся операция выполняется в ОДНОЙ транзакции
    await this.databaseService.executeInTransaction(async (client: PoolClient): Promise<void> => {
      // --- Шаг 1: Получить Позицию из БД (и заблокировать строку) ---
      // Мы должны получить точное кол-во, сторону, цену входа и комиссию ПЕРЕД закрытием
      const positionResult = await client.query(
        `SELECT amount, side, average_entry_price, total_fee_cost FROM ActivePositions WHERE pair = $1 FOR UPDATE`,
        [pair],
      );

      if (!positionResult.rowCount || positionResult.rowCount === 0) {
        // Это может случиться, если SL сработал за мгновение до этого
        this.logger.warn(
          `[${pair}] Попытка закрыть позицию, которая уже не существует в БД. (Возможно, SL/TP сработал?)`,
        );
        throw new Error(`[${pair}] (ОШИБКА СИНХРОНИЗАЦИИ) Позиция для закрытия не найдена в ActivePositions.`);
      }

      const currentPosition = positionResult.rows[0];
      const fullPositionAmountDecimal = new DecimalConstructor(currentPosition.amount.toString());
      const positionSide = currentPosition.side as 'long' | 'short';

      // --- Шаг 1.5: Расчет объема для закрытия на основе amount_percent ---
      const amountPercentDecimal = new DecimalConstructor(amount_percent!.toString());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fullAmountDecimal = fullPositionAmountDecimal as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const percentDecimal = amountPercentDecimal as any;
      const hundred = new DecimalConstructor(100);
      // Рассчитываем объем для закрытия: position_amount * amount_percent / 100
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const closeAmountDecimal = fullAmountDecimal.mul(percentDecimal).div(hundred) as any as DecimalValue;

      // Определяем ордер на закрытие
      const closeSide: 'buy' | 'sell' = positionSide === 'long' ? 'sell' : 'buy';

      this.logger.debug(
        `[${pair}] Закрытие ${positionSide} позиции. Объем позиции: ${fullPositionAmountDecimal.toString()}, Закрывается: ${closeAmountDecimal.toString()} (${amount_percent}%), Сторона ордера: ${closeSide}.`,
      );

      // --- Шаг 2: Отменяем все открытые ордера для данной пары ---
      // Это необходимо для спотового трейдинга, где стоп-лосс ордера блокируют токены
      try {
        const openOrders = await this.exchangeService.fetchOpenOrders(pair);
        if (openOrders.length > 0) {
          this.logger.info(
            `[${pair}] Найдено ${openOrders.length} открытых ордеров. Отменяем их перед закрытием позиции...`,
          );
          const cancelPromises = openOrders.map((order: IDecimalOrder) =>
            this.executionService.cancelOrderWithRetry(order.id, pair).catch((cancelError) => {
              this.logger.warn(`[${pair}] Не удалось отменить ордер ${order.id}:`, cancelError);
            }),
          );
          await Promise.all(cancelPromises);
          this.logger.info(`[${pair}] Все открытые ордера отменены.`);
        }
      } catch (error) {
        this.logger.error(`[${pair}] Ошибка при отмене открытых ордеров:`, error);
        // Продолжаем выполнение, так как это не критично
      }

      // --- Шаг 3: Создание Market ордера на Закрытие ---
      const closeMarketOrder = await this.executionService.createOrderWithRetry(
        pair,
        'market',
        closeSide,
        closeAmountDecimal,
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

      // --- Расчет Realized PnL (с учетом частичного закрытия) ---
      const entryPriceDecimal = new DecimalConstructor(currentPosition.average_entry_price.toString());
      const fullEntryFeeCostDecimal = new DecimalConstructor(currentPosition.total_fee_cost?.toString() || '0');

      // Для частичного закрытия: пропорционально распределяем комиссию входа
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fullAmountDecimalForFeeCalc = fullPositionAmountDecimal as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const closeAmountDecimalForCalc = amountDecimal as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fullEntryFeeDecimal = fullEntryFeeCostDecimal as any;

      // Проверка деления на ноль (защита от edge cases)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const zero = new DecimalConstructor(0);
      if (fullAmountDecimalForFeeCalc.isZero() || fullAmountDecimalForFeeCalc.eq(zero)) {
        throw new Error(
          `[${pair}] КРИТИЧЕСКАЯ ОШИБКА: Размер позиции равен нулю. Невозможно рассчитать пропорциональную комиссию.`,
        );
      }

      // Пропорциональная доля комиссии входа: (close_amount / full_amount) * entry_fee
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proportionalEntryFeeResult = closeAmountDecimalForCalc
        .div(fullAmountDecimalForFeeCalc)
        .mul(fullEntryFeeDecimal);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proportionalEntryFee = proportionalEntryFeeResult as any as DecimalValue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const closeFeeDecimal = closeFeeCostDecimal as any;

      let realizedPnlUsd: DecimalValue;
      if (positionSide === 'long') {
        // Для LONG: PnL = (close_price - entry_price) * amount - proportional_entry_fee - close_fee
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const priceDiffDecimal = (closePriceDecimal as any).minus(entryPriceDecimal);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const amountDecimalForCalc = amountDecimal as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const grossPnl = priceDiffDecimal.mul(amountDecimalForCalc);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const totalFees = proportionalEntryFee.plus(closeFeeDecimal);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        realizedPnlUsd = grossPnl.minus(totalFees) as DecimalValue;
      } else {
        // Для SHORT: PnL = (entry_price - close_price) * amount - proportional_entry_fee - close_fee
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const priceDiffDecimal = (entryPriceDecimal as any).minus(closePriceDecimal);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const amountDecimalForCalc = amountDecimal as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const grossPnl = priceDiffDecimal.mul(amountDecimalForCalc);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const totalFees = proportionalEntryFee.plus(closeFeeDecimal);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        realizedPnlUsd = grossPnl.minus(totalFees) as DecimalValue;
      }

      // Логируем PnL
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const realizedPnlDecimal = realizedPnlUsd as any;
      this.logger.info(
        `[${pair}] Realized PnL: ${realizedPnlDecimal.toFixed(2)} USDT (Entry: ${entryPriceDecimal.toString()}, Close: ${closePriceDecimal.toString()}, Amount: ${amountDecimal.toString()})`,
      );

      // --- Шаг 4: Определяем, полное или частичное закрытие ---
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const amountDecimalForCheck = amountDecimal as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isFullClose = amountDecimalForCheck.gte(fullAmountDecimalForFeeCalc) || amountPercentDecimal.gte(hundred);

      // --- Шаг 5: Атомарное обновление БД ---
      if (isFullClose) {
        // Полное закрытие: удаляем позицию и все связанные данные
        // 1. Удалить Позицию
        await client.query(`DELETE FROM ActivePositions WHERE pair = $1`, [pair]);

        // 2. Удалить ВСЕ связанные ордера (SL, TP, Limit)
        await client.query(`DELETE FROM ActiveOrders WHERE pair = $1`, [pair]);

        // 3. Удалить ВСЕ связанные TSL
        await client.query(`DELETE FROM TSL_State WHERE pair = $1`, [pair]);
      } else {
        // Частичное закрытие: обновляем позицию и пропорционально распределяем комиссии
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const remainingAmount = fullAmountDecimalForFeeCalc.minus(amountDecimalForCheck) as any as DecimalValue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const remainingEntryFee = fullEntryFeeDecimal.minus(proportionalEntryFee) as any as DecimalValue;

        // 1. Обновить Позицию (уменьшаем amount и fee_cost)
        await client.query(`UPDATE ActivePositions SET amount = $1, total_fee_cost = $2 WHERE pair = $3`, [
          remainingAmount.toString(),
          remainingEntryFee.toString(),
          pair,
        ]);

        // 2. Обновить размеры связанных ордеров (SL, TP) пропорционально
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const remainingAmountDecimal = remainingAmount as any;
        await client.query(
          `UPDATE ActiveOrders SET amount = $1 WHERE pair = $2 AND type IN ('stop_loss_limit', 'take_profit_limit')`,
          [remainingAmountDecimal.toString(), pair],
        );

        // 3. TSL остается активным (price_seen обновляется автоматически при тиках)
      }

      // 4. Сохранить Историю (выход) с calculated PnL
      // Для exchange_trade_id используем order.id + timestamp + случайный UUID для гарантированной уникальности
      const { randomUUID } = await import('crypto');
      const uniqueSuffix = randomUUID().substring(0, 8);
      const exchangeTradeId = `${closeMarketOrder.id}-${realTimestamp}-${uniqueSuffix}`;
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

      if (!positionResult.rowCount || positionResult.rowCount === 0) {
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

    if (!positionCheckResult.rowCount || positionCheckResult.rowCount === 0) {
      this.logger.warn(`[${pair}] Попытка MODIFY_POSITION для несуществующей позиции.`);
      throw new Error(`[${pair}] (ОШИБКА СИНХРОНИЗАЦИИ) Позиция для MODIFY не найдена в ActivePositions.`);
    }

    const pos = positionCheckResult.rows[0];
    const oppositeSide: 'buy' | 'sell' = pos.side === 'long' ? 'sell' : 'buy';
    const positionAmountDecimal = new DecimalConstructor(pos.amount.toString());
    let newSlOrder: IDecimalOrder | null = null;
    let newTpOrder: IDecimalOrder | null = null;
    const ordersToCancel: string[] = [];

    // Объявляем oldSlId вне блока if для использования в catch
    const oldSlId = pos.current_tsl_sl_id || pos.current_sl_id;
    let oldSlPriceForRollback: DecimalValue | null = null;
    let oldSlAmountForRollback: DecimalValue | null = null;

    // --- Шаг 2: Обработка нового Stop Loss (если запрошен) ДО транзакции БД ---
    if (new_stop_loss_price !== null && new_stop_loss_price !== undefined) {
      this.logger.debug(`[${pair}] Модификация SL. Новая цена: ${new_stop_loss_price}`);

      // 2.1. Отмена старого SL на бирже (сохраняем данные для возможного rollback)
      if (oldSlId) {
        try {
          // ВАЖНО: Получаем данные старого SL из БД ПЕРЕД отменой (для rollback)
          const oldSlOrderResult = await this.databaseService.query(
            `SELECT price, amount FROM ActiveOrders WHERE exchange_order_id = $1`,
            [oldSlId],
          );

          if (oldSlOrderResult.rowCount && oldSlOrderResult.rowCount > 0) {
            const oldSlData = oldSlOrderResult.rows[0];
            oldSlPriceForRollback = new DecimalConstructor(oldSlData.price.toString());
            oldSlAmountForRollback = new DecimalConstructor(oldSlData.amount.toString());
            this.logger.debug(
              `[${pair}] Сохранены параметры старого SL для rollback: price=${oldSlPriceForRollback.toString()}, amount=${oldSlAmountForRollback.toString()}`,
            );
          }

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
        // КРИТИЧЕСКИЙ СБОЙ: новый SL не создан, но старый уже отменен
        // Попытка восстановить старый SL (rollback)
        this.logger.error(
          `[${pair}] Не удалось создать новый SL ордер. Попытка восстановить старый SL...`,
          createError,
        );

        if (oldSlId && oldSlPriceForRollback && oldSlAmountForRollback) {
          try {
            const oldSlPriceParams = { stopPrice: oldSlPriceForRollback.toNumber() };

            // Пытаемся восстановить старый SL (может не сработать, если ордер уже исполнен на бирже)
            await this.executionService
              .createOrderWithRetry(
                pair,
                'stop_loss_limit',
                oppositeSide,
                oldSlAmountForRollback,
                oldSlPriceForRollback,
                oldSlPriceParams,
              )
              .then(() => {
                this.logger.warn(
                  `[${pair}] Старый SL ордер восстановлен. Позиция снова под защитой. Но MODIFY_POSITION провалился.`,
                );
              })
              .catch((rollbackError) => {
                this.logger.error(
                  `[${pair}] Не удалось восстановить старый SL ордер (возможно, он уже исполнен):`,
                  rollbackError,
                );
                this.logger.error(`[${pair}] КРИТИЧЕСКАЯ СИТУАЦИЯ: Позиция может остаться без защиты!`);
              });
          } catch (rollbackError) {
            this.logger.error(`[${pair}] КРИТИЧЕСКАЯ ОШИБКА при попытке rollback старого SL:`, rollbackError);
          }
        } else {
          this.logger.error(`[${pair}] Невозможно выполнить rollback: данные старого SL не были сохранены.`);
        }

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

        if (!queryResult.rowCount || queryResult.rowCount === 0) {
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

    // КРИТИЧНО: Отмена на бирже должна происходить ДО транзакции БД
    // Если отмена провалится, БД операция не начнется
    // Если отмена пройдет, а БД операция упадет - отмененные ордера будут "призраками" в БД

    if (orderIdToCancel) {
      // --- Сценарий A: Отмена КОНКРЕТНОГО ордера ---
      this.logger.debug(`[${pair}] Отмена конкретного ордера: ${orderIdToCancel}`);

      // Шаг 1: Отмена на Бирже (ДО транзакции БД)
      try {
        await this.executionService.cancelOrderWithRetry(orderIdToCancel, pair);
        this.logger.debug(`[${pair}] Ордер ${orderIdToCancel} успешно отменен на бирже.`);
      } catch (error) {
        // Если отмена на бирже провалилась, не обновляем БД (ордер может быть уже исполнен)
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `[${pair}] Не удалось отменить ордер ${orderIdToCancel} на бирже (возможно, уже исполнен): ${errorMessage}`,
        );
        // Продолжаем: возможно ордер уже исполнен или не существует, все равно удалим из БД
      }

      // Шаг 2: Атомарная очистка БД (даже если отмена на бирже провалилась - удаляем "призрак")
      await this.databaseService.executeInTransaction(async (client: PoolClient): Promise<void> => {
        // 2.1. Удаляем из ActiveOrders
        await client.query(`DELETE FROM ActiveOrders WHERE exchange_order_id = $1`, [orderIdToCancel]);

        // 2.2. (Критично) Удаляем связанный TSL, если он был
        // Если мы отменили SL, TSL больше недействителен
        await client.query(`DELETE FROM TSL_State WHERE current_stop_order_id = $1`, [orderIdToCancel]);
      });

      this.logger.info(`[${pair}] Атомарная транзакция (CANCEL Orders) УСПЕШНА.`);
    } else {
      // --- Сценарий Б: Отмена ВСЕХ ордеров по паре ---
      this.logger.debug(`[${pair}] Отмена ВСЕХ ордеров...`);

      // Шаг 1: Получить ВСЕ ID ордеров из БД (перед отменой на бирже)
      const ordersResult = await this.databaseService.query(
        `SELECT exchange_order_id FROM ActiveOrders WHERE pair = $1`,
        [pair],
      );
      const orderIdsToCancel: string[] = ordersResult.rows.map((r) => r.exchange_order_id as string);

      if (orderIdsToCancel.length === 0) {
        this.logger.warn(`[${pair}] Нет ордеров для отмены.`);
        return;
      }

      // Шаг 2: Отмена ВСЕХ ордеров на Бирже (ДО транзакции БД)
      const successfullyCancelledIds: string[] = [];
      const failedToCancelIds: string[] = [];

      for (const orderId of orderIdsToCancel) {
        try {
          await this.executionService.cancelOrderWithRetry(orderId, pair);
          successfullyCancelledIds.push(orderId);
          this.logger.debug(`[${pair}] Ордер ${orderId} успешно отменен на бирже.`);
        } catch (error) {
          // Логируем ошибку, но продолжаем отмену остальных ордеров
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.logger.warn(`[${pair}] Не удалось отменить ордер ${orderId} на бирже: ${errorMessage}`);
          failedToCancelIds.push(orderId);
        }
      }

      // Шаг 3: Атомарная очистка БД (удаляем все ордера, включая те, что не удалось отменить на бирже)
      // Если ордер не был отменен на бирже (ошибка), но был удален из БД - SyncEngine восстановит состояние
      await this.databaseService.executeInTransaction(async (client: PoolClient): Promise<void> => {
        // 3.1. Удаляем ВСЕ ордера по паре (и успешно отмененные, и неотмененные - они могут быть "призраками")
        await client.query(`DELETE FROM ActiveOrders WHERE pair = $1`, [pair]);

        // 3.2. Удаляем ВСЕ TSL по паре
        await client.query(`DELETE FROM TSL_State WHERE pair = $1`, [pair]);
      });

      // Логируем результаты
      if (failedToCancelIds.length > 0) {
        this.logger.warn(
          `[${pair}] Часть ордеров не была отменена на бирже (${failedToCancelIds.length} из ${orderIdsToCancel.length}), но удалены из БД. SyncEngine восстановит состояние при следующей сверке.`,
        );
      }

      this.logger.info(
        `[${pair}] Атомарная транзакция (CANCEL Orders) УСПЕШНА. Успешно отменено: ${successfullyCancelledIds.length}, не удалось: ${failedToCancelIds.length}.`,
      );
    }
  }
}
