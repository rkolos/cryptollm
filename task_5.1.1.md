# Техническое Задание (ТЗ): 5.0 Движок Синхронизации (SyncEngine) - API Сервиса

**Эпик:** 5. 🔄 "Наблюдатель" (Watcher) - Синхронизация, Циклы и Триггеры **Задача:** 5.0, 5.1 (Сверка Ордеров) и **5.1.1 ("Судебная" Сверка Позиций)** **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать **Singleton-сервис** `SyncEngineService`, который выступает в роли "аудитора" системы. Его задача — **автоматически устранять расхождения** между состоянием в нашей БД (`ActiveOrders`, `ActivePositions`, `TradeHistory`) и реальным состоянием на бирже.

Эта задача объединяет создание публичного API (5.0), логики сверки ордеров (5.1) и логики восстановления позиций (5.1.1).

## 2\. Архитектурное Решение

1.  **Actor-lite (Критично):** Все публичные методы сверки (`reconcileStateForPair`, `reconcileStateAll`) _обязаны_ использовать `PairActorManagerService` (Эпик 9). Это гарантирует, что сверка не будет конфликтовать с `Worker` или `TSLHandler`.
2.  **Атомарность (Критично):** Любая операция, изменяющая БД (очистка ордера-призрака, восстановление позиции), _обязана_ быть обернута в `DatabaseService.executeInTransaction()`.
3.  **Параллельная Загрузка:** Сбор всех исходных данных (ордера, позиции, баланс) _обязан_ выполняться параллельно с использованием `Promise.allSettled` для отказоустойчивости.
4.  **"Судебная" Логика (5.1.1):** Логика восстановления _обязана_ использовать `decimal.js` для пересчета `avgEntryPrice` и `amount` на основе всей `TradeHistory`.

## 3\. Зависимости Задачи

- **`LoggingService` (1.4):** (Зависимость)
- **`PairActorManagerService` (9.1):** (Зависимость) Для сериализации операций.
- **`IExchangeService` (3.1 / 3.5):** (Зависимость) Для `fetchOpenOrders()`, `fetchMyTrades()`, `fetchBalance()`.
- **`DatabaseService` (2.3):** (Зависимость) Для `query()` и `executeInTransaction()`.
- **`GuaranteedOrderExecutionService` (7.0):** (Зависимость) Для надежной отмены ордеров-зомби.
- **`ExchangeRulesService` (3.2):** (Зависимость) Для определения `baseAsset` (e.g., 'ETH' из 'ETH/USDT').
- **`decimal.js` (1.2):** (Зависимость) Для финансовых расчетов в 5.1.1.

## 4\. Описание и Нюансы Реализации

### 4.1. Метод `reconcileStateForPair(pair: string)`

1.  **Враппер (Критично):** Весь код _обязан_ быть обернут в `await this.pairActorManager.execute(pair, async () => { ... })`.
2.  **Сбор Данных (Критично):** _обязан_ выполнить `Promise.allSettled` для получения: `fetchOpenOrders`, `query(ActiveOrders)`, `query(ActivePositions)`, и **`fetchBalance()`** (для получения баланса базового актива, e.g., BTC).
3.  **Обработка Сбоя:** Если _любой_ из этих запросов завершился `rejected`, _обязан_ залогировать ошибку и немедленно выйти (`return`) из "актора".
4.  **Вызов Логики:** При успехе _обязан_ вызвать последовательно:
    - `await this._reconcileOrders(pair, ...)` (Задача 5.1).
    - `await this._reconcilePositionsForensic(pair, ...)` (Задача 5.1.1).
    - `await this._reconcileOpenLimitOrders(pair, ...)` (Задача 5.1.2 - пока заглушка).

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

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Service

    `SyncEngineService.ts` корректно принимает _все 7 зависимостей_ через DI.

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

7.  Logic5.1.1(DB)

    Реализована логика сравнения `exchangeTrades` с `dbTradeIds` и `INSERT` недостающих сделок в `TradeHistory`.

8.  Helper(5.1.1)

    Создан приватный метод `_reconstructPositionFromHistory(pair, client)`.

9.  Helper(Accuracy)

    Логика `_reconstructPositionFromHistory` _обязана_ использовать **`decimal.js`** для всех кумулятивных расчетов (`totalAmount`, `totalCost`) и возвращать `null`, если финальный `totalAmount <= 0`.

10. Logic5.1.1(FinalInsert)


    Реализована логика `INSERT INTO ActivePositions` для восстановленной позиции, где SL/TP _обязаны_ быть `NULL`, а статус - 'reconciled'.
