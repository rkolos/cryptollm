# Техническое Задание (ТЗ): 5.0 Движок Синхронизации (SyncEngine) - API Сервиса

**Эпик:** 5. 🔄 "Наблюдатель" (Watcher) - Синхронизация, Циклы и Триггеры **Задача:** 5.0, 5.1, 5.1.1 и **5.1.2 (Исполнение `OPEN_LIMIT`)** **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать **Singleton-сервис** `SyncEngineService`, который выступает в роли "аудитора" системы. Его задача — **автоматически устранять расхождения** между состоянием в нашей БД (`ActiveOrders`, `ActivePositions`, `TradeHistory`) и реальным состоянием на бирже.

Эта задача объединяет создание публичного API (5.0), логики сверки ордеров (5.1), логики восстановления позиций (5.1.1) и **реализует логику обработки исполненных `OPEN_LIMIT` ордеров (Задача 5.1.2)**.

## 2\. Архитектурное Решение

1.  **Actor-lite (Критично):** Все публичные методы сверки (`reconcileStateForPair`, `reconcileStateAll`) _обязаны_ использовать `PairActorManagerService` (Эпик 9). Это гарантирует, что сверка не будет конфликтовать с `Worker` или `TSLHandler`.
2.  **Атомарность (Критично):** Любая операция, изменяющая БД (очистка ордера-призрака, восстановление позиции, **конвертация `limit_open`**), _обязана_ быть обернута в `DatabaseService.executeInTransaction()`.
3.  **Параллельная Загрузка:** Сбор всех исходных данных (ордера, позиции, баланс) _обязан_ выполняться параллельно с использованием `Promise.allSettled` для отказоустойчивости.
4.  **"Судебная" Логика (5.1.1):** Логика восстановления _обязана_ использовать `decimal.js` для пересчета `avgEntryPrice` и `amount` на основе всей `TradeHistory`.

## 3\. Зависимости Задачи

- **`LoggingService` (1.4):** (Зависимость)
- **`PairActorManagerService` (9.1):** (Зависимость) Для сериализации операций.
- **`IExchangeService` (3.1 / 3.5):** (Зависимость) Для `fetchOpenOrders()`, `fetchMyTrades()`, `fetchBalance()`.
- **`DatabaseService` (2.3):** (Зависимость) Для `query()` и `executeInTransaction()`.
- **`GuaranteedOrderExecutionService` (7.0):** (Зависимость) Для `cancelOrderWithRetry()` и **(Новое в 5.1.2) `createOrderWithRetry()`**.
- **`ExchangeRulesService` (3.2):** (Зависимость) Для определения `baseAsset` (e.g., 'ETH' из 'ETH/USDT').
- **`ccxt` (1.2):** (Зависимость) Для типов `ccxt.Order` и `ccxt.Balance`.
- **`decimal.js` (1.2):** (Зависимость) Для финансовых расчетов в 5.1.1 и 5.1.2.

## 4\. Описание и Нюансы Реализации

### 4.1. Метод `reconcileStateForPair(pair: string)`

1.  **Враппер (Критично):** Весь код _обязан_ быть обернут в `await this.pairActorManager.execute(pair, async () => { ... })`.
2.  **Сбор Данных (Критично):** _обязан_ выполнить `Promise.allSettled` для получения: `fetchOpenOrders`, `query(ActiveOrders)`, `query(ActivePositions)`, и **`fetchBalance()`** (для получения баланса базового актива, e.g., BTC).
3.  **Обработка Сбоя:** Если _любой_ из этих запросов завершился `rejected`, _обязан_ залогировать ошибку и немедленно выйти (`return`) из "актора".
4.  **Вызов Логики:** При успехе _обязан_ вызвать последовательно:
    - `await this._reconcileOrders(pair, ...)` (Задача 5.1).
    - `await this._reconcilePositionsForensic(pair, ...)` (Задача 5.1.1).
    - `await this._reconcileOpenLimitOrders(pair, ...)` (Задача 5.1.2 - **реализуется здесь**).

### 4.2. Метод `_reconcileOrders(pair, exchangeOrders, dbOrders)` (Задача 5.1)

1.  **Сценарий 3 ("Зомби"):** _обязан_ найти ордера, которые есть на бирже, но нет в БД. _обязан_ немедленно вызвать `executionService.cancelOrderWithRetry()` для их отмены.
2.  **Сценарий 4 ("Призраки"):** _обязан_ найти ордера, которые есть в БД, но нет на бирже. _обязан_ **атомарно** (в `executeInTransaction`) удалить их из таблиц `ActiveOrders` и `TSL_State`.

### 4.3. Метод `_reconcilePositionsForensic(pair, dbPositions, dbOrders, baseAssetBalance)` (Задача 5.1.1)

1.  **Условие Запуска (Критично):** Логика _обязана_ быть выполнена, **только если** `baseAssetBalance.greaterThan(0)` И `dbPositions.length === 0`.
2.  **Транзакция (Критично):** _Вся_ логика восстановления _обязана_ быть обернута в `this.dbService.executeInTransaction()`.
3.  **Шаг 1 (Сбор Истории):** _обязан_ вызвать `exchangeService.fetchMyTrades(pair)` и `dbService.query('SELECT * FROM TradeHistory')`.
4.  **Шаг 2 (Интеграция):** _обязан_ найти "потерянные" сделки (`missingTrades`) и атомарно `INSERT` их в `TradeHistory`.
5.  **Шаг 3 (Реконструкция):** _обязан_ вызвать приватный метод `_reconstructPositionFromHistory(pair, client)` для расчета `avgEntryPrice` и `amount` на основе _всей_ `TradeHistory`.
6.  **Шаг 4 (Сохранение):** _обязан_ `INSERT` восстановленную позицию в `ActivePositions`. **Критично:** `stop_loss_price` и `take_profit_price` _обязаны_ быть `NULL` (или `0`), а `status` _обязан_ быть 'reconciled'.

