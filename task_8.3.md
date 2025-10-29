# Техническое Задание (ТЗ): 8.3 E2E Тестирование (Paper Trading / Testnet)

**Эпик:** 8. 🚀 Сборка, Тестирование и Запуск **Задача:** 8.3. E2E Тестирование (Paper Trading / Testnet) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Провести "генеральную репетицию" (dress rehearsal) всего приложения, запустив его в двух симулированных "живых" режимах (`DRY_RUN` и `TESTNET`). Цель — вручную верифицировать _полную сквозную (E2E) цепочку_ от получения триггера до исполнения ордера и сверки состояния.

## 2\. Архитектурное Решение

Эта задача **не подразумевает написания нового кода**, а является **процедурой тестирования**, использующей "переключатели" (`APP_MODE`), которые мы заложили в `index.ts` (Задача 8.1).

### 2.1. Режим 1: "Paper Trading" (`APP_MODE=dry_run`)

1.  **Конфигурация:** `index.ts` (Задача 8.1) _должен_ быть настроен так, что при `APP_MODE = 'dry_run'`:
    - `IExchangeService`: Загружается `MockExchangeService` (Задача 3.5).
    - `ILLMService`: Загружается `ProductionLLMService` (Задача 3.4) (или `MockLLMService` для экономии).
    - `DatabaseService`: Загружается _реальный_ `DatabaseService`, подключенный к _реальной_ (но не-production) БД.

2.  **Цель Теста:** Проверить _всю_ внутреннюю логику и взаимодействие сервисов (`Trigger` -> `Orchestrator` -> `LLM` -> `Validator` -> `Worker` -> `DB Update` -> `EventBus` -> `AccountState Refresh` -> `SyncEngine Reconcile`) _без_ риска и _без_ зависимости от внешнего API биржи.

### 2.2. Режим 2: "Testnet" (`APP_MODE=testnet`)

1.  **Конфигурация:** `index.ts` (Задача 8.1) _должен_ быть настроен так, что при `APP_MODE = 'testnet'`:
    - `IExchangeService`: Загружается `ProductionExchangeService` (Задача 3.1).
    - `ILLMService`: Загружается `ProductionLLMService` (Задача 3.4).
    - `DatabaseService`: Загружается _реальный_ `DatabaseService`.
    - **Ключи:** `ConfigService` (Задача 1.3) _обязан_ загрузить `BINANCE_API_KEY` и `BINANCE_API_SECRET`, которые являются ключами от **Binance Testnet**.

2.  **Цель Теста:** Проверить _абсолютно всё_, включая реальное взаимодействие с API биржи:
    - Живое подключение к WebSocket (`FastCycleService`).
    - Реальную латентность (задержки) API.
    - Реальное исполнение `market` и `limit` ордеров на **Binance Testnet**.
    - Реальную работу `SyncEngine` (5.x) при сверке с _реальным_ состоянием биржи.

## 3\. Зависимости Задачи

- **Все Модули:** Эта задача является "потребителем" _всех_ модулей, созданных в Фазах 1-4.
- **Внешние:** Требуется наличие аккаунта **Binance Testnet** и сгенерированных для него API-ключей.

## 4\. Описание и Нюансы Реализации

### 4.1. Обновление `.env.example`

1.  **Логика:** Разработчик _обязан_ обновить (или создать) файл `.env.example` в корне проекта.
2.  **Нюанс реализации:** В файле _должны_ быть добавлены (или проверены) _все_ переменные, необходимые для запуска, включая _новые_ переменные для Testnet:
    - `APP_MODE="dry_run"` (как пример по умолчанию)
    - `BINANCE_TESTNET_API_KEY="ВАШ_TESTNET_KEY"`
    - `BINANCE_TESTNET_API_SECRET="ВАШ_TESTNET_SECRET"`
    - (А также `DB_HOST`, `LLM_API_KEY`, `TELEGRAM_BOT_TOKEN` и т.д. из Задачи 1.3).

### 4.2. Обновление `ConfigService` (Задача 1.3)

