import Decimal from 'decimal.js';
import { ConfigService } from './ConfigService.js';
import { DatabaseService } from './DatabaseService.js';
import { EventBusService, type TradeExecutedEvent } from './EventBusService.js';
import { LoggingService } from './LoggingService.js';
import type { IExchangeService } from '../interfaces/IExchangeService.js';
import type {
  AccountState,
  OpenPosition,
  AssetBalance,
  DecimalValue,
  TSLRule,
  TSLState,
  TSLRuleConfig,
} from '../interfaces/IValidatorTypes.js';
import type { LLMTriggerCondition } from '../interfaces/ILLMTypes.js';
import type winston from 'winston';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DecimalConstructor = Decimal as any;

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

export class AccountStateService {
  private static instance: AccountStateService | undefined;
  private readonly logger: winston.Logger;
  private readonly configService: ConfigService;
  private readonly exchangeService: IExchangeService;
  private readonly databaseService: DatabaseService;
  private readonly eventBus: EventBusService;

  // In-memory кэш
  private accountStateCache: AccountState = {
    total_portfolio_value_usdt: new DecimalConstructor(0) as DecimalValue,
    available_quote_balance: new DecimalConstructor(0) as DecimalValue,
    assets: [],
    open_positions: [],
    open_orders: [],
    tslRules: new Map<string, TSLRule>(),
    llmTriggers: new Map<string, LLMTriggerCondition[]>(),
  };
  private refreshPromise: Promise<void> | null = null;

  private constructor(
    configService: ConfigService,
    exchangeService: IExchangeService,
    databaseService: DatabaseService,
    eventBus: EventBusService,
  ) {
    this.configService = configService;
    this.exchangeService = exchangeService;
    this.databaseService = databaseService;
    this.eventBus = eventBus;
    this.logger = LoggingService.getInstance().getLogger('AccountState');
    this.logger.info('AccountStateService initialized.');

    // Подписка на событие trade_executed
    this.eventBus.on('trade_executed', (event: TradeExecutedEvent) => {
      this.handleTradeExecuted(event);
    });
  }

  public static getInstance(
    configService: ConfigService,
    exchangeService: IExchangeService,
    databaseService: DatabaseService,
    eventBus: EventBusService,
  ): AccountStateService {
    if (!AccountStateService.instance) {
      AccountStateService.instance = new AccountStateService(configService, exchangeService, databaseService, eventBus);
    }
    return AccountStateService.instance;
  }

