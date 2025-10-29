# Техническое Задание (ТЗ): 5.0 Движок Синхронизации (SyncEngine) - API Сервиса

**Эпик:** 5. 🔄 "Наблюдатель" (Watcher) - Синхронизация, Циклы и Триггеры **Задача:** 5.0 **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать `SyncEngineService` (Singleton) — "скелет" сервиса-аудитора, отвечающего за сверку состояния между нашей БД и биржей. Эта задача реализует _публичное API_ (`reconcileStateAll`, `reconcileStateForPair`) и заглушки для приватных методов (которые будут реализованы в 5.1.x).

Этот сервис **гарантирует**, что все операции сверки для _одной_ пары выполняются последовательно (через `PairActorManagerService`) и никогда не вступают в "гонку" с `Worker`\-ом или `TSLHandler`\-ом.

## 2\. Архитектурное Решение

1.  **Singleton:** Сервис реализуется как Singleton.
2.  **Публичное API:** Сервис предоставляет два метода:
    - `async reconcileStateAll()`: Вызывается "Медленным Циклом" (Задача 5.2) для _плановой_ сверки _всех_ пар в `watchlist` (последовательно, одна за другой, чтобы не создавать пиковую нагрузку на API биржи).
    - `async reconcileStateForPair(pair)`: Вызывается `WatcherOrchestrator` (Задача 5.6) для _принудительной_ сверки _одной_ пары сразу после исполнения приказа `Worker`\-ом.

3.  **Контроль Конкурентности (Критично):** _Вся_ логика внутри `reconcileStateForPair` (включая вызовы 5.1.x) _обязана_ быть "обернута" в `this.pairActorManager.execute(pair, ...)`. Это требование **Задачи 9.2**.
4.  **Заглушки (Stubs):** Эта задача _не реализует_ саму логику сверки, а только создает приватные методы-заглушки (e.g., `_reconcileOrders`), которые будут "оживлены" в следующих задачах.

## 3\. Зависимости Задачи

- **`LoggingService` (1.4):** (Зависимость) Для логирования.
- **`ConfigService` (1.3):** (Зависимость) Для `getWatchlist()`.
- **`PairActorManagerService` (9.1):** (Зависимость) **Критически важен** для `execute()`.
- **`IExchangeService` (3.1 / 3.5):** (Зависимость) Для `fetchOpenOrders()` и `fetchMyTrades()`.
- **`DatabaseService` (2.3):** (Зависимость) Для `query()`.

## 4\. Описание и Нюансы Реализации

### 4.1. Создание `src/services/SyncEngineService.ts`

Разработчик должен создать новый файл `src/services/SyncEngineService.ts` и реализовать `SyncEngineService` как Singleton, приняв в конструкторе все перечисленные зависимости.

### 4.2. Реализация Публичного API

**`public async reconcileStateAll(): Promise<void>`**

1.  **Цель:** Последовательно сверить _все_ пары из `watchlist`.
2.  **Логика:**
    - Получить `watchlist = this.configService.getWatchlist()`.
    - Использовать цикл `for...of` (а _не_ `Promise.all` или `forEach`) для итерации по `watchlist`.
    - Внутри цикла вызывать: `await this.reconcileStateForPair(pair)`.
    - _Примечание: Мы используем `await` для последовательного выполнения, чтобы распределить нагрузку на API биржи во времени._

**`public async reconcileStateForPair(pair: string): Promise<void>`**

