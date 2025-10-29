# Техническое Задание (ТЗ): 5.5 Обработчик Триггеров Цены (PriceTriggerHandler)

**Эпик:** 5. 🔄 "Наблюдатель" (Watcher) - Синхронизация, Циклы и Триггеры **Задача:** 5.5. Обработчик Триггеров Цены (PriceTriggerHandler) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать `PriceTriggerHandler` (Singleton) — высокопроизводительный сервис, отвечающий за _немедленную_ (real-time) проверку `price` триггеров (установленных LLM) для _каждого_ "тика" (обновления цены), полученного от `FastCycleService`.

## 2\. Архитектурное Решение

1.  **Синхронный `handleTicker`:** Сервис предоставляет единственный публичный метод `handleTicker(ticker)`, который вызывается `FastCycleService` (Задача 5.3). Этот метод _обязан_ быть синхронным (не `async`).
2.  **Доступ к Кэшу (Критично):** `PriceTriggerHandler` _не_ обращается к БД напрямую в `handleTicker`. Он _обязан_ зависеть от `AccountStateService` (Задача 4.5) и использовать его синхронный метод `getAccountState()`, чтобы получить `in-memory` кэш:
    - `LLM_Triggers` (из таблицы `LLM_Triggers`).
    - `ActiveOrders` (из таблицы `ActiveOrders`).

3.  **Логика `OPEN_LIMIT` (согласно 5.5):** Этот сервис _обязан_ реализовывать "предохранитель": если `price` триггер сработал, но для этой пары уже существует `OPEN_LIMIT` ордер в кэше `ActiveOrders`, `handleTicker` _должен_ проигнорировать триггер и немедленно выйти (`return`). Это предотвращает "гонку" с `SyncEngine` (Задача 5.1.2).
4.  **Математика (`decimal.js`):** Вся логика сравнения цен (e.g., `currentPrice.lessThan(condition.value)`) _обязана_ использовать `decimal.js`.
5.  **Асинхронное Исполнение (Задача 9.3):** Если `handleTicker` обнаруживает, что триггер сработал (и "предохранитель" `OPEN_LIMIT` неактивен), он _не_ выполняет `await`. Он _немедленно_ (в режиме "fire-and-forget") передает задачу (`WatcherOrchestrator.executeOrchestration`) в `PairActorManagerService.execute()`.

## 3\. Зависимости Задачи

- **`LoggingService` (1.4):** (Зависимость) Для логирования.
- **`AccountStateService` (4.5):** (Зависимость) **(Критично)** Для `getAccountState()`, чтобы получить `in-memory` кэш `LLM_Triggers` и `ActiveOrders`.
- **`PairActorManagerService` (9.1):** (Зависимость) **(Критично)** Для `execute()` (реализация Задачи 9.3).
- **`WatcherOrchestratorService` (5.6):** (Зависимость) **(Критично)** Будет вызываться _внутри_ "актора".

## 4\. Описание и Нюансы Реализации

### 4.1. Создание `src/services/PriceTriggerHandler.ts`

Разработчик должен создать `src/services/PriceTriggerHandler.ts` (Singleton), который принимает в конструкторе все 4 зависимости.

### 4.2. Обновление `AccountStateService` (Задача 4.5)

**Архитектурное Требование (Напоминание):** Разработчик _должен_ убедиться, что `AccountStateService` (Задача 4.5) _корректно_ загружает `SELECT * FROM LLM_Triggers` и помещает результат в свой `in-memory` кэш (`globalAccountState`), преобразуя его в `Map<string, TriggerCondition[]>` (где `string` — это `pair`) для быстрого доступа.

### 4.3. Публичный Метод `public handleTicker(ticker: Ticker): void`

Это "сердце" сервиса, вызываемое _на каждый "тик"_.