### 4.4. Метод `_reconstructPositionFromHistory(pair, client)` (Вспомогательный)

1.  **Логика (Критично):** _обязан_ выполнить `SELECT * FROM TradeHistory WHERE pair = $1 ORDER BY timestamp ASC`.
2.  **Расчет (Критично):** _обязан_ итерировать по всем сделкам и использовать **`decimal.js`** для инкремента/декремента `totalAmount` и `totalCost` (`cost = amount * price`).
3.  **Итог:** _обязан_ вернуть `avgEntryPrice = totalCost / totalAmount` и `amount = totalAmount.abs()`.
4.  **Сценарий 0:** Если `totalAmount` после итерации меньше или равно `0`, _обязан_ вернуть `null` (позиция закрыта).

### 4.5. Метод `_reconcileOpenLimitOrders(pair, exchangeOrders, dbOrders)` (Задача 5.1.2)

1.  **Поиск Цели:** _обязан_ найти все ордера в `dbOrders`, где `type === 'limit_open'` и `status === 'open'`.
2.  **Условие Конвертации (Критично):** _обязан_ начать процесс конвертации, **только если**: (A) Ордера _нет_ в списке `exchangeOrders` (т.е., он исполнился/исчез), ИЛИ (Б) Ордер есть, но его `status` на бирже `'closed'` и `filled > 0`.
3.  **Получение Деталей (Критично):** _обязан_ получить **реальные** детали исполнения (`realAmount`, `realEntryPrice`, `realFee`). _обязан_ использовать `exchangeService.fetchMyTrades` для надежного получения этих данных.
4.  **Шаг 1: Создание SL/TP (Критично):** _обязан_ вызвать `executionService.createOrderWithRetry()` для создания SL (STOP_LOSS_LIMIT) и, если указано, TP (TAKE_PROFIT_LIMIT) ордеров **на бирже**. _обязан_ делать это _до_ транзакции БД.
5.  **Шаг 2: Атомарное Обновление (Критично):** _обязан_ обернуть **всю** логику обновления в `this.dbService.executeInTransaction()`:
    - **Удалить** старый `limit_open` ордер из `ActiveOrders`.
    - **Вставить** новую `ActivePosition` (используя `realEntryPrice` и `realAmount`).
    - **Вставить** SL и TP ордера в `ActiveOrders` (используя их **реальные** ID с биржи).
    - **Вставить** сделку в `TradeHistory`.

6.  **Отказоустойчивость:** _обязан_ использовать `try/catch` вокруг Шага 1 и Шага 2. Если Шаг 1 успешен, а Шаг 2 (`executeInTransaction`) _провалился_, _обязан_ залогировать **КРИТИЧЕСКИЙ** сбой. При этом ордера SL/TP останутся на бирже как "зомби", но они будут автоматически отменены `_reconcileOrders` на следующей итерации сверки.

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Service

    `SyncEngineService.ts` корректно принимает _все 7 зависимостей_ (включая `GuaranteedOrderExecutionService` и `ExchangeRulesService`).

2.  API(Pair)

    `reconcileStateForPair()` _обязан_ обернуть логику в `PairActorManager.execute()`.

3.  API(DataFetch)

    `reconcileStateForPair()` _обязан_ использовать `Promise.allSettled` для параллельной загрузки 4-х ключевых наборов данных, включая `fetchBalance()`.

4.  Logic5.1

    `_reconcileOrders` _обязан_ использовать `executionService.cancelOrderWithRetry()` для "зомби" и `dbService.executeInTransaction()` для "призраков".

5.  Logic5.1.1(Trigger)

    Логика "судебной" сверки _обязана_ запускаться **только** при условии: `baseAssetBalance.greaterThan(0)` И `dbPositions.length === 0`.

6.  Logic5.1.1(Transaction)

    _Вся_ основная логика "судебной" сверки _обязана_ быть обернута в `this.dbService.executeInTransaction()`.

7.  Helper(5.1.1)

    Создан приватный метод `_reconstructPositionFromHistory(pair, client)`.

8.  Helper(Accuracy)

    Логика `_reconstructPositionFromHistory` _обязана_ использовать **`decimal.js`** для всех кумулятивных расчетов (`totalAmount`, `totalCost`) и возвращать `null`, если финальный `totalAmount <= 0`.

9.  Logic5.1.1(FinalInsert)

    Реализована логика `INSERT INTO ActivePositions` для восстановленной позиции, где SL/TP _обязаны_ быть `NULL`, а статус - 'reconciled'.

10. Logic5.1.2(Trigger)


    `_reconcileOpenLimitOrders` _обязан_ корректно найти `dbOrders` с `type === 'limit_open'` и _исполненный_ ордер на бирже.

11. API(5.1.2Step1)


    Реализована логика (`try/catch`) для _создания_ SL/TP ордеров (через `executionService.createOrderWithRetry`) _до_ транзакции БД.

12. DB(5.1.2Step2)


    _Вся_ логика обновления БД (удаление `limit_open`, вставка `ActivePosition`, вставка `ActiveOrder SL/TP`) _обязана_ быть _атомарно_ обернута в `this.dbService.executeInTransaction()`.

13. Robustness(5.1.2)


    Реализована логика обработки ошибок, которая логгирует `CRITICAL` сбой, но _не_ ломает `SyncEngine`, полагаясь на то, что SL/TP будут удалены как "зомби" на следующем цикле.