1.  **Логика:** Разработчик _обязан_ модифицировать `ConfigService` (1.3) и `index.ts` (8.1).
2.  **Нюанс реализации:** Логика в `index.ts` _обязана_ при инициализации `ProductionExchangeService` (3.1) проверять `APP_MODE`.
    - Если `APP_MODE === 'testnet'`, `ProductionExchangeService` должен быть инициализирован с ключами `BINANCE_TESTNET_API_KEY` и `BINANCE_TESTNET_API_SECRET` И, **(Критично)**, с опцией `ccxt.options = { 'defaultType': 'future' }` или `ccxt.setSandboxMode(true)` (в зависимости от того, как CCXT работает с Testnet).
    - Если `APP_MODE === 'production'`, он должен использовать `BINANCE_API_KEY`.

### 4.3. Обновление `package.json`

1.  **Логика:** Разработчик _обязан_ добавить npm-скрипты для удобного запуска E2E-тестов.
2.  **Нюанс реализации:**
    - `"start:dryrun": "cross-env APP_MODE=dry_run node dist/index.js"`
    - `"start:testnet": "cross-env APP_MODE=testnet node dist/index.js"`
    - (Требуется `npm install -D cross-env` для совместимости Windows/Linux/Mac).

### 4.4. Процедура E2E Тестирования (Ручная)

Разработчик _обязан_ выполнить следующие шаги и _подтвердить_ (устно или в PR), что они пройдены.

1.  **Тест `DRY_RUN`:**
    - `cp .env.example .env` (заполнить `DB`, `LLM`, `TG` ключами).
    - `npm run start:dryrun`.
    - **Проверка:** Убедиться (через `NotificationService` или логи), что бот _запущен_.
    - **Проверка:** Вручную "вызвать" триггер (например, ценовой, изменив `LLM_Triggers` в БД, или `timeout`).
    - **Проверка:** Убедиться (в `LLM_Decision_Log` и `NotificationService`), что `WatcherOrchestrator` (5.6) вызвал `Worker` (7.1).
    - **Проверка:** Убедиться (в `LLM_Decision_Log`), что `Validator` (6.x) вернул `accepted`.
    - **Проверка:** Убедиться (в `ActivePositions` в БД), что `MockExchangeService` "исполнил" ордер, и `Worker` _корректно_ сохранил позицию.
    - **Проверка:** Убедиться (в логах), что `EventBus` (4.5.1) сработал, и `AccountStateService` (4.5) обновил свой кэш.

2.  **Тест `TESTNET`:**
    - Изменить `.env` -> `APP_MODE=testnet`, добавить `BINANCE_TESTNET_...` ключи.
    - `npm run start:testnet`.
    - **Проверка:** Убедиться (в логах), что `FastCycleService` (5.3) _успешно_ подключился к WebSocket (Testnet).
    - **Проверка:** Вручную "вызвать" триггер (как в шаге 1.3).
    - **Проверка:** Убедиться (в **Binance Testnet UI**), что `ProductionExchangeService` (3.1) _физически_ разместил `market` ордер и `stop_loss_limit` ордер.
    - **Проверка:** Убедиться (в `ActivePositions` в БД), что `Worker` _корректно_ сохранил позицию.
    - **Проверка:** Убедиться (в логах), что `SyncEngine` (5.x) в "Медленном Цикле" _корректно_ сверяет ордера с Testnet-биржей и не находит "зомби".

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Config

    В `.env.example` добавлены `BINANCE_TESTNET_API_KEY` и `BINANCE_TESTNET_API_SECRET`.

2.  Config

    `index.ts` (или `ConfigService`) _корректно_ выбирает ключи (Testnet vs Prod) в зависимости от `APP_MODE`.

3.  Config

    `index.ts` _корректно_ настраивает `ProductionExchangeService` на использование "песочницы" (sandbox) при `APP_MODE=testnet`.

4.  Scripts

    В `package.json` добавлены скрипты `start:dryrun` и `start:testnet` (и установлен `cross-env`).

5.  Test:DRYR​UN

    Разработчик _подтверждает_, что полная E2E-цепочка (`Trigger` -> `LLM` -> `Validator` -> `MockExchangeService` -> `DB Update`) _успешно_ выполняется в режиме `dry_run`.

6.  Test:TESTNET

    Разработчик _подтверждает_, что полная E2E-цепочка (`Trigger` -> `LLM` -> `Validator` -> `ProductionExchangeService` -> `DB Update`) _успешно_ выполняется в режиме `testnet`, и ордера _физически появляются_ в **Binance Testnet UI**.