- **Нюанс реализации:** Этот метод **НЕ `async`**.
- **Логика:**
  1.  **Проверка Состояния (Примечание):**
      - `(Примечание:` FastCycleService`(5.3) *уже* выполнил проверку`GlobalStateService`. Повторная проверка здесь не обязательна.)`

  2.  **Блок `try/catch`:**
      - **`try {`**
        - `const pair = ticker.symbol;`
        - Получить `const state = this.accountStateService.getAccountState();`
        - Получить `const triggerConditions = state.llmTriggers.get(pair);`
        - **Если `!triggerConditions`:** `return;` (Для этой пары нет триггеров, выходим).
        - Получить `const currentPrice = new Decimal(ticker.last);`
        - **Вызвать приватный обработчик логики:** `const triggeredCondition = this._findPriceTrigger(triggerConditions, currentPrice);`
        - **Если `triggeredCondition`:**
          - `// Триггер сработал. Проверяем "предохранитель" (Задача 5.5).`
          - Получить `const openLimitOrder = this._findOpenLimitOrder(state.activeOrders, pair);`
          - **Если `openLimitOrder`:**
            - `this.logger.debug(`(PriceHandler) \[${pair}\] Price trigger ${triggeredCondition.value} hit, but ignored due to active OPEN_LIMIT order.`);`
            - `return;` (Игнорируем, `SyncEngine` (5.1.2) справится).

          - `// "Предохранитель" не сработал, передаем управление Оркестратору`
          - `this.logger.info(`(PriceHandler) \[${pair}\] Price trigger hit: ${currentPrice} ${triggeredCondition.condition} ${triggeredCondition.value}. Calling Orchestrator.`);`
          - **\_ (Задача 9.3) Вызов "Актора" (Fire-and-Forget): \_**
          - `this.pairActorManager.execute(pair, async () => { ... })` (Вызвать _без_ `await`):
            - `(async () => {`
            - `await this.orchestrator.executeOrchestration(pair, "Price Trigger Hit");`
            - `});`

          - `.catch((e) => { ... (Логировать ошибку "актора", Задача 9.1) ... });`

      - **`} catch (e: any) {`**
        - `this.logger.error(`(PriceHandler) \[${ticker.symbol}\] КРИТИЧЕСКИЙ СБОЙ: ${e.message}`, e.stack);`
        - `// (Не бросаем ошибку, чтобы не "убить" WS-цикл)`

      - **`}`**

### 4.4. Приватный Метод `private _findPriceTrigger(conditions, currentPrice)`

- **Нюанс реализации:** Чистая, синхронная функция, использующая `decimal.js`.
- **Логика:**
  1.  Найти _первый_ `condition` в `conditions`, где `condition.type === 'price'`.
  2.  Проверить, используя `decimal.js`:
      - `if (condition.condition === 'below' && currentPrice.lessThan(condition.value)) return condition;`
      - `if (condition.condition === 'above' && currentPrice.greaterThan(condition.value)) return condition;`

  3.  `return null;` (Триггер не сработал).

### 4.5. Приватный Метод `private _findOpenLimitOrder(activeOrders, pair)`

- **Нюанс реализации:** Чистая, синхронная функция.
- **Логика:**
  1.  Найти _первый_ `order` в `activeOrders`, где `order.pair === pair` И `order.type === 'limit_open'` И `order.status === 'open'`.
  2.  `return order || null;`

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Service

    `PriceTriggerHandler.ts` создан и корректно принимает все 4 зависимости.

2.  **\[Dependency\]** `AccountStateService` (4.5) _обновлен_ для включения `LLM_Triggers` в свой `in-memory` кэш, доступный через `getAccountState()`.
3.  **\[API\]** `handleTicker(ticker)` _не_ является `async` и _не_ содержит `await` верхнего уровня.
4.  **\[Core (Cache)\]** `handleTicker` _корректно_ и _синхронно_ получает `llmTriggers` И `activeOrders` из `this.accountStateService.getAccountState()`.
5.  **\[Core (Logic)\]** Реализован приватный метод `_findPriceTrigger`, который _корректно_ использует `decimal.js` для сравнения цен.
6.  **\[Core (Logic - 5.5)\]** Реализован приватный метод `_findOpenLimitOrder` (предохранитель).
7.  **\[Core (Logic - 5.5)\]** `handleTicker` _корректно_ проверяет `if (openLimitOrder)` и _игнорирует_ триггер (делает `return`), если `OPEN_LIMIT` найден.
8.  **\[Concurrency (Задача 9.3)\]** Если триггер сработал (и `OPEN_LIMIT` не найден), `handleTicker` _корректно_ вызывает `this.pairActorManager.execute()` _без_ `await` (в режиме "fire-and-forget").
9.  **\[Concurrency (Задача 9.3)\]** Вызов `pairActorManager.execute` _корректно_ имеет `.catch()` для обработки ошибок "актора".
10. **\[Actor\]** _Внутри_ "актора" _корректно_ вызывается `await this.orchestrator.executeOrchestration()`.
