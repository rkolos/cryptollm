# Техническое Задание (ТЗ): 5.4 Обработчик TSL (TSLHandlerService)

**Эпик:** 5. 🔄 "Наблюдатель" (Watcher) - Синхронизация, Циклы и Триггеры **Задача:** 5.4. Обработчик TSL (TSLHandlerService) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать `TSLHandlerService` (Singleton) — высокопроизводительный сервис, отвечающий за _немедленную_ (real-time) обработку логики Trailing Stop Loss (TSL) для _каждого_ "тика" (обновления цены), полученного от `FastCycleService`.

## 2\. Архитектурное Решение

1.  **Синхронный `handleTicker`:** Сервис предоставляет единственный публичный метод `handleTicker(ticker)`, который вызывается `FastCycleService` (Задача 5.3). Этот метод _обязан_ быть синхронным (не `async`) и немедленно возвращать управление.
2.  **Доступ к Кэшу (Критично):** `TSLHandlerService` _не_ обращается к БД напрямую в `handleTicker`. Он _обязан_ зависеть от `AccountStateService` (Задача 4.5) и использовать его синхронный метод `getAccountState()`, чтобы получить `in-memory` кэш всех активных правил `TSL_State`.
3.  **Математика TSL (`decimal.js`):** Вся логика сравнения цен (e.g., `current_price > tsl.state.highestPrice`) и расчет нового стопа (`current_price * (1 - tsl.rule.distance / 100)`) _обязаны_ использовать `decimal.js` для избежания ошибок с плавающей запятой (согласно `about.md`).
4.  **Асинхронное Исполнение (Задача 9.3):** Если `handleTicker` обнаруживает, что SL _необходимо_ обновить, он _не_ выполняет `await`. Он _немедленно_ (в режиме "fire-and-forget") передает задачу (`_updateStopLossOrder`) в `PairActorManagerService.execute()`, которая гарантирует, что обновление SL не вступит в "гонку" с другими операциями (`SyncEngine`, `Worker`).

## 3\. Зависимости Задачи

- **`LoggingService` (1.4):** (Зависимость) Для логирования.
- **`AccountStateService` (4.5):** (Зависимость) **(Критично)** Для `getAccountState()`, чтобы получить `in-memory` кэш `TSL_State`.
- **`PairActorManagerService` (9.1):** (Зависимость) **(Критично)** Для `execute()` (реализация Задачи 9.3).
- **`GuaranteedOrderExecutionService` (7.0):** (Зависимость) Будет использоваться _внутри_ "актора" для `cancelOrderWithRetry` и `createOrderWithRetry`.
- **`DatabaseService` (2.3):** (Зависимость) Будет использоваться _внутри_ "актора" для `executeInTransaction()`.

## 4\. Описание и Нюансы Реализации

### 4.1. Создание `src/services/TSLHandlerService.ts`

Разработчик должен создать `src/services/TSLHandlerService.ts` (Singleton), который принимает в конструкторе все 5 зависимостей.

### 4.2. Обновление `AccountStateService` (Задача 4.5)

**Архитектурное Требование (Напоминание):** Разработчик _должен_ убедиться, что `AccountStateService` (Задача 4.5) _корректно_ загружает `SELECT * FROM TSL_State` и помещает результат в свой `in-memory` кэш (`globalAccountState`), преобразуя его в `Map<string, TSLRule>` (где `string` — это `pair`) для быстрого доступа.

### 4.3. Публичный Метод `public handleTicker(ticker: Ticker): void`

Это "сердце" сервиса, вызываемое _на каждый "тик"_.

- **Нюанс реализации:** Этот метод **НЕ `async`**.
- **Логика:**
  1.  **Проверка Состояния (Критично):**
      - `(Примечание:` FastCycleService`(5.3) *уже* выполнил проверку`GlobalStateService`. Повторная проверка здесь не обязательна, но желательна, если` handleTicker `будет вызываться из других мест в будущем).`

  2.  **Блок `try/catch`:**
      - **`try {`**
        - `const pair = ticker.symbol;`
        - Получить `const state = this.accountStateService.getAccountState();`
        - Получить `const tslRule = state.tslRules.get(pair);`
        - **Если `!tslRule`:** `return;` (Для этой пары нет TSL, выходим).
        - Получить `const currentPriceDecimal = ticker.last as any;`
        - Получить `const currentPrice = new DecimalConstructor(currentPriceDecimal.toString());`
        - **Вызвать приватный обработчик логики:** `const requiredUpdate = this._calculateTSL(tslRule, currentPrice);`
        - **Если `requiredUpdate` (возвращает объект с `newStopPrice` и `newPriceSeen`):**
          - `this.logger.info(`(TSLHandler) [${pair}] TSL UPDATE: Цена ${currentPrice.toString()}. Двигаем SL с ${tslRule.state.currentStopPrice.toString()} на ${requiredUpdate.newStopPrice.toString()}`);`
          - **(Задача 9.3) Вызов "Актора" (Fire-and-Forget):**
          - `this.pairActorManager.execute(pair, async () => { ... }).catch((e) => { ... })` (Вызвать _без_ `await`):
            - Внутри актора: `await this._updateStopLossOrder(pair, tslRule, requiredUpdate.newStopPrice, currentPrice);`
            - В `.catch()`: залогировать `error` об ошибке актора.

      - **`} catch (error) {`**
        - `this.logger.error(`(TSLHandler) [${ticker.symbol}] КРИТИЧЕСКИЙ СБОЙ: ${String(error)}`, error);`
        - `// (Не бросаем ошибку, чтобы не "убить" WS-цикл)`

      - **`}`**

### 4.4. Приватный Метод `private _calculateTSL(tslRule, currentPrice)`

