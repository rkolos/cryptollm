import { LoggingService } from './LoggingService.js';
import type winston from 'winston';

export class PairActorManagerService {
  private static instance: PairActorManagerService | undefined;
  private readonly logger: winston.Logger;
  private readonly promiseQueues: Map<string, Promise<void>> = new Map();

  private constructor() {
    this.logger = LoggingService.getInstance().getLogger('PairActorManager');
    this.logger.info('PairActorManagerService initialized.');
  }

  public static getInstance(): PairActorManagerService {
    if (!PairActorManagerService.instance) {
      PairActorManagerService.instance = new PairActorManagerService();
    }
    return PairActorManagerService.instance;
  }

  /**
   * Выполняет асинхронную задачу в сериализованной очереди для указанной пары.
   * Гарантирует, что никакие две задачи для одной и той же пары не выполняются одновременно.
   *
   * @param pair Торговая пара (e.g., "BTC/USDT")
   * @param task Асинхронная функция (Promise-based), которую нужно выполнить.
   * @returns Promise<T>, который разрешается или отклоняется с результатом `task`.
   */
  public async execute<T>(pair: string, task: () => Promise<T>): Promise<T> {
    // 1. Получаем "хвост" очереди для этой пары.
    // Если очереди нет, начинаем с уже разрешенного Promise.
    const previousTask = this.promiseQueues.get(pair) || Promise.resolve();

    // 2. Создаем "обертку" для новой задачи.
    const taskWrapper = async (): Promise<void> => {
      try {
        // 3. (Критично) Ждем, пока предыдущая задача завершится.
        // Мы используем .catch(), чтобы дождаться завершения,
        // даже если предыдущая задача упала с ошибкой.
        await previousTask.catch(() => {
          // Игнорируем ошибку предыдущей задачи, чтобы не сломать цепочку
        });
      } catch (e) {
        // Эта ошибка никогда не должна произойти,
        // но на всякий случай логируем.
        this.logger.error(`[${pair}] Непредвиденная ошибка в 'await previousTask'`, e);
      }

      // 4. (Критично) Только теперь, когда очередь дошла до нас,
      // мы *выполняем* саму задачу.
      // Ошибки (rejects) будут проброшены в `return` этого Promise.
      await task();
    };

    // 5. Вызываем нашу "обертку" и сохраняем Promise<void> в Map
    const nextTaskPromise = taskWrapper();

    // 6. (Критично) Обновляем "хвост" очереди в Map.
    // Мы прикрепляем .catch() к Promise *внутри* Map.
    // Это гарантирует, что если `nextTaskPromise` упадет,
    // это не "сломает" всю цепочку для будущих вызовов.
    this.promiseQueues.set(
      pair,
      nextTaskPromise.catch(() => {
        // Мы "глотаем" ошибку *только* для Promise, хранящегося в Map.
        // Сам `nextTaskPromise` (возвращаемый ниже) по-прежнему
        // будет содержать ошибку для вызывающей стороны.
      }),
    );

    // 7. Выполняем задачу отдельно для получения результата.
    // Вызывающая сторона (e.g., TSLHandler) получит либо `resolve(T)`,
    // либо `reject(error)` от `task()`.
    await previousTask.catch(() => {
      // Игнорируем ошибку предыдущей задачи
    });
    return await task();
  }

  /**
   * Ожидает завершения *всех* текущих очередей задач или таймаута.
   * Используется для Graceful Shutdown.
   * @param timeout (ms) Максимальное время ожидания.
   */
  public async waitForAllQueuesToSettle(timeout: number): Promise<void> {
    this.logger.info(`Ожидание завершения ${this.promiseQueues.size} активных очередей (Max: ${timeout}ms)...`);

    if (this.promiseQueues.size === 0) {
      this.logger.info('Нет активных очередей. Завершение.');
      return;
    }

    const allQueues = Array.from(this.promiseQueues.values());

    // 1. Создаем Promise, который ждет завершения всех очередей
    const allSettledPromise = Promise.allSettled(allQueues);

    // 2. Создаем Promise-таймаут
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), timeout);
    });

    // 3. Ждем, кто победит: "все завершились" или "таймаут"
    const result = await Promise.race([allSettledPromise, timeoutPromise]);

    if (result === 'timeout') {
      this.logger.warn(`Таймаут (${timeout}ms) при ожидании завершения очередей. Принудительное завершение.`);
    } else {
      this.logger.info('Все активные очереди успешно завершены.');
    }
  }
}

