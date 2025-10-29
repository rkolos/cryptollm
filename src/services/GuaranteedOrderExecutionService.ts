import crypto from 'crypto';
import { LoggingService } from './LoggingService.js';
import type { IExchangeService, IDecimalOrder, DecimalValue } from '../interfaces/IExchangeService.js';
import { ExchangeNetworkError, OrderNotFoundError } from '../errors/ExchangeErrors.js';
import type winston from 'winston';

// Константы для логики Retry
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000; // 2 секунды

export class GuaranteedOrderExecutionService {
  private static instance: GuaranteedOrderExecutionService | undefined;
  private readonly logger: winston.Logger;
  private exchangeService: IExchangeService | null = null;

  private constructor() {
    this.logger = LoggingService.getInstance().getLogger('GuaranteedExecution');
    this.logger.info('GuaranteedOrderExecutionService initialized.');
  }

  public static getInstance(): GuaranteedOrderExecutionService {
    if (!GuaranteedOrderExecutionService.instance) {
      GuaranteedOrderExecutionService.instance = new GuaranteedOrderExecutionService();
    }
    return GuaranteedOrderExecutionService.instance;
  }

  /**
   * (Вызывается 1 раз при старте - см. Задачу 8.1)
   * Внедряет "боевой" или "mock" IExchangeService.
   */
  public initialize(exchangeService: IExchangeService): void {
    this.logger.info('Инициализация GuaranteedOrderExecutionService...');
    this.exchangeService = exchangeService;
  }

  /**
   * (Вспомогательный) Обеспечивает паузу
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Создает ордер с гарантией идемпотентности и проверкой NetworkError.
   */
  public async createOrderWithRetry(
    pair: string,
    type: string,
    side: 'buy' | 'sell',
    amount: DecimalValue,
    price?: DecimalValue,
    params?: Record<string, unknown>,
  ): Promise<IDecimalOrder> {
    if (!this.exchangeService) {
      throw new Error('GuaranteedOrderExecutionService не инициализирован.');
    }

    // Генерация clientOrderId для идемпотентности
    const clientOrderId = `llm-trader-${crypto.randomUUID()}`;
    const clientOrderIdShort = clientOrderId.substring(11, 19);

    try {
      // Попытка 1: Создание ордера
      this.logger.debug(`[${pair}] Попытка создания ${side} ${type} ордера (Client ID: ${clientOrderIdShort})...`);

      const orderParams = {
        ...params,
        newClientOrderId: clientOrderId, // Передаем clientOrderId через params
      };

      return await this.exchangeService.createOrder(pair, type, side, amount, price, orderParams);
    } catch (error) {
      // Проверяем, является ли это сетевой ошибкой
      const isNetworkError =
        error instanceof ExchangeNetworkError ||
        (error instanceof Error && (error.message.includes('Network') || error.message.includes('timeout')));

      // Критично: Ошибка НЕ связана с сетью - немедленно пробрасываем
      if (!isNetworkError) {
        this.logger.error(`[${pair}] НЕ-сетевая ошибка при создании ордера:`, error);
        throw error; // Пробрасываем ошибку выше, e.g., в WorkerService
      }

      // Попытка 2: Логика Retry (только для NetworkError)
      this.logger.warn(
        `[${pair}] NetworkError/Timeout при создании ордера (ID: ${clientOrderIdShort}). Запуск проверки статуса (Retry-Logic)...`,
      );

      for (let i = 1; i <= RETRY_ATTEMPTS; i++) {
        await this.sleep(RETRY_DELAY_MS * i); // Exponential backoff
        this.logger.warn(
          `[${pair}] Попытка ${i}/${RETRY_ATTEMPTS}: Проверка статуса ордера (fetchOrder by Client ID)...`,
        );

        try {
          const order = await this.exchangeService.fetchOrder(clientOrderId, pair);
          // УСПЕХ: Ордер был создан, биржа вернула его
          this.logger.info(`[${pair}] (Успех Retry) Ордер ${order.id} подтвержден.`);
          return order;
        } catch (fetchError) {
          // Провал: Ордер не найден или снова NetworkError
          this.logger.error(`[${pair}] (Провал Retry ${i}):`, fetchError);
        }
      }

      // Критично: Мы не смогли ни создать, ни найти ордер
      const fatalError = new Error(
        `[FATAL] Не удалось подтвердить статус ордера ${clientOrderId} для ${pair} после ${RETRY_ATTEMPTS} попыток.`,
      );
      this.logger.error(fatalError.message);
      throw fatalError;
    }
  }

  /**
   * Отменяет ордер с проверкой NetworkError.
   */
  public async cancelOrderWithRetry(orderId: string, pair: string): Promise<void> {
    if (!this.exchangeService) {
      throw new Error('GuaranteedOrderExecutionService не инициализирован.');
    }

    try {
      // Попытка 1: Отмена ордера
      this.logger.debug(`[${pair}] Попытка отмены ордера ${orderId}...`);
      await this.exchangeService.cancelOrder(orderId, pair);
      this.logger.info(`[${pair}] Ордер ${orderId} успешно отменен (попытка 1).`);
      return;
    } catch (error) {
      // Хорошие новости: Ордер уже "исчез" (исполнен или отменен) - это НЕ ошибка
      if (error instanceof OrderNotFoundError) {
        this.logger.info(`[${pair}] Ордер ${orderId} не найден при отмене (уже исполнен/отменен).`);
        return; // Успешное завершение
      }

      // Проверяем, является ли это сетевой ошибкой
      const isNetworkError =
        error instanceof ExchangeNetworkError ||
        (error instanceof Error && (error.message.includes('Network') || error.message.includes('timeout')));

      // Плохие новости: Ошибка НЕ связана с сетью - пробрасываем
      if (!isNetworkError) {
        this.logger.error(`[${pair}] НЕ-сетевая ошибка при отмене ордера ${orderId}:`, error);
        throw error; // Пробрасываем выше
      }

      // Попытка 2: Логика Retry (только для NetworkError)
      this.logger.warn(
        `[${pair}] NetworkError/Timeout при отмене ордера ${orderId}. Запуск проверки статуса (Retry-Logic)...`,
      );

      for (let i = 1; i <= RETRY_ATTEMPTS; i++) {
        await this.sleep(RETRY_DELAY_MS * i);
        this.logger.warn(`[${pair}] Попытка ${i}/${RETRY_ATTEMPTS}: Проверка статуса ордера (fetchOrder by ID)...`);

        try {
          const order = await this.exchangeService.fetchOrder(orderId, pair);
          if (order.status === 'canceled' || order.status === 'closed') {
            // УСПЕХ: Ордер отменен или исполнен
            this.logger.info(`[${pair}] (Успех Retry) Статус ордера ${order.id} подтвержден: ${order.status}.`);
            return;
          }
          // Провал: Ордер все еще 'open'
          this.logger.error(`[${pair}] (Провал Retry ${i}) Ордер ${orderId} все еще 'open'.`);
        } catch (fetchError) {
          if (fetchError instanceof OrderNotFoundError) {
            // УСПЕХ: Ордер исчез
            this.logger.info(`[${pair}] (Успех Retry) Ордер ${orderId} не найден (OrderNotFound).`);
            return;
          }
          this.logger.error(`[${pair}] (Провал Retry ${i}):`, fetchError);
        }
      }

      // Критично: Мы не смогли отменить ордер
      const fatalError = new Error(
        `[FATAL] Не удалось подтвердить отмену ордера ${orderId} для ${pair} после ${RETRY_ATTEMPTS} попыток.`,
      );
      this.logger.error(fatalError.message);
      throw fatalError;
    }
  }
}