- **Нюанс реализации:** Чистая, синхронная функция, использующая `decimal.js`.
- **Логика (согласно `about.md`):**
  1.  Извлечь `const { position, state, rule } = tslRule;`
  2.  **Для 'long' позиции:**
      - Если `currentPrice.greaterThan(state.priceSeen)`:
        - Рассчитать `newStopPrice = currentPrice.times(one.minus(distancePercent))`, где `distancePercent = rule.distance.dividedBy(100)`.
        - Если `newStopPrice.greaterThan(state.currentStopPrice)`, вернуть `{ newStopPrice, newPriceSeen: currentPrice }`.
  3.  **Для 'short' позиции:**
      - Если `currentPrice.lessThan(state.priceSeen)`:
        - Рассчитать `newStopPrice = currentPrice.times(one.plus(distancePercent))`.
        - Если `newStopPrice.lessThan(state.currentStopPrice)`, вернуть `{ newStopPrice, newPriceSeen: currentPrice }`.
  4.  `return null;` (Обновление не требуется).

### 4.5. Приватный Метод `private async _updateStopLossOrder(pair, tslRule, newStopPrice, currentPrice)`

- **Нюанс реализации:** Этот метод _всегда_ выполняется _внутри_ "актора" (`PairActorManager`).
- **Логика:**
  1.  **Шаг 1. Отмена Старого SL (Гарантированно):**
      - `await this.guaranteedExecutor.cancelOrderWithRetry(tslRule.state.currentStopOrderId, pair);`

  2.  **Шаг 2. Создание Нового SL (Гарантированно):**
      - Определить `const oppositeSide: 'buy' | 'sell' = position.side === 'long' ? 'sell' : 'buy';`
      - Вызвать `await this.guaranteedExecutor.createOrderWithRetry(pair, 'stop_loss_limit', oppositeSide, position.amount, newStopPrice, { stopPrice: newStopPrice.toString() })`.
      - Залогировать `info` о создании нового SL ордера.

  3.  **Шаг 3. Атомарное Обновление БД (Критично):**
      - `await this.dbService.executeInTransaction(async (client) => { ... })`
      - **Внутри транзакции:**
        - **1\. Обновить `TSL_State`:**
          - `UPDATE TSL_State SET current_stop_price = $1, current_stop_order_id = $2, price_seen = $3, updated_at = NOW() WHERE pair = $4`
          - (Передать `newStopPrice.toString()`, `newSlOrder.id`, `currentPrice.toString()`, `pair`)

        - **2\. Удалить старый `ActiveOrders`:**
          - `DELETE FROM ActiveOrders WHERE exchange_order_id = $1`
          - (Передать `tslRule.state.currentStopOrderId`)

        - **3\. Добавить новый `ActiveOrders`:**
          - `INSERT INTO ActiveOrders (exchange_order_id, pair, type, ...) VALUES ($1, $2, 'stop_loss', ...)`
          - (Передать `newSlOrder.id`, `pair`, ...)

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Service

    `TSLHandlerService.ts` создан как Singleton с методом `getInstance(accountStateService, pairActorManager, guaranteedExecutor, databaseService)` и корректно принимает все 4 зависимости.

2.  **\[Dependency\]** `AccountStateService` (4.5) _обновлен_ для включения `TSL_State` в свой `in-memory` кэш, доступный через `getAccountState()`.
3.  **\[API\]** `handleTicker(ticker)` _не_ является `async` и _не_ содержит `await` верхнего уровня.
4.  **\[Core (Cache)\]** `handleTicker` _корректно_ и _синхронно_ получает `tslRule` из `this.accountStateService.getAccountState()`.
5.  **\[Core (Logic)\]** Реализован приватный метод `_calculateTSL`, который _корректно_ использует `decimal.js` для расчета нового SL (согласно `about.md`).
6.  **\[Core (Logic)\]** `handleTicker` _корректно_ вызывает `_calculateTSL` и проверяет, `if (requiredUpdate)`.
7.  **\[Concurrency (Задача 9.3)\]** Если обновление _требуется_, `handleTicker` _корректно_ вызывает `this.pairActorManager.execute()` _без_ `await` (в режиме "fire-and-forget").
8.  **\[Concurrency (Задача 9.3)\]** Вызов `pairActorManager.execute` _корректно_ имеет `.catch()` для обработки ошибок "актора".
9.  **\[Actor\]** _Внутри_ "актора" реализован приватный `async` метод `_updateStopLossOrder`.
10. **\[Actor (Step 1)\]** `_updateStopLossOrder` _корректно_ вызывает `await this.guaranteedExecutor.cancelOrderWithRetry()`.

11. **\[Actor (Step 2)\]** `_updateStopLossOrder` _корректно_ вызывает `await this.guaranteedExecutor.createStopLossOrderWithRetry()` (или аналогичный).

12. **\[Actor (Step 3)\]** `_updateStopLossOrder` _корректно_ вызывает `await this.dbService.executeInTransaction()`.

13. **\[Actor (DB)\]** Транзакция _корректно_ и _атомарно_ выполняет 3 DML-операции: `UPDATE TSL_State` (с обновлением `current_stop_price`, `current_stop_order_id`, `price_seen`, `updated_at`), `DELETE ActiveOrders` (старый), `INSERT ActiveOrders` (новый).

14. **\[ErrorHandling\]** Если транзакция БД провалилась, `_updateStopLossOrder` отменяет новый SL ордер на бирже через `cancelOrderWithRetry` для предотвращения "зомби" ордера.

15. **\[CalculateTSL\]** Метод `_calculateTSL` использует `state.priceSeen` вместо `state.highestPrice`/`state.lowestPrice` для сравнения цен.
