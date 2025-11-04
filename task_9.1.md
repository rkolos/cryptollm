# Техническое Задание (ТЗ): 9.1 Менеджер "Актеров" (PairActorManagerService)

**Эпик:** 9. 🚦 Контроль Конкурентности и Блокировок **Задача:** 9.1 Менеджер "Актеров" (PairActorManagerService) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать `PairActorManagerService` (Singleton) — ключевой сервис для управления конкурентностью. Сервис должен реализовывать "Actor-lite" модель, предоставляя механизм (`Promise`\-очередь) для **сериализации** всех асинхронных операций (задач), выполняемых для **одной и той же торговой пары**.

Это устранит "гонки состояний" (Race Conditions) между "Быстрым Циклом" (TSL, Price Trigger) и "Медленным Циклом" (SyncEngine, LLM/Worker).

## 2\. Зависимости Задачи

- **`LoggingService` (1.4):** (Зависимость) Для логирования операций с очередями.
- **Все Потребители (Эпик 9.2, 9.3, 9.4):** `SyncEngine`, `StopLossJanitor`, `TSLHandlerService`, `PriceTriggerHandler`, `WatcherOrchestrator` (вызов LLM + Worker).
- **`Graceful Shutdown` (8.1.1):** (Потребитель) Будет вызывать метод `waitForAllQueuesToSettle`.

## 3\. Описание и Нюансы Реализации

### 3.1. Архитектура (Singleton)

- **Файл:** `src/services/PairActorManagerService.ts`
- **Класс:** `PairActorManagerService`
- **Реализация:** Должен быть реализован как Singleton (через `static getInstance()`).
- **Внедрение (DI):** Сервис будет внедряться во все _потребители_ (TSLHandler, SyncEngine и т.д.).

### 3.2. Внутреннее Состояние (Очереди)

- **Поле:** `private readonly promiseQueues: Map<string, Promise<void>> = new Map();`
- **Нюанс:** Ключ (`string`) — это `pair` (e.g., "BTC/USDT").
- **Нюанс:** `Promise<void>` — это _хвост_ цепочки обещаний для этой пары. Мы храним `void` (а не `T`), так как нас интересует только _факт завершения_ предыдущей задачи, а не ее результат.

### 3.3. Ключевой Метод: `execute()`

Разработчик должен реализовать публичный метод `execute`. Это "сердце" сервиса.

    // src/services/PairActorManagerService.ts

    // ... (импорты)

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
            const hasPreviousTask = this.promiseQueues.has(pair);

            if (hasPreviousTask) {
                this.logger.debug(`[${pair}] Задача добавлена в очередь. Ожидание завершения предыдущей задачи...`);
            } else {
                this.logger.debug(`[${pair}] Задача добавлена в очередь. Выполнение начнется немедленно.`);
            }

            // 2. Создаем обертку для задачи, которая ждет предыдущую и выполняет текущую
            const taskWrapper = async (): Promise<T> => {
                try {
                    // 3. (Критично) Ждем, пока предыдущая задача завершится.
                    // Мы используем .catch(), чтобы дождаться завершения,
                    // даже если предыдущая задача упала с ошибкой.
                    if (hasPreviousTask) {
                        this.logger.debug(`[${pair}] Ожидание завершения предыдущей задачи в очереди...`);
                    }
                    await previousTask.catch((error) => {
                        // Логируем ошибку предыдущей задачи для отладки, но не прерываем цепочку
                        this.logger.warn(
                            `[${pair}] Предыдущая задача в очереди завершилась с ошибкой (цепочка продолжается):`,
                            error,
                        );
                    });
                    if (hasPreviousTask) {
                        this.logger.debug(`[${pair}] Предыдущая задача завершена. Начало выполнения текущей задачи...`);
                    }
                } catch (e) {
                    // Эта ошибка никогда не должна произойти,
                    // но на всякий случай логируем.
                    this.logger.error(`[${pair}] Непредвиденная ошибка в 'await previousTask'`, e);
                }

                // 4. (Критично) Только теперь, когда очередь дошла до нас,
                // мы *выполняем* саму задачу.
                // Ошибки (rejects) будут проброшены в `return` этого Promise.
                return await task();
            };

            // 5. Вызываем нашу "обертку" и сохраняем Promise<T> в Map
            const nextTaskPromise = taskWrapper();

            // 6. (Критично) Обновляем "хвост" очереди в Map.
            // Мы прикрепляем .catch() к Promise *внутри* Map.
            // Это гарантирует, что если `nextTaskPromise` упадет,
            // это не "сломает" всю цепочку для будущих вызовов.
            // ВАЖНО: Преобразуем Promise<T> в Promise<void> для Map
            this.promiseQueues.set(
                pair,
                nextTaskPromise
                    .then(() => {
                        // Преобразуем в void для Map
                    })
                    .catch(() => {
                        // Мы "глотаем" ошибку *только* для Promise, хранящегося в Map.
                        // Сам `nextTaskPromise` (возвращаемый ниже) по-прежнему
                        // будет содержать ошибку для вызывающей стороны.
                    }),
            );

            // 7. Возвращаем Promise<T> вызывающей стороне
            // Вызывающая сторона (e.g., TSLHandler) получит либо `resolve(T)`,
            // либо `reject(error)` от `task()`.
            return nextTaskPromise;
        }

        // ... (метод waitForAllQueuesToSettle ниже)
    }