1.  **Цель:** Сверить _одну_ пару, гарантируя отсутствие "гонок".
2.  **Логика:**
    - Этот метод _обязан_ "обернуть" _всю_ логику в `PairActorManagerService`, как того требует **Задача 9.2**.
    - **Нюанс реализации (Код):**

          public async reconcileStateForPair(pair: string): Promise<void> {
              this.logger.debug(`[${pair}] (SyncEngine) Задача на сверку [${pair}] добавлена в очередь...`);

              // (Критично - Задача 9.2)
              await this.pairActorManager.execute(pair, async () => {
                  this.logger.info(`[${pair}] (SyncEngine) Сверка [${pair}] ЗАПУЩЕНА.`);

                  // (Получаем "сырые" данные о состоянии)
                  const [exchangeOrders, dbOrders, dbPositions] = await Promise.all([
                      this.exchangeService.fetchOpenOrders(pair),
                      this.dbService.query(`SELECT * FROM ActiveOrders WHERE pair = $1`, [pair]),
                      this.dbService.query(`SELECT * FROM ActivePositions WHERE pair = $1`, [pair])
                  ]);

                  // (Вызываем заглушки, которые будут реализованы в 5.1.x)

                  // (Задача 5.1: Ордера-зомби / Исполненные офлайн)
                  await this._reconcileOrders(
                      pair,
                      exchangeOrders, // (Реальное состояние)
                      dbOrders.rows    // (Наше состояние)
                  );

                  // (Задача 5.1.1: "Судебная" сверка)
                  await this._reconcilePositionsForensic(
                      pair,
                      dbPositions.rows, // (Наши позиции)
                      dbOrders.rows     // (Наши ордера)
                  );

                  // (Задача 5.1.2: Исполнение OPEN_LIMIT)
                  await this._reconcileOpenLimitOrders(
                      pair,
                      exchangeOrders, // (Реальное состояние)
                      dbOrders.rows    // (Наши ордера)
                  );

                  this.logger.info(`[${pair}] (SyncEngine) Сверка [${pair}] ЗАВЕРШЕНА.`);
              });
          }

### 4.3. Создание Заглушек (Stubs)

Разработчик должен создать следующие приватные методы-заглушки (stubs) внутри `SyncEngineService`. Они будут "оживлены" в следующих задачах.

    // (STUB - Задача 5.1: Логика Сверки - Ордера)
    private async _reconcileOrders(
        pair: string,
        exchangeOrders: ccxt.Order[],
        dbOrders: any[]
    ): Promise<void> {
        this.logger.debug(`[${pair}] (STUB) _reconcileOrders...`);
        // (Логика Сценариев 3 и 4 из `about.md` будет здесь)
    }

    // (STUB - Задача 5.1.1: Логика Сверки - "Судебная" Сверка Позиций)
    private async _reconcilePositionsForensic(
        pair: string,
        dbPositions: any[],
        dbOrders: any[]
    ): Promise<void> {
        this.logger.debug(`[${pair}] (STUB) _reconcilePositionsForensic...`);
        // (Логика "судебной" сверки на основе TradeHistory будет здесь)
    }

    // (STUB - Задача 5.1.2: Логика Сверки - Исполнение OPEN_LIMIT)
    private async _reconcileOpenLimitOrders(
        pair: string,
        exchangeOrders: ccxt.Order[],
        dbOrders: any[]
    ): Promise<void> {
        this.logger.debug(`[${pair}] (STUB) _reconcileOpenLimitOrders...`);
        // (Логика обработки частично/полностью исполненных OPEN_LIMIT будет здесь)
    }

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Service

    `SyncEngineService.ts` создан как Singleton и корректно принимает все 5 зависимостей.

2.  **\[API (All)\]** `reconcileStateAll()` реализован и использует `for...of` (последовательный `await`) для вызова `reconcileStateForPair`.
3.  **\[API (Pair) (Критично)\]** `reconcileStateForPair()` _полностью_ оборачивает свою логику в `this.pairActorManager.execute()`.
4.  **\[API (Pair)\]** Внутри `execute()` `reconcileStateForPair` _сначала_ получает `exchangeOrders`, `dbOrders` и `dbPositions` через `Promise.all`.
5.  **\[Stubs\]** `reconcileStateForPair` _последовательно_ вызывает приватные методы-заглушки: `_reconcileOrders`, `_reconcilePositionsForensic` и `_reconcileOpenLimitOrders`.
6.  **\[Stubs\]** Все три приватных метода-заглушки созданы, имеют корректные сигнатуры (принимают `pair` и состояния) и логгируют (STUB).
