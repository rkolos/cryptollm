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
        - Получить `const currentPrice = new Decimal(ticker.last);`
        - **Вызвать приватный обработчик логики:** `const requiredUpdate = this._calculateTSL(tslRule, currentPrice);`
        - **Если `requiredUpdate` (возвращает `newStopPrice`):**
          - `this.logger.info(`(TSLHandler) \[${pair}\] TSL UPDATE: Цена ${currentPrice}. Двигаем SL с ${tslRule.state.currentStopPrice} на ${requiredUpdate.newStopPrice}`);`
          - **(Задача 9.3) Вызов "Актора" (Fire-and-Forget):**
          - `this.pairActorManager.execute(pair, async () => { ... })` (Вызвать _без_ `await`):
            - `(async () => {`
            - `await this._updateStopLossOrder(pair, tslRule, requiredUpdate.newStopPrice, currentPrice);`
            - `});`

          - `.catch((e) => { ... (Логировать ошибку "актора", Задача 9.1) ... });`

      - **`} catch (e: any) {`**
        - `this.logger.error(`(TSLHandler) \[${ticker.symbol}\] КРИТИЧЕСКИЙ СБОЙ: ${e.message}`, e.stack);`
        - `// (Не бросаем ошибку, чтобы не "убить" WS-цикл)`

      - **`}`**

### 4.4. Приватный Метод `private _calculateTSL(tslRule, currentPrice)`

- **Нюанс реализации:** Чистая, синхронная функция, использующая `decimal.js`.
- **Логика (согласно `about.md`):**
  1.  `(Логика для 'long' позиции)`
  2.  `if (tslRule.position.side === 'long' && currentPrice.greaterThan(tslRule.state.highestPrice))`
  3.  `const newStopPrice = currentPrice.times(new Decimal(1).minus(tslRule.rule.distance.dividedBy(100)));`
  4.  `if (newStopPrice.greaterThan(tslRule.state.currentStopPrice))`
  5.  `return { newStopPrice, newHighestPrice: currentPrice };`
  6.  `(Аналогичная логика для 'short' позиции, используя` lowestPrice`)`
  7.  `return null;` (Обновление не требуется).

### 4.5. Приватный Метод `private async _updateStopLossOrder(pair, tslRule, newStopPrice, currentPrice)`

- **Нюанс реализации:** Этот метод _всегда_ выполняется _внутри_ "актора" (`PairActorManager`).
- **Логика:**
  1.  **Шаг 1. Отмена Старого SL (Гарантированно):**
      - `await this.guaranteedExecutor.cancelOrderWithRetry(tslRule.state.currentStopOrderId, pair);`

  2.  **Шаг 2. Создание Нового SL (Гарантированно):**
      - Получить `const newSlOrder = await this.guaranteedExecutor.createStopLossOrderWithRetry(pair, tslRule.position.amount, newStopPrice, ...);`

  3.  **Шаг 3. Атомарное Обновление БД (Критично):**
      - `await this.dbService.executeInTransaction(async (client) => { ... })`
      - **Внутри транзакции:**
        - **1\. Обновить `TSL_State`:**
          - `UPDATE TSL_State SET currentStopPrice = $1, highestPrice = $2 (или lowestPrice), currentStopOrderId = $3 WHERE pair = $4`
          - (Передать `newStopPrice`, `currentPrice`, `newSlOrder.id`, `pair`)

        - **2\. Удалить старый `ActiveOrders`:**
          - `DELETE FROM ActiveOrders WHERE exchange_order_id = $1`
          - (Передать `tslRule.state.currentStopOrderId`)

        - **3\. Добавить новый `ActiveOrders`:**
          - `INSERT INTO ActiveOrders (exchange_order_id, pair, type, ...) VALUES ($1, $2, 'stop_loss', ...)`
          - (Передать `newSlOrder.id`, `pair`, ...)

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Service

    `TSLHandlerService.ts` создан и корректно принимает все 5 зависимостей (включая `AccountStateService` и `PairActorManagerService`).

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

13. **\[Actor (DB)\]** Транзакция _корректно_ и _атомарно_ выполняет 3 DML-операции: `UPDATE TSL_State`, `DELETE ActiveOrders` (старый), `INSERT ActiveOrders` (новый).
