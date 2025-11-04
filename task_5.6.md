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
- **`DatabaseService` (2.3):** Для `executeInTransaction()` и `query()`.
- **`ILLMService` (3.3 / 3.4):** Для `ask()`.
- **`LLMRequestAssemblerService` (4.6):** Для `buildRequest()`.
- **`SyncEngineService` (5.0):** Для `reconcileStateForPair()`.
- **`WorkerService` (7.1):** Для `execute()` (через интерфейс `IWorkerService`).
- **`PairActorManagerService` (9.1):** **(Критично)** Для `execute()`.
- **`NotificationService` (1.5):** Для оповещения о критических сбоях (через интерфейс `INotificationService`).
- **`AccountStateService` (4.5):** Для получения состояния аккаунта.
- **`ConfigService` (1.3):** Для получения правил риска и таймаутов триггеров.
- **`MarketDataService` (4.2):** Для получения текущей цены.
- **`GlobalStateService` (1.6):** Для проверки состояния shutdown.

## 4\. Описание и Нюансы Реализации Логики

### 4.1. Метод `executeOrchestration(pair: string, triggerReason: string)`

Это _единственный_ публичный метод. Он _не_ является `async` (так как вызывается из `FastCycle` и `SlowCycle` в режиме "fire-and-forget").

**Логика:**

1.  **Проверка состояния shutdown:** Проверить `GlobalStateService.getIsShuttingDown()`. Если `true`, залогировать `warn` и выйти (`return`).

2.  **Проверка повторных запросов:** Проверить, содержит ли `triggerReason` "ПОВТОРНЫЙ ЗАПРОС". Если да:
    - Проверить глубину рекурсии через `retryDepth.get(pair)` (максимум 3 попытки).
    - Если достигнут лимит, залогировать `error`, отправить уведомление, удалить счетчик и выйти (`return`).
    - Иначе увеличить счетчик `retryDepth.set(pair, currentDepth + 1)`.
    - Для обычных запросов сбросить счетчик `retryDepth.delete(pair)`.

3.  **Уведомление о срабатывании триггера:** Вызвать `notificationService.sendAlert()` с информацией о сработавшем триггере.

4.  **Враппер (Задача 9.4):** Метод _обязан_ обернуть всю свою логику в `this.pairActorManager.execute(pair, async () => { ... }).catch(...)` с внешним обработчиком ошибок.

5.  **Сборка Запроса (Шаг 1):** Вызвать `await this.assemblerService.buildRequest(pair, triggerReason)`. _обязан_ использовать `try/catch`, логировать `error` при ошибке, отправить уведомление и выйти (`return`) из "актора" в случае ошибки.

6.  **Вызов LLM (Шаг 2):** Создать минимальный `LLMRequest` объект (для совместимости с `ILLMService`). Вызвать `await this.llmService.ask(llmRequest)`. _обязан_ использовать `try/catch`, логировать `error` при ошибке, отправить уведомление и выйти (`return`) из "актора" в случае ошибки. Залогировать `info` об успешном получении ответа и отправить уведомление.

7.  **Атомарный Аудит и Триггеры (Шаг 3 - Критично):** _обязан_ вызвать `this.dbService.executeInTransaction()`. Внутри транзакции _обязан_:
    - **Записать** полный лог (`request_payload_json`, `response_payload_json`) в `LLM_Decision_Log` со статусом **`pending`** и получить `RETURNING id`. Сохранить `llmLogId`.
    - **Распределить timeout триггеры** через приватный метод `_distributeTriggerTimeouts()` для предотвращения одновременного срабатывания (установка фиксированного значения 12 часов + случайная задержка 0-59 минут).
    - **Проверить пустые триггеры:** Если `next_call_triggers.trigger_conditions` пустой массив, создать fallback timeout триггер на `configService.getDefaultTriggerTimeoutMinutes()` минут.
    - **Проверить отсутствие timeout триггера:** Если триггеры есть, но нет timeout триггера, добавить timeout триггер по умолчанию (60 минут).
    - **Обновить** таблицу `llm_triggers` (используя `INSERT ... ON CONFLICT DO UPDATE`) новыми триггерами и `requested_data_json` для пары `llmResponse.update_triggers_for_pair`.
    - **Отправить уведомление** об обновлении триггеров через `notificationService.sendTriggersUpdate()` (если метод существует).

