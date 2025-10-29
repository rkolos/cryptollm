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

  public validateDecision(
    decision: LLMDecision,
    accountState: AccountState,
    strategyContext: StrategyContext,
    marketData: MarketData,
    exchangeRules: IMarketRules,
  ): SanityCheckResult {
    this.logger.debug(`Validating decision: ${decision.action} for ${decision.pair}`);

    // Проверка наличия позиции для CLOSE_POSITION
    if (decision.action === 'CLOSE_POSITION') {
      const positionExists = accountState.open_positions.some((pos) => pos.pair === decision.pair);
      if (!positionExists) {
        throw new ValidationError(`Cannot close position for ${decision.pair}: position not found in open_positions`);
      }
    }

    // Уровень 1: Sanity and Logic Checks
    return this._validateSanityAndLogicChecks(decision, marketData);
  }
}
