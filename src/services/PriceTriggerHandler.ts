import Decimal from 'decimal.js';
import { LoggingService } from './LoggingService.js';
import { AccountStateService } from './AccountStateService.js';
import { PairActorManagerService } from './PairActorManagerService.js';
import { WatcherOrchestratorService } from './WatcherOrchestratorService.js';
import type { IDecimalTicker, DecimalValue } from '../interfaces/IExchangeService.js';
import type { LLMTriggerCondition } from '../interfaces/ILLMTypes.js';
import type winston from 'winston';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DecimalConstructor = Decimal as any;

interface ActiveOrder {
  id: string;
  pair: string;
  type: string;
  side: 'buy' | 'sell';
  price: string;
  amount: string;
  status?: string;
}

export class PriceTriggerHandler {
  private static instance: PriceTriggerHandler | undefined;
  private readonly logger: winston.Logger;
  private readonly accountStateService: AccountStateService;
  private readonly pairActorManager: PairActorManagerService;
  private readonly orchestrator: WatcherOrchestratorService;

  private constructor(
    accountStateService: AccountStateService,
    pairActorManager: PairActorManagerService,
    orchestrator: WatcherOrchestratorService,
  ) {
    this.accountStateService = accountStateService;
    this.pairActorManager = pairActorManager;
    this.orchestrator = orchestrator;
    this.logger = LoggingService.getInstance().getLogger('PriceTrigger');
    this.logger.info('PriceTriggerHandler initialized.');
  }

  public static getInstance(
    accountStateService: AccountStateService,
    pairActorManager: PairActorManagerService,
    orchestrator: WatcherOrchestratorService,
  ): PriceTriggerHandler {
    if (!PriceTriggerHandler.instance) {
      PriceTriggerHandler.instance = new PriceTriggerHandler(accountStateService, pairActorManager, orchestrator);
    }
    return PriceTriggerHandler.instance;
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
      const triggerConditions = state.llmTriggers.get(pair);

      // Если для этой пары нет триггеров, выходим
      if (!triggerConditions || triggerConditions.length === 0) {
        return;
      }

      // Получаем текущую цену
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const currentPriceDecimal = ticker.last as any;
      const currentPrice = new DecimalConstructor(currentPriceDecimal.toString());

      // Вызываем приватный обработчик логики
      const triggeredCondition = this._findPriceTrigger(triggerConditions, currentPrice);

      // Если триггер сработал
      if (triggeredCondition) {
        // Триггер сработал. Проверяем "предохранитель" (Задача 5.5)
        const openLimitOrder = this._findOpenLimitOrder(state.open_orders, pair);

        if (openLimitOrder) {
          this.logger.debug(
            `(PriceHandler) [${pair}] Price trigger ${triggeredCondition.value} hit, but ignored due to active OPEN_LIMIT order.`,
          );
          return; // Игнорируем, SyncEngine (5.1.2) справится
        }

        // "Предохранитель" не сработал, передаем управление Оркестратору
        this.logger.info(
          `(PriceHandler) [${pair}] Price trigger hit: ${currentPrice.toString()} ${triggeredCondition.condition} ${triggeredCondition.value}. Calling Orchestrator.`,
        );

        // (Задача 9.3) Вызов "Актора" (Fire-and-Forget)
        this.pairActorManager
          .execute(pair, async () => {
            await this.orchestrator.executeOrchestration(pair, 'Price Trigger Hit');
          })
          .catch((e) => {
            this.logger.error(`(PriceHandler) [${pair}] КРИТИЧЕСКАЯ ОШИБКА в акторе: ${String(e)}`, e);
          });
      }
    } catch (error) {
      this.logger.error(`(PriceHandler) [${ticker.symbol}] КРИТИЧЕСКИЙ СБОЙ: ${String(error)}`, error);
      // Не бросаем ошибку, чтобы не "убить" WS-цикл
    }
  }

  /**
   * Приватный метод для поиска сработавшего price триггера
   * Чистая, синхронная функция, использующая decimal.js
   */
  private _findPriceTrigger(
    conditions: LLMTriggerCondition[],
    currentPrice: DecimalValue,
  ): LLMTriggerCondition | null {
    for (const condition of conditions) {
      // Ищем первый триггер типа 'price'
      if (condition.type !== 'price') {
        continue;
      }

      // Преобразуем value в Decimal для сравнения
      const conditionValue = new DecimalConstructor(condition.value);

      // Проверяем условие
      if (condition.condition === 'below' && currentPrice.lessThan(conditionValue)) {
        return condition;
      }

      if (condition.condition === 'above' && currentPrice.greaterThan(conditionValue)) {
        return condition;
      }
    }

    // Триггер не сработал
    return null;
  }

  /**
   * Приватный метод для поиска OPEN_LIMIT ордера (предохранитель)
   * Чистая, синхронная функция
   */
  private _findOpenLimitOrder(activeOrders: unknown[], pair: string): ActiveOrder | null {
    for (const order of activeOrders) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const orderTyped = order as any;
      if (
        orderTyped.pair === pair &&
        orderTyped.type === 'limit_open' &&
        (orderTyped.status === 'open' || orderTyped.status === undefined)
      ) {
        return orderTyped as ActiveOrder;
      }
    }
    return null;
  }
}