8.  **Подготовка данных для WorkerService (Шаг 4):** Получить `accountState` из `accountStateService.getAccountState()`. Сформировать `strategyContext` из `configService.getRiskRules()`. Получить `marketData` через `marketDataService.fetchTicker(pair)` (с fallback на цену 0 при ошибке).

9.  **Исполнение (Шаг 5):** Проверить наличие `llmLogId`. Итерировать по `llmResponse.decisions`. Для _каждого_ решения _обязан_ вызвать `await this.workerService.execute(decision, llmLogId, accountState, strategyContext, marketData)` в `try/catch` (Worker сам обрабатывает ошибки, но логируем `warn` для отладки).

10. **Проверка результатов валидации (Шаг 5.5):** Если `llmResponse.decisions.length > 0` и есть решения на открытие позиции (`OPEN_LONG`/`OPEN_SHORT`):
    - Проверить финальный статус лога через `SELECT decision_result, validator_error_message FROM LLM_Decision_Log WHERE id = $1`.
    - Если статус `'rejected_by_validator'` и не было автоматического исполнения:
      - Удалить триггеры для пар с отклоненными решениями через `DELETE FROM llm_triggers WHERE pair = $1`.
      - Обновить кэш `accountStateService.refreshNow()`.
      - Сформировать детальный `retryReason` с информацией о проблеме и рекомендациями.
      - Отправить повторный запрос к LLM через `setTimeout(() => this.executeOrchestration(rejectedPair, retryReason), 0)` (асинхронно, без await).

11. **Пост-Сверка (Шаг 6):** _обязан_ проверить `if (llmResponse.decisions.length > 0)`. Если _да_, _обязан_ вызвать: `this.syncEngine.reconcileStateForPair(pair).then(...).catch(...)` **асинхронно** (fire-and-forget) для избежания deadlock с `pairActorManager`.

12. **Отказоустойчивость (Критично):** Внутренний `try/catch` в акторе перехватывает фатальные ошибки, логирует `error`, отправляет уведомление и пробрасывает ошибку (`throw error`). Внешний `.catch()` перехватывает ошибки `pairActorManager`, логирует `error` и отправляет уведомление.

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Service

    `WatcherOrchestratorService.ts` создан как Singleton с методом `getInstance(databaseService, llmService, assemblerService, syncEngine, workerService, pairActorManager, notificationService, accountStateService, configService, marketDataService)` и корректно принимает _все 10 зависимостей_ через DI.

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

    Внутренний `try/catch` в акторе перехватывает фатальные ошибки, логирует `error`, отправляет уведомление и пробрасывает ошибку. Внешний `.catch()` перехватывает ошибки `pairActorManager`, логирует `error` и отправляет уведомление.

9.  Retry

    Реализован механизм повторных запросов к LLM при отклонении решений валидатором с ограничением глубины рекурсии (максимум 3 попытки).

10. RetryCleanup

    При отклонении решения на открытие позиции валидатором удаляются триггеры для соответствующих пар, обновляется кэш AccountState и отправляется повторный запрос с детальным описанием проблемы.

11. TriggerDistribution

    Реализован метод `_distributeTriggerTimeouts()` для распределения timeout триггеров (установка фиксированного значения 12 часов + случайная задержка 0-59 минут).

12. FallbackTriggers

    Если модель не установила триггеры (пустой массив), создается fallback timeout триггер на `configService.getDefaultTriggerTimeoutMinutes()` минут.

13. DefaultTimeout

    Если триггеры есть, но нет timeout триггера, добавляется timeout триггер по умолчанию (60 минут).

14. WorkerData

    Для каждого решения WorkerService вызывается с полными данными: `accountState`, `strategyContext`, `marketData`.

15. PostSyncAsync

    Пост-синхронизация вызывается асинхронно (fire-and-forget) через `.then().catch()` для избежания deadlock с pairActorManager.

16. ShutdownCheck

    Метод проверяет `GlobalStateService.getIsShuttingDown()` перед началом оркестрации и выходит при shutdown.

17. NotificationTriggers

    Если `notificationService.sendTriggersUpdate` существует, вызывается для отправки уведомления об обновлении триггеров.
