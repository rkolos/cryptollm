import Decimal from 'decimal.js';
import { LoggingService } from './LoggingService.js';
import { ExchangeRulesService } from './ExchangeRulesService.js';
import { ValidationError } from '../errors/ValidationError.js';
import type { LLMDecision } from '../interfaces/ILLMTypes.js';
import type {
  AccountState,
  MarketData,
  StrategyContext,
  SanityCheckResult,
  CalculatedAmounts,
  DecimalValue,
} from '../interfaces/IValidatorTypes.js';
import type { IMarketRules } from '../interfaces/IMarketRules.js';
import type winston from 'winston';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DecimalConstructor = Decimal as any;

export class ValidatorService {
  private static instance: ValidatorService | undefined;
  private readonly logger: winston.Logger;
  private readonly exchangeRulesService: ExchangeRulesService;

  private constructor(exchangeRulesService: ExchangeRulesService) {
    this.logger = LoggingService.getInstance().getLogger('Validator');
    this.exchangeRulesService = exchangeRulesService;
  }

  public static getInstance(exchangeRulesService: ExchangeRulesService): ValidatorService {
    if (!ValidatorService.instance) {
      ValidatorService.instance = new ValidatorService(exchangeRulesService);
    }
    return ValidatorService.instance;
  }

  private toDecimal(value: number | DecimalValue | null | undefined): DecimalValue {
    if (value === null || value === undefined) {
      return new DecimalConstructor(0);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((value as any).e !== undefined) {
      return value as DecimalValue;
    }
    return new DecimalConstructor(String(value));
  }

  private _validateSanityAndLogicChecks(decision: LLMDecision, marketData: MarketData): SanityCheckResult {
    // Проверка обязательных полей
    if (!decision.pair) {
      throw new ValidationError('Decision must have a pair field');
    }

    if (!decision.action) {
      throw new ValidationError('Decision must have an action field');
    }

    // Проверка HOLD
    if (decision.action === 'HOLD') {
      throw new ValidationError('HOLD action detected', true);
    }

    const pair = decision.pair;
    const params = decision.parameters;

    // Проверки для OPEN_LONG и OPEN_SHORT
    if (decision.action === 'OPEN_LONG' || decision.action === 'OPEN_SHORT') {
      if (!params.type || (params.type !== 'market' && params.type !== 'limit')) {
        throw new ValidationError(`Invalid or missing type for ${decision.action}. Must be 'market' or 'limit'`);
      }

      if (params.type === 'limit' && (params.price === null || params.price === undefined)) {
        throw new ValidationError(`Price is required for limit order in ${decision.action}`);
      }

      if (!params.stop_loss_price || params.stop_loss_price === null) {
        throw new ValidationError(`stop_loss_price is required for ${decision.action}`);
      }

      if (
        params.trailing_stop_config &&
        params.trailing_stop_config !== null &&
        (!params.stop_loss_price || params.stop_loss_price === null)
      ) {
        throw new ValidationError('trailing_stop_config requires stop_loss_price as initial stop');
      }
    }

    // Проверки для MODIFY_POSITION
    if (decision.action === 'MODIFY_POSITION') {
      if (!params.new_stop_loss_price && !params.new_take_profit_price && !params.new_trailing_stop_config) {
        throw new ValidationError('MODIFY_POSITION must have at least one modification parameter');
      }
    }

    // Проверки для CLOSE_POSITION
    if (decision.action === 'CLOSE_POSITION') {
      if (params.amount_percent === null || params.amount_percent === undefined) {
        throw new ValidationError('amount_percent is required for CLOSE_POSITION');
      }

      const amountPercent = this.toDecimal(params.amount_percent);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const amountPercentDecimal = amountPercent as any;
      const zero = new DecimalConstructor(0);
      const hundred = new DecimalConstructor(100);

      if (amountPercentDecimal.lte(zero) || amountPercentDecimal.gt(hundred)) {
        throw new ValidationError(`amount_percent must be in range (0, 100], got ${params.amount_percent}`);
      }

      if (params.type === 'limit' && (params.price === null || params.price === undefined)) {
        throw new ValidationError('Price is required for limit close order');
      }
    }

    // Расчет entryPrice
    let entryPrice: DecimalValue;

    if (decision.action === 'OPEN_LONG' || decision.action === 'OPEN_SHORT') {
      if (params.type === 'limit' && params.price !== null && params.price !== undefined) {
        entryPrice = this.toDecimal(params.price);
      } else {
        entryPrice = this.toDecimal(marketData.current_price);
      }
    } else if (decision.action === 'MODIFY_POSITION') {
      // Для MODIFY используем текущую цену рынка (не используется для SL/TP проверок напрямую)
      entryPrice = this.toDecimal(marketData.current_price);
    } else {
      // Для CLOSE_POSITION и других действий
      if (params.type === 'limit' && params.price !== null && params.price !== undefined) {
        entryPrice = this.toDecimal(params.price);
      } else {
        entryPrice = this.toDecimal(marketData.current_price);
      }
    }

    // Проверки логики SL/TP для OPEN_LONG
    if (decision.action === 'OPEN_LONG') {
      const slPrice = this.toDecimal(params.stop_loss_price);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const slPriceDecimal = slPrice as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entryPriceDecimal = entryPrice as any;

      if (!slPriceDecimal.lt(entryPriceDecimal)) {
        throw new ValidationError(
          `Stop loss price (${slPriceDecimal}) must be strictly less than entry price (${entryPriceDecimal}) for LONG`,
        );
      }

      if (params.take_profit_price !== null && params.take_profit_price !== undefined) {
        const tpPrice = this.toDecimal(params.take_profit_price);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tpPriceDecimal = tpPrice as any;
        if (!tpPriceDecimal.gt(entryPriceDecimal)) {
          throw new ValidationError(
            `Take profit price (${tpPriceDecimal}) must be strictly greater than entry price (${entryPriceDecimal}) for LONG`,
          );
        }
      }

      // Проверка Limit Buy Price > Current Price (WARN только)
      if (params.type === 'limit' && params.price !== null && params.price !== undefined) {
        const limitPrice = this.toDecimal(params.price);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const limitPriceDecimal = limitPrice as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const currentPriceDecimal = this.toDecimal(marketData.current_price) as any;
        if (limitPriceDecimal.gt(currentPriceDecimal)) {
          this.logger.warn(
            `[${pair}] Limit Buy Price (${limitPriceDecimal}) is greater than Current Price (${currentPriceDecimal}). Order will execute as Market.`,
          );
        }
      }
    }

    // Проверки логики SL/TP для OPEN_SHORT
    if (decision.action === 'OPEN_SHORT') {
      const slPrice = this.toDecimal(params.stop_loss_price);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const slPriceDecimal = slPrice as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entryPriceDecimal = entryPrice as any;

      if (!slPriceDecimal.gt(entryPriceDecimal)) {
        throw new ValidationError(
          `Stop loss price (${slPriceDecimal}) must be strictly greater than entry price (${entryPriceDecimal}) for SHORT`,
        );
      }

      if (params.take_profit_price !== null && params.take_profit_price !== undefined) {
        const tpPrice = this.toDecimal(params.take_profit_price);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tpPriceDecimal = tpPrice as any;
        if (!tpPriceDecimal.lt(entryPriceDecimal)) {
          throw new ValidationError(
            `Take profit price (${tpPriceDecimal}) must be strictly less than entry price (${entryPriceDecimal}) for SHORT`,
          );
        }
      }

      // Проверка Limit Sell Price < Current Price (WARN только)
      if (params.type === 'limit' && params.price !== null && params.price !== undefined) {
        const limitPrice = this.toDecimal(params.price);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const limitPriceDecimal = limitPrice as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const currentPriceDecimal = this.toDecimal(marketData.current_price) as any;
        if (limitPriceDecimal.lt(currentPriceDecimal)) {
          this.logger.warn(
            `[${pair}] Limit Sell Price (${limitPriceDecimal}) is less than Current Price (${currentPriceDecimal}). Order will execute as Market.`,
          );
        }
      }
    }

    // Проверки для MODIFY_POSITION (если указаны новые значения)
    if (decision.action === 'MODIFY_POSITION') {
      // Находим существующую позицию для проверки side
      // Это будет реализовано в будущих задачах, сейчас только базовая проверка наличия new_stop_loss_price или new_take_profit_price
      // Детальная проверка будет в задачах 6.2-6.6
    }

    return {
      entryPrice,
    };
  }

  private _calculatePositionSizing(
    decision: LLMDecision,
    accountState: AccountState,
    strategyContext: StrategyContext,
    entryPrice: DecimalValue,
  ): CalculatedAmounts {
    const riskRules = strategyContext.risk_rules;

    // Определение % риска
    let riskPercentToUse: DecimalValue;
    if (decision.parameters.risk_percent !== null && decision.parameters.risk_percent !== undefined) {
      riskPercentToUse = this.toDecimal(decision.parameters.risk_percent);
    } else {
      riskPercentToUse = this.toDecimal(riskRules.default_risk_per_trade_percent);
    }

    // Проверка лимита риска
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const riskPercentDecimal = riskPercentToUse as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const maxAllowedDecimal = this.toDecimal(riskRules.max_allowed_risk_per_trade_percent) as any;
    if (riskPercentDecimal.gt(maxAllowedDecimal)) {
      throw new ValidationError(`Risk percent ${riskPercentDecimal} exceeds max allowed ${maxAllowedDecimal}`);
    }

    // Расчет USD@Risk
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const totalValueDecimal = accountState.total_portfolio_value_usdt as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hundred = new DecimalConstructor(100);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usdAtRisk = totalValueDecimal.mul(riskPercentDecimal).div(hundred) as DecimalValue;

    // Дистанция до стопа
    const stopPrice = this.toDecimal(decision.parameters.stop_loss_price);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stopPriceDecimal = stopPrice as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entryPriceDecimal = entryPrice as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const distanceToStop = entryPriceDecimal.sub(stopPriceDecimal).abs() as DecimalValue;

    // Проверка нулевой дистанции
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const distanceDecimal = distanceToStop as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const zero = new DecimalConstructor(0);
    if (distanceDecimal.isZero() || distanceDecimal.eq(zero)) {
      throw new ValidationError('Entry price and Stop Loss price are identical');
    }

    // Расчет "сырого" количества монеты
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usdAtRiskDecimal = usdAtRisk as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawAmountCoin = usdAtRiskDecimal.div(distanceDecimal) as DecimalValue;

    // Расчет "сырой" стоимости
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawAmountCoinDecimal = rawAmountCoin as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawAmountUsd = rawAmountCoinDecimal.mul(entryPriceDecimal) as DecimalValue;

    return {
      rawAmountCoin,
      rawAmountUsd,
      roundedAmountCoin: rawAmountCoin,
      roundedAmountUsd: rawAmountUsd,
      roundedEntryPrice: entryPrice,
      usdAtRisk,
      entryPrice,
    };
  }

  private _validateAndRoundPrecision(
    pair: string,
    rawAmountCoin: DecimalValue,
    rawEntryPrice: DecimalValue,
  ): { roundedAmountCoin: DecimalValue; roundedAmountUsd: DecimalValue; roundedEntryPrice: DecimalValue } {
    const rules = this.exchangeRulesService.getRules(pair);
    const precision = rules.precision;

    // Округляем amount (количество монеты) используя precision.amount
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawAmountCoinDecimal = rawAmountCoin as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const amountPrecisionDecimal = precision.amount as any;
    // Вычисляем множитель на основе precision (например, 0.00000001 -> множитель 10^8)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const amountMultiplier = new DecimalConstructor(10).pow(amountPrecisionDecimal.e || 0);
    // Округляем вниз до нужной точности
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roundedAmountCoin = rawAmountCoinDecimal.mul(amountMultiplier).floor().div(amountMultiplier) as DecimalValue;

    // Округляем price (цену входа) используя precision.price
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawEntryPriceDecimal = rawEntryPrice as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pricePrecisionDecimal = precision.price as any;
    // Вычисляем множитель на основе precision (например, 0.01 -> множитель 10^2)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const priceMultiplier = new DecimalConstructor(10).pow(pricePrecisionDecimal.e || 0);
    // Округляем вниз до нужной точности
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roundedEntryPrice = rawEntryPriceDecimal.mul(priceMultiplier).floor().div(priceMultiplier) as DecimalValue;

    // Пересчитываем amount_usd на основе округленных значений
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roundedAmountCoinDecimal = roundedAmountCoin as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roundedEntryPriceDecimal = roundedEntryPrice as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roundedAmountUsd = roundedAmountCoinDecimal.mul(roundedEntryPriceDecimal) as DecimalValue;

    this.logger.debug(
      `[${pair}] Округление: Qty ${rawAmountCoinDecimal.toFixed(12)} -> ${roundedAmountCoinDecimal.toString()}`,
    );
    this.logger.debug(
      `[${pair}] Округление: Price ${rawEntryPriceDecimal.toFixed(5)} -> ${roundedEntryPriceDecimal.toString()}`,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawAmountUsdDecimal = rawAmountCoinDecimal.mul(rawEntryPriceDecimal) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roundedAmountUsdDecimal = roundedAmountUsd as any;
    this.logger.debug(
      `[${pair}] Округление: USD Value ${rawAmountUsdDecimal.toFixed(5)} -> ${roundedAmountUsdDecimal.toFixed(5)}`,
    );

    // Проверка нулевых значений после округления
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const zero = new DecimalConstructor(0);
    if (
      roundedAmountCoinDecimal.isZero() ||
      roundedAmountCoinDecimal.eq(zero) ||
      roundedAmountUsdDecimal.isZero() ||
      roundedAmountUsdDecimal.eq(zero)
    ) {
      throw new ValidationError(
        `[${pair}] После округления размер позиции стал 0. Увеличьте риск или дистанцию до стопа.`,
      );
    }

    return { roundedAmountCoin, roundedAmountUsd, roundedEntryPrice };
  }

  private _validateExchangeAndBalanceRules(
    pair: string,
    roundedAmountUsd: DecimalValue,
    usdAtRisk: DecimalValue,
    accountState: AccountState,
  ): void {
    // Получаем правила биржи (minNotional)
    const rules = this.exchangeRulesService.getRules(pair);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const minNotionalDecimal = rules.minNotional as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roundedAmountUsdDecimal = roundedAmountUsd as any;

    // Проверка MinNotional
    if (roundedAmountUsdDecimal.lt(minNotionalDecimal)) {
      throw new ValidationError(
        `[${pair}] Рассчитанная стоимость ордера $${roundedAmountUsdDecimal.toFixed(2)} ` +
          `ниже биржевого минимума $${minNotionalDecimal.toString()}. ` +
          `Увеличьте % риска или дистанцию до стопа.`,
      );
    }

    // Проверка Баланса
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const availableBalanceDecimal = accountState.available_quote_balance as any;

    if (roundedAmountUsdDecimal.gt(availableBalanceDecimal)) {
      throw new ValidationError(
        `[${pair}] Рассчитанная стоимость ордера $${roundedAmountUsdDecimal.toFixed(2)} ` +
          `превышает доступный баланс $${availableBalanceDecimal.toFixed(2)}.`,
      );
    }

    this.logger.debug(
      `[${pair}] Exchange Rules Check: roundedAmountUsd=${roundedAmountUsdDecimal.toFixed(2)}, minNotional=${minNotionalDecimal.toString()}, availableBalance=${availableBalanceDecimal.toFixed(2)}`,
    );
  }

  private _validatePortfolioRisk(
    usdAtRisk: DecimalValue,
    accountState: AccountState,
    strategyContext: StrategyContext,
  ): void {
    const riskRules = strategyContext.risk_rules;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const totalValueDecimal = accountState.total_portfolio_value_usdt as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const zero = new DecimalConstructor(0);

    if (totalValueDecimal.isZero() || totalValueDecimal.eq(zero)) {
      this.logger.warn('Total portfolio value is 0. Skipping total portfolio risk check.');
      return;
    }

    // Суммируем риск существующих позиций
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let totalCurrentRiskUsd = new DecimalConstructor(0) as any;

    for (const pos of accountState.open_positions) {
      if (pos.average_entry_price && pos.stop_loss_price && pos.amount) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entryDecimal = pos.average_entry_price as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stopDecimal = pos.stop_loss_price as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const amountDecimal = pos.amount as any;

        // pos_risk_usd = abs(entry - stop) * amount
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const posRiskUsd = entryDecimal.sub(stopDecimal).abs().mul(amountDecimal) as any;
        totalCurrentRiskUsd = totalCurrentRiskUsd.add(posRiskUsd);
      }
    }

    // Рассчитываем % риска существующих позиций
    // total_current_risk_percent = (totalCurrentRiskUsd / total_value) * 100
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hundred = new DecimalConstructor(100);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const totalCurrentRiskPercent = totalCurrentRiskUsd.div(totalValueDecimal).mul(hundred) as any;

    // Рассчитываем % риска новой сделки
    // new_trade_risk_percent = (usd_at_risk / total_value) * 100
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usdAtRiskDecimal = usdAtRisk as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newTradeRiskPercent = usdAtRiskDecimal.div(totalValueDecimal).mul(hundred) as any;

    // Сравниваем сумму с лимитом
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const maxTotalRiskPercent = this.toDecimal(riskRules.max_total_portfolio_risk_percent) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const projectedTotalRiskPercent = totalCurrentRiskPercent.add(newTradeRiskPercent) as any;

    this.logger.debug(
      `Portfolio Risk Check: Current ${totalCurrentRiskPercent.toFixed(2)}% + New ${newTradeRiskPercent.toFixed(2)}% = Projected ${projectedTotalRiskPercent.toFixed(2)}% (Limit: ${maxTotalRiskPercent.toFixed(2)}%)`,
    );

    if (projectedTotalRiskPercent.gt(maxTotalRiskPercent)) {
      throw new ValidationError(
        `New trade (risk ${newTradeRiskPercent.toFixed(2)}%) + Open positions (risk ${totalCurrentRiskPercent.toFixed(2)}%) = ${projectedTotalRiskPercent.toFixed(2)}%. This exceeds max_total_portfolio_risk_percent (${maxTotalRiskPercent.toFixed(2)}%).`,
      );
    }
  }

  public validateDecision(
    decision: LLMDecision,
    accountState: AccountState,
    strategyContext: StrategyContext,
    marketData: MarketData,
    exchangeRules: IMarketRules,
  ): CalculatedAmounts {
    this.logger.debug(`Validating decision: ${decision.action} for ${decision.pair}`);

    // Проверка наличия позиции для CLOSE_POSITION
    if (decision.action === 'CLOSE_POSITION') {
      const positionExists = accountState.open_positions.some((pos) => pos.pair === decision.pair);
      if (!positionExists) {
        throw new ValidationError(`Cannot close position for ${decision.pair}: position not found in open_positions`);
      }
    }

    // Уровень 1: Sanity and Logic Checks
    const sanityResult = this._validateSanityAndLogicChecks(decision, marketData);

    // Уровень 2: Position Sizing (только для OPEN_LONG и OPEN_SHORT)
    if (decision.action === 'OPEN_LONG' || decision.action === 'OPEN_SHORT') {
      const calculatedAmounts = this._calculatePositionSizing(
        decision,
        accountState,
        strategyContext,
        sanityResult.entryPrice,
      );

      // Уровень 3: Portfolio Risk Check
      this._validatePortfolioRisk(calculatedAmounts.usdAtRisk, accountState, strategyContext);

      // Уровень 4: Precision Rounding
      const rounded = this._validateAndRoundPrecision(
        decision.pair,
        calculatedAmounts.rawAmountCoin,
        sanityResult.entryPrice,
      );

      // Уровень 4 (Часть 2): Exchange and Balance Rules
      this._validateExchangeAndBalanceRules(
        decision.pair,
        rounded.roundedAmountUsd,
        calculatedAmounts.usdAtRisk,
        accountState,
      );

      this.logger.info(`[${decision.pair}] Валидация Уровня 4 (Balance, MinNotional) пройдена.`);
      this.logger.info(`[${decision.pair}] ВАЛИДАЦИЯ УСПЕШНА. Ордер готов к исполнению.`);

      return {
        ...sanityResult,
        ...calculatedAmounts,
        ...rounded,
        entryPrice: sanityResult.entryPrice,
      };
    }

    // Для других действий возвращаем только результат Уровня 1
    return {
      ...sanityResult,
      rawAmountCoin: this.toDecimal(0),
      rawAmountUsd: this.toDecimal(0),
      roundedAmountCoin: this.toDecimal(0),
      roundedAmountUsd: this.toDecimal(0),
      roundedEntryPrice: this.toDecimal(0),
      usdAtRisk: this.toDecimal(0),
    };
  }
}
