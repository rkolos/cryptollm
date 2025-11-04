# Техническое Задание (ТЗ): 3.3 Mock-Клиент LLM (MockLLMService)

**Эпик:** 3. 🔌 Core-Сервисы и Клиенты (Core Services & Clients) **Задача:** 3.3 Mock-Клиент LLM (MockLLMService) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать "заглушку" (`MockLLMService`), которая реализует интерфейс `ILLMService`. Сервис должен имитировать API LLM, принимая `LLMRequest` и возвращая **предопределенный, статичный, валидный `LLMResponse`** (согласно "Примеру 2" в `about.md`).

Это критически важно для E2E-тестирования (Задача 8.3) и разработки `WorkerService` (Эпик 7) в режимах `DRY_RUN` и `TESTNET`.

## 2\. Архитектурное Решение

1.  **Контракт (Интерфейсы):** Мы _обязаны_ сначала определить строгие типы данных (`LLMRequest`, `LLMResponse`) и интерфейс сервиса (`ILLMService`). Все остальное приложение (включая `ProductionLLMService` из Задачи 3.4) будет зависеть от этих контрактов.
2.  **Идемпотентность Мока:** Мок _обязан_ возвращать ответ, который является **динамически адаптированным** статичным JSON-объектом. То есть, если его спросили о `ETH/USDT`, ответ _обязан_ содержать `update_triggers_for_pair: "ETH/USDT"`. Это предотвратит ошибки валидации в `WorkerService`.
3.  **Имитация Сети:** Сервис _обязан_ имитировать задержку сети/LLM (`setTimeout`) для корректного тестирования асинхронной логики блокировок в `PairActorManagerService` (Эпик 9).

## 3\. Зависимости Задачи

- `LoggingService` (1.4): (Зависимость) Для логирования.
- `ConfigService` (1.3): (Зависимость) Для определения режима работы (`APP_MODE`) в `index.ts`.
- `about.md`: (Исходные данные) Для статического JSON-ответа.

## 4\. Описание и Нюансы Реализации

### 4.1. Контракты Данных (`src/interfaces/ILLMTypes.ts`)

1.  **Логика:** Разработчик _обязан_ создать новый файл, определяющий типы `LLMRequest` (вход) и `LLMResponse` (выход).
2.  **Нюанс реализации:** Тип `LLMResponse` _обязан_ точно соответствовать "Примеру 2" в `about.md`, включая структуры для: `decisions` (массив `LLMDecision`), `next_call_triggers`, `request_additional_data` и **`justification`** (Задача 10.3).

### 4.2. Контракт Сервиса (`src/interfaces/ILLMService.ts`)

1.  **Логика:** Разработчик _обязан_ создать простой интерфейс `ILLMService`.
2.  **Нюанс реализации:** Интерфейс _обязан_ содержать _один_ метод: `public ask(payload: LLMRequest): Promise<LLMResponse>`.

### 4.3. Реализация (`src/services/MockLLMService.ts`)

1.  **Класс и Инициализация:** Класс `MockLLMService` _обязан_ реализовать `ILLMService`. В конструкторе _обязан_ залогировать `warn` о том, что активен режим "заглушки".
2.  **Статический Ответ:** Разработчик _обязан_ объявить `const MOCK_LLM_RESPONSE` — статичную, константную копию JSON из `about.md` (Пример 2).
3.  **Метод `ask(payload)`:**
    - **Имитация Задержки:** Метод _обязан_ начать с `await new Promise(resolve => setTimeout(resolve, N))`, где N = 350мс (имитация задержки сети/LLM).
    - **Адаптация (Критично):** Перед возвратом Moсk-ответ _обязан_ быть глубоко скопирован (e.g., `JSON.parse(JSON.stringify(...))`).
    - **Корректировка:** Скопированный ответ _обязан_ быть изменен таким образом, чтобы:
      - `response.update_triggers_for_pair` = `payload.triggered_pair`.
      - Если `decisions` не пуст, `response.decisions[i].pair` _обязан_ быть равен `payload.triggered_pair` для всех элементов массива.

    - **Логирование:** Сервис _обязан_ логировать (`info`) факт получения запроса и отправки ответа, включая `payload.triggered_pair`.

### 4.4. Интеграция в `index.ts` (Логика Выбора, Задача 8.1)

1.  **Логика:** `index.ts` _обязан_ реализовать логику выбора конкретной реализации `ILLMService`.
2.  **Нюанс реализации:**
    - Разработчик _обязан_ получить `appMode` из `ConfigService`.
    - Если `appMode === 'production'`, он _обязан_ инициализировать `ProductionLLMService` (Задача 3.4).
    - Во _всех_ остальных случаях (`testnet`, `dry_run`, `development`), он _обязан_ инициализировать **`MockLLMService`** и залогировать `info` о режиме работы.
    - Все последующие сервисы (`WatcherOrchestrator`) _обязаны_ принимать `llmService` через Dependency Injection (DI) в виде `ILLMService`.

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Contract

    Файлы `ILLMTypes.ts` и `ILLMService.ts` созданы и экспортируют корректные, строго типизированные контракты.

2.  Service

    `MockLLMService.ts` создан и реализует `ILLMService`.

3.  MockData

    В `MockLLMService` объявлен статический, валидный JSON-объект, соответствующий `LLMResponse`.

4.  Simulation

    Метод `ask()` _корректно_ имитирует сетевую задержку (`setTimeout`).

5.  Adaptation(Критично)

    Ответ _обязан_ быть глубоко скопирован. Поля `update_triggers_for_pair` и `decisions[i].pair` _обязаны_ быть динамически обновлены на основе входного `payload.triggered_pair`.

6.  Integration

    `index.ts` _корректно_ использует `ConfigService` для выбора между `MockLLMService` и `ProductionLLMService` и передает выбранный экземпляр через DI.
