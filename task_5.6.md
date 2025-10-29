# Техническое Задание (ТЗ): 5.6 Главный Контроллер "Наблюдателя" (WatcherOrchestrator)

**Эпик:** 5. 🔄 "Наблюдатель" (Watcher) - Синхронизация, Циклы и Триггеры **Задача:** 5.6. Главный Контроллер "Наблюдателя" (WatcherOrchestrator) **Связанные Задачи:** 9.4 (Внедрение "Исполнителя") **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать **Singleton-сервис** `WatcherOrchestratorService`, который служит "дирижером" всей системы. Его основная задача — запустить _полную_ цепочку принятия решений: от сборки данных и вызова LLM до исполнения приказов и **обязательной пост-синхронизации**.

Этот сервис является точкой входа для всех триггеров ("Быстрый Цикл", "Медленный Цикл").

## 2\. Архитектурное Решение и Принципы

1.  **"Actor-lite" Модель (Критично):** Сервис _полностью_ делегирует контроль конкурентности **`PairActorManagerService`** (Задача 9.1). Он не должен иметь собственной логики блокировок (`isCallingLLM`).
2.  **Атомарный Аудит:** Запись в `LLM_Decision_Log` (2.4) и обновление `LLM_Triggers` (2.1) _обязаны_ происходить в **одной транзакции БД** _до_ вызова "Исполнителя". Это гарантирует, что даже если LLM дала ответ, но БД недоступна, мы не потеряем данные аудита и не обновим триггеры.
3.  **Пост-Сверка (Критично):** Сразу _после_ того, как `WorkerService` отработает, "Оркестратор" _обязан_ вызвать **`SyncEngineService.reconcileStateForPair()`** (5.0). Это обеспечивает немедленную очистку "ордеров-призраков" (e.g., SL/TP, отмененных `Worker`\-ом) и актуальность состояния.

## 3\. Зависимости Задачи

- **`LoggingService` (1.4)**
- **`DatabaseService` (2.3):** Для `executeInTransaction()`.
- **`ILLMService` (3.3 / 3.4):** Для `ask()`.
- **`LLMRequestAssemblerService` (4.6):** Для `buildRequest()`.
- **`SyncEngineService` (5.0):** **(Новая)** Для `reconcileStateForPair()`.
- **`WorkerService` (7.1):** Для `execute()`.
- **`PairActorManagerService` (9.1):** **(Критично)** Для `executeOrchestration()`.
- **`NotificationService` (1.5):** Для оповещения о критических сбоях.

## 4\. Описание и Нюансы Реализации Логики

### 4.1. Метод `executeOrchestration(pair: string, triggerReason: string)`

Это _единственный_ публичный метод. Он _не_ является `async` (так как вызывается из `FastCycle` в режиме "fire-and-forget").

**Логика:**

1.  **Враппер (Задача 9.4):** Метод _обязан_ обернуть всю свою логику в `this.pairActorManager.execute(pair, async () => { ... })`.
2.  **Сборка Запроса (Шаг 1):** Вызвать `this.assemblerService.buildRequest()`. _обязан_ использовать `try/catch` и выйти (`return`) из "актора" в случае ошибки.
3.  **Вызов LLM (Шаг 2):** Вызвать `this.llmService.ask()`. _обязан_ использовать `try/catch` и выйти (`return`) из "актора" в случае ошибки.
4.  **Атомарный Аудит и Триггеры (Шаг 3 - Критично):** _обязан_ вызвать `this.dbService.executeInTransaction()`. Внутри транзакции _обязан_:
    - **Записать** полный лог (`request_payload_json`, `response_payload_json`) в `LLM_Decision_Log` со статусом **`pending`** и получить `RETURNING id`.
    - **Обновить** таблицу `LLM_Triggers` (используя `INSERT ... ON CONFLICT DO UPDATE`) новыми триггерами и `requested_data_json`.

5.  **Исполнение (Шаг 4):** Итерировать по `llmResponse.decisions`. Для _каждого_ решения _обязан_ вызвать `await this.workerService.execute(decision, llmLogId)`.
    - _Нюанс:_ Не нужно оборачивать вызов `Worker` в `try/catch`, так как `Worker` сам обрабатывает валидацию и обновляет `LLM_Decision_Log` (на `accepted` или `rejected`).

6.  **Пост-Сверка (Шаг 5):** _обязан_ проверить `if (llmResponse.decisions.length > 0)`. Если _да_, _обязан_ вызвать: `await this.syncEngine.reconcileStateForPair(pair)`.
    - _Нюанс:_ Это немедленное действие, которое очистит все "побочные" эффекты (`ActiveOrders`, `TSL_State`) `Worker`\-а.

7.  **Отказоустойчивость (Критично):** Внешний `.catch` (привязанный к `this.pairActorManager.execute(...)`) _обязан_ перехватывать фатальные ошибки и отправлять **PUSH-уведомление** (`NotificationService.sendAlert`).

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Service

    `WatcherOrchestratorService.ts` создан и корректно принимает _все 8 зависимостей_ через DI.

2.  Concurrency(9.4)

    `executeOrchestration()` _полностью_ обернут в `this.pairActorManager.execute()` и _обязан_ иметь внешний `.catch()` для фатальных сбоев.

3.  Step3(Audit)

    Аудит и обновление триггеров _обязаны_ происходить внутри **одной транзакции** (`dbService.executeInTransaction`).

4.  DB(LogStatus)

    `INSERT` в `LLM_Decision_Log` _обязан_ устанавливать `status` в **`pending`**.

5.  DB(Triggers)

    Обновление `LLM_Triggers` _обязано_ использовать `INSERT ... ON CONFLICT DO UPDATE`.

6.  Step4(Execution)

    Вызов `workerService.execute(decision, llmLogId)` _обязан_ происходить в цикле по `decisions` _после_ успешной транзакции аудита.

7.  Step5(Post−Sync−Критично)

    _обязан_ быть реализован условный вызов `await this.syncEngine.reconcileStateForPair(pair)` **только** если `llmResponse.decisions.length > 0`.

8.  Robustness

    Внешний обработчик ошибок (`.catch`) _обязан_ вызвать `notificationService.sendAlert()` при фатальном сбое "актора".