  private toDecimal(value: string | number | DecimalValue | null | undefined): DecimalValue {
    if (value === null || value === undefined) {
      return new DecimalConstructor(0) as DecimalValue;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const valueAny = value as any;
    if (valueAny && typeof valueAny.e === 'number' && typeof valueAny.toNumber === 'function') {
      // Это уже DecimalValue
      return value as DecimalValue;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new DecimalConstructor(String(value)) as DecimalValue;
  }

  private handleTradeExecuted(event: TradeExecutedEvent): void {
    this.logger.debug(`Trade executed event received for pair: ${event.pair}, refreshing account state...`);
    // Fire-and-forget: не используем await, чтобы не блокировать поток Worker
    this.refreshNow().catch((error) => {
      this.logger.error(`Error refreshing account state after trade_executed:`, error);
    });
  }

  /**
   * Синхронный метод для получения последнего состояния портфеля из кэша
   */
  public getAccountState(): AccountState {
    return this.accountStateCache;
  }

  /**
   * Принудительно обновляет кэш состояния портфеля из всех источников
   */
  public async refreshNow(): Promise<void> {
    // Блокировка: если уже выполняется обновление, возвращаем существующий Promise
    if (this.refreshPromise) {
      this.logger.debug('Account state refresh already in progress, waiting...');
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      try {
        this.logger.debug('Refreshing account state...');

        // Параллельный запрос данных из всех источников
        const [balance, dbPositionsResult, dbOrdersResult, dbTslStateResult, dbLlmTriggersResult] = await Promise.all([
          this.exchangeService.fetchBalance(),
          this.databaseService.query('SELECT * FROM ActivePositions'),
          this.databaseService.query('SELECT * FROM ActiveOrders WHERE status = $1', ['open']),
          this.databaseService.query('SELECT * FROM TSL_State'),
          this.databaseService.query('SELECT * FROM LLM_Triggers'),
        ]);

        // Парсинг баланса
        const quoteCurrency = 'USDT'; // Для V1 используем фиксированный USDT
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const quoteBalance = balance[quoteCurrency] as any;
        const availableQuoteBalance = quoteBalance
          ? this.toDecimal(quoteBalance.free)
          : (new DecimalConstructor(0) as DecimalValue);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const totalQuoteBalance = quoteBalance
          ? this.toDecimal(quoteBalance.total)
          : (new DecimalConstructor(0) as DecimalValue);

        // Формирование массива assets (только активы с total > 0, исключая quoteCurrency)
        const assets: AssetBalance[] = [];
        for (const [currency, funds] of Object.entries(balance)) {
          if (
            currency === quoteCurrency ||
            currency === 'info' ||
            currency === 'free' ||
            currency === 'used' ||
            currency === 'total'
          ) {
            continue;
          }

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const currencyFunds = funds as any;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const totalDecimal = this.toDecimal(currencyFunds.total) as any;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const zero = new DecimalConstructor(0);
          if (totalDecimal.gt(zero)) {
            assets.push({
              asset: currency,
              total: currencyFunds.total,
              available: currencyFunds.free,
            });
          }
        }

        // Парсинг позиций из БД
        const openPositions: OpenPosition[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const positionsRows = dbPositionsResult.rows as any[];
        for (const row of positionsRows) {
          const dbPos = row as DbPosition;
          openPositions.push({
            pair: dbPos.pair,
            side: dbPos.side,
            amount: this.toDecimal(dbPos.amount),
            average_entry_price: this.toDecimal(dbPos.average_entry_price),
            stop_loss_price: dbPos.stop_loss_price ? this.toDecimal(dbPos.stop_loss_price) : null,
          });
        }

        // Парсинг ордеров из БД
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ordersRows = dbOrdersResult.rows as any[];
        const openOrders = ordersRows.map((row) => {
          const dbOrder = row as DbOrder;
          return {
            id: String(dbOrder.exchange_order_id),
            pair: dbOrder.pair,
            type: dbOrder.type,
            side: dbOrder.side,
            price: dbOrder.price,
            amount: dbOrder.amount,
          };
        });

        // Расчет total_portfolio_value_usdt
        // Для V1 используем total баланс quoteCurrency как общий показатель
        const totalPortfolioValueUsdt = totalQuoteBalance;

        // Парсинг TSL_State из БД
        const tslRulesMap = new Map<string, TSLRule>();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tslRows = dbTslStateResult.rows as any[];
        for (const row of tslRows) {
          const pair = row.pair as string;
          // Находим соответствующую позицию
          const position = openPositions.find((pos) => pos.pair === pair);
          if (!position) {
            this.logger.warn(`TSL_State для пары ${pair} существует, но позиция не найдена. Пропускаем.`);
            continue;
          }

          // Парсим rule_config_json
          let ruleConfig: TSLRuleConfig;
          try {
            ruleConfig = JSON.parse(row.rule_config_json) as TSLRuleConfig;
          } catch (error) {
            this.logger.error(`Ошибка парсинга rule_config_json для пары ${pair}:`, error);
            continue;
          }

          // Формируем TSLState
          const tslState: TSLState = {
            currentStopPrice: this.toDecimal(row.current_stop_price),
            currentStopOrderId: row.current_stop_order_id as string,
            priceSeen: this.toDecimal(row.price_seen),
          };

          // Формируем TSLRule
          const tslRule: TSLRule = {
            pair,
            position,
            state: tslState,
            rule: ruleConfig,
          };

          tslRulesMap.set(pair, tslRule);
        }

        // Парсинг LLM_Triggers из БД
        const llmTriggersMap = new Map<string, LLMTriggerCondition[]>();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const llmTriggersRows = dbLlmTriggersResult.rows as any[];
        for (const row of llmTriggersRows) {
          const pair = row.pair as string;
          let triggerConditions: LLMTriggerCondition[] = [];
          try {
            // PostgreSQL возвращает JSONB как объект, а не строку
            const triggerConditionsValue = row.trigger_conditions_json;
            if (typeof triggerConditionsValue === 'string') {
              triggerConditions = JSON.parse(triggerConditionsValue) as LLMTriggerCondition[];
            } else if (Array.isArray(triggerConditionsValue)) {
              triggerConditions = triggerConditionsValue as LLMTriggerCondition[];
            } else {
              this.logger.warn(
                `Неожиданный тип trigger_conditions_json для пары ${pair}: ${typeof triggerConditionsValue}. Ожидается строка или массив.`,
              );
              continue;
            }
          } catch (error) {
            this.logger.error(`Ошибка парсинга trigger_conditions_json для пары ${pair}:`, error);
            continue;
          }
          llmTriggersMap.set(pair, triggerConditions);
        }

        // Обновление кэша
        this.accountStateCache = {
          total_portfolio_value_usdt: totalPortfolioValueUsdt,
          available_quote_balance: availableQuoteBalance,
          assets,
          open_positions: openPositions,
          open_orders: openOrders,
          tslRules: tslRulesMap,
          llmTriggers: llmTriggersMap,
        };

        this.logger.info(
          `Account state refreshed: total=${totalPortfolioValueUsdt.toString()}, available=${availableQuoteBalance.toString()}, positions=${openPositions.length}, orders=${openOrders.length}, tslRules=${tslRulesMap.size}, llmTriggers=${llmTriggersMap.size}`,
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error(`Error refreshing account state: ${errorMessage}`);
        // Важно: не "валим" приложение, оставляем старый кэш
      } finally {
        this.refreshPromise = null; // Снимаем блокировку
      }
    })();

    return this.refreshPromise;
  }
}
