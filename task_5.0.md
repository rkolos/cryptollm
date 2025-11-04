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
    - Залогировать `info` с количеством пар для сверки.
    - Использовать цикл `for...of` (а _не_ `Promise.all` или `forEach`) для итерации по `watchlist`.
    - Добавить задержку 500мс между парами (кроме первой) для снижения нагрузки на API.
    - Для каждой пары обернуть вызов `reconcileStateForPair(pair)` в `Promise.race` с таймаутом 60 секунд.
    - Если сверка превысила таймаут, залогировать `warn` и продолжить со следующей парой.
    - Если произошла другая ошибка, залогировать `error` и продолжить со следующей парой.
    - Залогировать `info` о завершении плановой сверки.

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

                  // (Получаем "сырые" данные о состоянии через Promise.allSettled)
                  const results = await Promise.allSettled([
                      this.exchangeService.fetchOpenOrders(pair),
                      this.databaseService.query('SELECT * FROM ActiveOrders WHERE pair = $1', [pair]),
                      this.databaseService.query('SELECT * FROM ActivePositions WHERE pair = $1', [pair]),
                      this.exchangeService.fetchBalance(), // Добавлен для получения баланса базового актива
                  ]);

                  // Обработка ошибок: если любой запрос провалился, выходим
                  if (results[0].status === 'rejected') {
                      this.logger.error(`[${pair}] Ошибка при получении ордеров с биржи:`, results[0].reason);
                      return;
                  }
                  if (results[1].status === 'rejected') {
                      this.logger.error(`[${pair}] Ошибка при получении ордеров из БД:`, results[1].reason);
                      return;
                  }
                  if (results[2].status === 'rejected') {
                      this.logger.error(`[${pair}] Ошибка при получении позиций из БД:`, results[2].reason);
                      return;
                  }
                  if (results[3].status === 'rejected') {
                      this.logger.error(`[${pair}] Ошибка при получении баланса:`, results[3].reason);
                      return;
                  }

                  const exchangeOrders = results[0].value as IDecimalOrder[];
                  const dbOrders = results[1].value.rows as DbOrder[];
                  const dbPositions = results[2].value.rows as DbPosition[];
                  const exchangeBalance = results[3].value as IDecimalBalance;

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
                      dbPositions, // (Наши позиции)
                      dbOrders,    // (Наши ордера)
                      exchangeBalance // (Баланс для проверки)
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

    // (Задача 5.1: Логика Сверки - Ордера)
    private async _reconcileOrders(
        pair: string,
        exchangeOrders: IDecimalOrder[],
        dbOrders: DbOrder[]
    ): Promise<void> {
        this.logger.debug(`[${pair}] Запуск сверки ордеров...`);

        // Создаем Set для быстрого поиска
        const dbOrderIds = new Set(dbOrders.map((o) => o.exchange_order_id));
        const exchangeOrderIds = new Set(exchangeOrders.map((o) => o.id));

        // Сценарий 3 ("Зомби"): Ордера на бирже есть, но нет в БД
        for (const exchangeOrder of exchangeOrders) {
            if (!dbOrderIds.has(exchangeOrder.id)) {
                this.logger.warn(`[${pair}] Обнаружен ордер-зомби [${exchangeOrder.id}]! Немедленно отменяем...`);
                try {
                    await this.guaranteedOrderService.cancelOrderWithRetry(exchangeOrder.id, pair);
                    this.logger.info(`[${pair}] Ордер-зомби [${exchangeOrder.id}] успешно отменен.`);
                } catch (error) {
                    // Если ордер уже не существует (OrderNotFoundError), это нормально
                    if (error instanceof OrderNotFoundError) {
                        this.logger.debug(`[${pair}] Ордер [${exchangeOrder.id}] уже не существует на бирже.`);
                    } else {
                        this.logger.error(`[${pair}] Ошибка при отмене ордера-зомби [${exchangeOrder.id}]:`, error);
                        // Продолжаем обработку других ордеров
                    }
                }
            }
        }

        // Сценарий 4 ("Призраки"): Ордера в БД есть, но нет на бирже
        const ghostOrders = dbOrders.filter((dbOrder) => !exchangeOrderIds.has(dbOrder.exchange_order_id));
        if (ghostOrders.length > 0) {
            this.logger.info(`[${pair}] Обнаружено ${ghostOrders.length} ордеров-призраков. Выполняем атомарную очистку БД...`);

            // Атомарно удаляем призраки из ActiveOrders и TSL_State
            await this.databaseService.executeInTransaction(async (client) => {
                for (const ghostOrder of ghostOrders) {
                    this.logger.info(`[${pair}] Ордер [${ghostOrder.exchange_order_id}] исполнился офлайн. Удаляем из БД...`);

                    // Удаляем из ActiveOrders
                    await client.query('DELETE FROM ActiveOrders WHERE exchange_order_id = $1', [ghostOrder.exchange_order_id]);

                    // Удаляем связанный TSL, если он был
                    await client.query('DELETE FROM TSL_State WHERE current_stop_order_id = $1', [ghostOrder.exchange_order_id]);
                }
            });

            this.logger.info(`[${pair}] Атомарная очистка ордеров-призраков завершена.`);
        }
    }

    // (Задача 5.1.1: Логика Сверки - "Судебная" Сверка Позиций)
    private async _reconcilePositionsForensic(
        pair: string,
        dbPositions: DbPosition[],
        _dbOrders: DbOrder[],
        exchangeBalance: IDecimalBalance
    ): Promise<void> {
        // Условие запуска: баланс базового актива > 0 И позиции в БД нет
        const baseAsset = this.getBaseAsset(pair); // Приватный метод для извлечения базового актива
        const baseAssetBalance = exchangeBalance[baseAsset]?.total;

        if (!baseAssetBalance) {
            this.logger.debug(`[${pair}] Баланс базового актива ${baseAsset} не найден. Пропускаем судебную сверку.`);
            return;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const balanceDecimal = baseAssetBalance as any as DecimalValue;
        const balanceValue = new DecimalConstructor(balanceDecimal.toString());

        if (!balanceValue.greaterThan(0) || dbPositions.length > 0) {
            this.logger.debug(`[${pair}] Условие для судебной сверки не выполнено: balance=${balanceValue}, dbPositions=${dbPositions.length}`);
            return;
        }

        this.logger.info(`[${pair}] Запуск судебной сверки: баланс ${baseAsset}=${balanceValue}, позиций в БД=0. Восстанавливаем позицию...`);

        // Вся логика восстановления в транзакции
        await this.databaseService.executeInTransaction(async (client) => {
            // Шаг 1: Сбор истории сделок
            const [exchangeTradesResult, dbTradesResult] = await Promise.all([
                this.exchangeService.fetchMyTrades(pair, undefined, 1000), // Получаем последние 1000 сделок
                client.query('SELECT * FROM TradeHistory WHERE pair = $1 ORDER BY timestamp ASC', [pair]),
            ]);

            const exchangeTrades = exchangeTradesResult;
            const dbTrades = dbTradesResult.rows as unknown[] as DbTrade[];

            // Шаг 2: Находим недостающие сделки
            const dbTradeIds = new Set(dbTrades.map((t) => t.exchange_trade_id));
            const missingTrades = exchangeTrades.filter((t) => !dbTradeIds.has(t.id));

            if (missingTrades.length > 0) {
                this.logger.info(`[${pair}] Обнаружено ${missingTrades.length} недостающих сделок. Вставляем в TradeHistory...`);

                // Вставляем недостающие сделки с ON CONFLICT DO NOTHING
                for (const trade of missingTrades) {
                    await client.query(
                        `INSERT INTO TradeHistory (timestamp, exchange_trade_id, exchange_order_id, pair, side, price, amount, fee_cost, fee_currency, realized_pnl_usd)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                         ON CONFLICT (exchange_trade_id) DO NOTHING`,
                        [
                            new Date(trade.timestamp),
                            trade.id,
                            trade.order,
                            trade.symbol,
                            trade.side,
                            trade.price.toString(),
                            trade.amount.toString(),
                            trade.fee.cost.toString(),
                            trade.fee.currency,
                            null, // realized_pnl_usd будет рассчитан позже
                        ],
                    );
                }
            }

            // Шаг 3: Реконструкция позиции из истории
            const reconstructedPosition = await this._reconstructPositionFromHistory(pair, client);

            if (!reconstructedPosition) {
                this.logger.info(`[${pair}] После реконструкции позиция закрыта (totalAmount <= 0). Восстановление не требуется.`);
                return;
            }

            // Шаг 4: Вставляем восстановленную позицию с ON CONFLICT DO UPDATE
            await client.query(
                `INSERT INTO ActivePositions (pair, side, amount, average_entry_price, total_fee_cost, stop_loss_price)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (pair) DO UPDATE SET
                   side = EXCLUDED.side,
                   amount = EXCLUDED.amount,
                   average_entry_price = EXCLUDED.amount,
                   total_fee_cost = EXCLUDED.total_fee_cost,
                   stop_loss_price = EXCLUDED.stop_loss_price`,
                [
                    pair,
                    reconstructedPosition.side,
                    reconstructedPosition.amount.toString(),
                    reconstructedPosition.average_entry_price.toString(),
                    reconstructedPosition.total_fee_cost.toString(),
                    null, // stop_loss_price = NULL для восстановленных позиций
                ],
            );

            this.logger.info(`[${pair}] Позиция успешно восстановлена в БД.`);
        });
    }

    // (Задача 5.1.2: Логика Сверки - Исполнение OPEN_LIMIT)
    private async _reconcileOpenLimitOrders(
        pair: string,
        exchangeOrders: IDecimalOrder[],
        dbOrders: DbOrder[]
    ): Promise<void> {
        // Поиск ордеров с type === 'limit_open' и status === 'open'
        const limitOpenOrders = dbOrders.filter((o) => o.type === 'limit_open' && o.status === 'open');

        if (limitOpenOrders.length === 0) {
            return;
        }

        // Создаем Map для быстрого поиска ордеров на бирже
        const exchangeOrderMap = new Map<string, IDecimalOrder>();
        for (const order of exchangeOrders) {
            exchangeOrderMap.set(order.id, order);
        }

        // Обрабатываем каждый limit_open ордер
        for (const dbOrder of limitOpenOrders) {
            const exchangeOrder = exchangeOrderMap.get(dbOrder.exchange_order_id);

            // Условие конвертации: ордера нет на бирже ИЛИ ордер есть, но status === 'closed' и filled > 0
            const shouldConvert =
                !exchangeOrder ||
                (exchangeOrder.status === 'closed' &&
                    exchangeOrder.filled &&
                    new DecimalConstructor(exchangeOrder.filled.toString()).greaterThan(0));

            if (!shouldConvert) {
                continue;
            }

            this.logger.info(`[${pair}] Обнаружен исполненный limit_open ордер [${dbOrder.exchange_order_id}]. Конвертируем в активную позицию...`);

            try {
                // Шаг 1: Получение реальных деталей исполнения через fetchMyTrades
                const trades = await this.exchangeService.fetchMyTrades(pair, undefined, 100);
                const orderTrades = trades.filter((t) => t.order === dbOrder.exchange_order_id);

                if (orderTrades.length === 0) {
                    this.logger.warn(`[${pair}] Не найдено сделок для ордера [${dbOrder.exchange_order_id}]. Пропускаем конвертацию.`);
                    continue;
                }

                // Рассчитываем реальные значения используя Decimal
                let realAmount = new DecimalConstructor(0);
                let realCost = new DecimalConstructor(0);
                let realFeeCost = new DecimalConstructor(0);
                let feeCurrency = 'USDT';

                for (const trade of orderTrades) {
                    realAmount = realAmount.plus(new DecimalConstructor(trade.amount.toString()));
                    realCost = realCost.plus(new DecimalConstructor(trade.cost.toString()));
                    realFeeCost = realFeeCost.plus(new DecimalConstructor((trade.fee?.cost || 0).toString()));
                    if (trade.fee?.currency) {
                        feeCurrency = trade.fee.currency;
                    }
                }

                // Проверка деления на ноль
                if (realAmount.isZero()) {
                    this.logger.error(`[${pair}] КРИТИЧЕСКАЯ ОШИБКА: realAmount равен нулю. Пропускаем ордер ${dbOrder.exchange_order_id}.`);
                    continue;
                }

                const realEntryPrice = realCost.div(realAmount);

                // Определяем сторону позиции
                const positionSide: 'long' | 'short' = dbOrder.side === 'buy' ? 'long' : 'short';
                const oppositeSide: 'buy' | 'sell' = dbOrder.side === 'buy' ? 'sell' : 'buy';

                // Шаг 2: Создание SL/TP ордеров ДО транзакции БД
                let slOrderId: string | null = null;
                let tpOrderId: string | null = null;

                if (dbOrder.target_stop_loss_price) {
                    try {
                        const slPrice = new DecimalConstructor(dbOrder.target_stop_loss_price);
                        // Используем stop_loss_limit для защиты от проскальзывания
                        const slOrder = await this.guaranteedOrderService.createOrderWithRetry(
                            pair,
                            'stop_loss_limit',
                            oppositeSide,
                            realAmount as DecimalValue,
                            slPrice as DecimalValue,
                            { stopPrice: slPrice.toString() },
                        );
                        slOrderId = slOrder.id;
                        this.logger.info(`[${pair}] SL ордер [${slOrderId}] создан на бирже.`);
                    } catch (error) {
                        this.logger.error(`[${pair}] Ошибка при создании SL ордера:`, error);
                        // Продолжаем без SL, но логируем критическую ошибку
                    }
                }

                if (dbOrder.target_take_profit_price) {
                    try {
                        const tpPrice = new DecimalConstructor(dbOrder.target_take_profit_price);
                        // TP - это обычный Limit ордер
                        const tpOrder = await this.guaranteedOrderService.createOrderWithRetry(
                            pair,
                            'limit',
                            oppositeSide,
                            realAmount as DecimalValue,
                            tpPrice as DecimalValue,
                        );
                        tpOrderId = tpOrder.id;
                        this.logger.info(`[${pair}] TP ордер [${tpOrderId}] создан на бирже.`);
                    } catch (error) {
                        this.logger.error(`[${pair}] Ошибка при создании TP ордера:`, error);
                        // Продолжаем без TP, но логируем критическую ошибку
                    }
                }

                // Шаг 3: Атомарное обновление БД
                await this.databaseService.executeInTransaction(async (client) => {
                    // 3.1. Удаляем старый limit_open ордер
                    await client.query('DELETE FROM ActiveOrders WHERE exchange_order_id = $1', [dbOrder.exchange_order_id]);

                    // 3.2. Вставляем новую ActivePosition с ON CONFLICT DO UPDATE
                    await client.query(
                        `INSERT INTO ActivePositions (pair, side, amount, average_entry_price, total_fee_cost, stop_loss_price)
                         VALUES ($1, $2, $3, $4, $5, $6)
                         ON CONFLICT (pair) DO UPDATE SET
                           side = EXCLUDED.side,
                           amount = EXCLUDED.amount,
                           average_entry_price = EXCLUDED.average_entry_price,
                           total_fee_cost = EXCLUDED.total_fee_cost,
                           stop_loss_price = EXCLUDED.stop_loss_price`,
                        [
                            pair,
                            positionSide,
                            realAmount.toString(),
                            realEntryPrice.toString(),
                            realFeeCost.toString(),
                            dbOrder.target_stop_loss_price || null,
                        ],
                    );

                    // 3.3. Вставляем SL ордер, если был создан
                    if (slOrderId) {
                        await client.query(
                            `INSERT INTO ActiveOrders (exchange_order_id, pair, type, side, status, price, amount)
                             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                            [slOrderId, pair, 'stop_loss_limit', oppositeSide, 'open', dbOrder.target_stop_loss_price, realAmount.toString()],
                        );
                    }

                    // 3.4. Вставляем TP ордер, если был создан
                    if (tpOrderId) {
                        await client.query(
                            `INSERT INTO ActiveOrders (exchange_order_id, pair, type, side, status, price, amount)
                             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                            [tpOrderId, pair, 'limit', oppositeSide, 'open', dbOrder.target_take_profit_price, realAmount.toString()],
                        );
                    }
                });

                this.logger.info(`[${pair}] Конвертация limit_open ордера [${dbOrder.exchange_order_id}] завершена успешно.`);
            } catch (error) {
                this.logger.error(`[${pair}] КРИТИЧЕСКАЯ ОШИБКА при конвертации limit_open ордера [${dbOrder.exchange_order_id}]:`, error);
                // Продолжаем обработку других ордеров, полагаясь на удаление "зомби" в следующем цикле
            }
        }
    }

    /**
     * Извлекает базовый актив из торговой пары (e.g., 'BTC' из 'BTC/USDT')
     */
    private getBaseAsset(pair: string): string {
        const parts = pair.split('/');
        if (parts.length !== 2) {
            throw new Error(`Invalid pair format: ${pair}`);
        }
        const baseAsset = parts[0];
        if (!baseAsset || baseAsset.length === 0) {
            throw new Error(`Invalid pair format: ${pair}`);
        }
        return baseAsset;
    }

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Service

    `SyncEngineService.ts` создан как Singleton и корректно принимает все 5 зависимостей.

2.  **\[API (All)\]** `reconcileStateAll()` реализован и использует `for...of` (последовательный `await`) для вызова `reconcileStateForPair`.
3.  **\[API (Pair) (Критично)\]** `reconcileStateForPair()` _полностью_ оборачивает свою логику в `this.pairActorManager.execute()`.
4.  **\[API (Pair)\]** Внутри `execute()` `reconcileStateForPair` _сначала_ получает `exchangeOrders`, `dbOrders` и `dbPositions` через `Promise.all`.
5.  **\[Stubs\]** `reconcileStateForPair` _последовательно_ вызывает приватные методы-заглушки: `_reconcileOrders`, `_reconcilePositionsForensic` и `_reconcileOpenLimitOrders`.
6.  **\[Stubs\]** Все три приватных метода-заглушки созданы, имеют корректные сигнатуры (принимают `pair` и состояния) и логгируют (STUB).