### 3.4. Метод для Graceful Shutdown: `waitForAllQueuesToSettle()`

Этот метод будет вызван (Задачей 8.1.1) при получении `SIGINT`/`SIGTERM`, чтобы дать всем _уже запущенным_ задачам шанс завершиться.

    // ... (внутри класса PairActorManagerService)

        /**
         * Ожидает завершения *всех* текущих очередей задач или таймаута.
         * Используется для Graceful Shutdown.
         * @param timeout (ms) Максимальное время ожидания.
         */
        public async waitForAllQueuesToSettle(timeout: number): Promise<void> {
            this.logger.info(`Ожидание завершения ${this.promiseQueues.size} активных очередей (Max: ${timeout}ms)...`);

            if (this.promiseQueues.size === 0) {
                this.logger.info("Нет активных очередей. Завершение.");
                return;
            }

            const allQueues = Array.from(this.promiseQueues.values());

            // 1. Создаем Promise, который ждет завершения всех очередей
            const allSettledPromise = Promise.allSettled(allQueues);

            // 2. Создаем Promise-таймаут
            const timeoutPromise = new Promise<"timeout">((resolve) => {
                setTimeout(() => resolve("timeout"), timeout);
            });

            // 3. Ждем, кто победит: "все завершились" или "таймаут"
            const result = await Promise.race([allSettledPromise, timeoutPromise]);

            if (result === "timeout") {
                this.logger.warn(`Таймаут (${timeout}ms) при ожидании завершения очередей. Принудительное завершение.`);
            } else {
                this.logger.info("Все активные очереди успешно завершены.");
            }
        }

## 4\. Критерии Приемки (Acceptance Criteria)

1.  **\[Singleton\]** `PairActorManagerService` реализован как Singleton через `static getInstance()` без параметров. Инициализирует logger в конструкторе.
2.  **\[Сериализация по Паре\]** Метод `execute` гарантирует, что две задачи для `pair: "A"` не могут выполняться одновременно.
3.  **\[Параллельность (Критично)\]** Метод `execute` **позволяет** двум задачам для `pair: "A"` и `pair: "B"` выполняться _параллельно_ (не блокирует разные пары).
4.  **\[Логирование\]** Метод `execute` логирует `debug` сообщения о добавлении задачи в очередь, ожидании предыдущей задачи и начале выполнения текущей задачи на основе флага `hasPreviousTask`.
5.  **\[Проброс Ошибки (Критично)\]** Если `task()` (переданная в `execute`) отклоняется (rejects) с ошибкой, `Promise`, возвращаемый `execute`, _также_ отклоняется с этой ошибкой (т.е. `try...catch` у вызывающей стороны сработает).
6.  **\[Отказоустойчивость Цепочки (Критично)\]** Если `task()` (переданная в `execute`) отклоняется, это **не "ломает"** очередь для `pair: "A"`. Ошибка предыдущей задачи логируется через `logger.warn`, но цепочка продолжается. Следующий вызов `execute` для `pair: "A"` _не_ должен быть немедленно отклонен, а должен дождаться завершения "сломанной" задачи и выполниться.
7.  **\[Graceful Shutdown\]** Метод `waitForAllQueuesToSettle` корректно ожидает `Promise.allSettled` или завершается по `Promise.race` с таймаутом (`Promise<'timeout'>`).
