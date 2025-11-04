# Техническое Задание (ТЗ): 8.2 Модульное Тестирование (Unit Tests)

**Эпик:** 8. 🚀 Сборка, Тестирование и Запуск **Задача:** 8.2. Модульное Тестирование (Unit Tests) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Внедрить фреймворк для модульного тестирования (`vitest`) и написать "изолированные" юнит-тесты для сервисов с "чистой" (pure) и сложной бизнес-логикой. Цель — проверить _логику_, _математику_ и _обработку ошибок_ без обращения к внешним системам (БД, API).

## 2\. Архитектурное Решение

1.  **Фреймворк:** Мы будем использовать `vitest` (вместо `jest`). Он нативно поддерживает `ESM` (выбран в Задаче 1.1), имеет `jest`\-совместимый API и высокую производительность.
2.  **Изоляция (Mocking):** Все тесты _обязаны_ быть изолированными. Все внешние зависимости (e.g., `DatabaseService`, `IExchangeService`, `ConfigService`, `LoggingService`) _должны_ быть полностью "замоканы" (mocked) с помощью `vitest.mock()`.
3.  **Приоритеты:** Мы _не_ будем стремиться к 100% покрытию. Мы сфокусируемся на "высокорисковых" модулях, где сложная логика или математика.
    - **Приоритет 1 (Критично):** `ValidatorService` (Математика и логика правил).
    - **Приоритет 2:** `TAEngineService` (Логика "пакетов").
    - **Приоритет 3:** `GuaranteedOrderExecutionService` (Логика `retry`).
    - **Приоритет 4:** `MockExchangeService` (Тестирование самого симулятора).

4.  **Точность (`decimal.js`):** Все тесты, проверяющие финансовую математику, _обязаны_ использовать `decimal.js` для утверждений (assertions).
    - **Неправильно:** `expect(result).toBe(10.5);`
    - **Правильно:** `expect(result.equals(new Decimal(10.5))).toBe(true);`

## 3\. Зависимости Задачи

- **Новые `devDependencies`:**
  - `vitest`: Сам фреймворк тестирования.
  - `@vitest/coverage-v8`: Для генерации отчетов о покрытии кода.

- **Тестируемые Модули:**
  - `ValidatorService` (6.1-6.6)
  - `TAEngineService` (4.1)
  - `GuaranteedOrderExecutionService` (7.0)
  - `MockExchangeService` (3.5)
  - `ProductionLLMService` (3.4) (Опционально)

- **Зависимости для Mock-ов:**
  - `IExchangeService` (3.1), `AccountStateService` (4.5), `ExchangeRulesService` (3.2) и т.д.

## 4\. Описание и Нюансы Реализации

### 4.1. Настройка (`package.json` и `vitest.config.ts`)

1.  **Логика:** Разработчик должен установить `vitest`, `@vitest/coverage-v8` и `@vitest/ui` как `devDependencies`.
2.  **Логика:** Создать `vitest.config.ts` с настройками: `globals: true`, `environment: 'node'`, `setupFiles: ['./src/__tests__/setup.ts']`, `include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}']`, `coverage.provider: 'v8'`, `coverage.reporter: ['text', 'json', 'html']`, `coverage.thresholds` (lines: 70, functions: 70, branches: 60, statements: 70).
3.  **Логика:** Добавить npm-скрипты в `package.json`: `"test": "vitest run"`, `"test:watch": "vitest"`, `"test:ui": "vitest --ui"`, `"test:coverage": "vitest run --coverage"`.

### 4.2. Тестирование `ValidatorService` (Приоритет 1)

- **Нюанс реализации:** Это самый важный тест. Он должен проверить _каждый_ `throw new Error(...)` из Эпика 6.
- **Логика (Setup):**
  1.  `vitest.mock('@/services/ExchangeRulesService')` (чтобы мокнуть `getRules()`).
  2.  `vitest.mock('@/services/AccountStateService')` (чтобы мокнуть `getAccountState()`).
  3.  Перед каждым тестом (`beforeEach`) настроить моки, чтобы они возвращали "здоровые" данные (e.g., `minNotional: 10`, `precision: { amount: 8, price: 2 }`, `available_quote_balance: 10000`).

- **Логика (Тест-кейсы):**
  1.  **Sanity (6.1):** Написать тест, который проверяет, что `validate()` бросает ошибку, если `stop_loss_price >= entry_price`.
  2.  **Sizing (6.2):** Написать тест, который проверяет, что `_calculatePositionSizing` _корректно_ рассчитывает `rawAmountCoin` (с `decimal.js`).
  3.  **Portfolio Risk (6.3):** Настроить мок `AccountStateService` так, чтобы он возвращал `totalPortfolioRiskPercent = 9.0`. Проверить, что `validate()` бросает ошибку, если новая сделка пытается добавить `risk_percent > 1.0`.
  4.  **Precision (6.6):** Настроить мок `ExchangeRulesService` (e.g., `precision.amount: 2`). Проверить, что `validate()` _корректно_ округляет `rawAmountCoin` (e.g., `1.2345`) до `1.23`.
  5.  **Exchange (6.4):** Настроить мок `ExchangeRulesService` (eg., `minNotional: 50`). Проверить, что `validate()` бросает ошибку, если `roundedAmountUsd < 50`.
  6.  **Fee (6.5):** Настроить мок `ExchangeRulesService` (e.g., `takerFee: 0.1`). Проверить, что `validate()` бросает ошибку, если `usdAtRisk` (e.g., `0.1`) _меньше_ `round_trip_fee_usd` (e.g., `0.2`).

### 4.3. Тестирование `TAEngineService` (Приоритет 2)

- **Логика (Setup):** `vitest.mock('technicalindicators')` и `vitest.mock('tulind')`.
- **Логика (Тест-кейсы):**
  1.  Проверить, что `getAnalysis()` _всегда_ вызывает `EMA.calculate`, `RSI.calculate` и т.д. ("Базовый Пакет").
  2.  Проверить, что `getAnalysis()` _не_ вызывает `ADX.calculate`, если `requestedData` пуст.
  3.  Проверить, что `getAnalysis()` _вызывает_ `ADX.calculate`, если `requestedData` содержит `['ADX']`.
  4.  Проверить, что _все_ числовые значения в итоговом объекте являются `instanceof Decimal`.

### 4.4. Тестирование `GuaranteedOrderExecutionService` (Приоритет 3)

- **Логика (Setup):** `vitest.mock('@/interfaces/IExchangeService')`.
- **Логика (Тест-кейсы):**
  1.  **Сценарий "Retry":**
      - Настроить мок `exchangeService.createOrder` так, чтобы он бросал `ccxt.NetworkError` _один раз_ (`.mockImplementationOnce(...)`).
      - Настроить мок `exchangeService.fetchOrder` так, чтобы он возвращал `mockOrder`.
      - Вызвать `guaranteedService.createOrderWithRetry(...)`.
      - **Убедиться (Assert):** Что `exchangeService.createOrder` был вызван, _и_ `exchangeService.fetchOrder` был вызван, и сервис вернул `mockOrder`.

  2.  **Сценарий "Успех":**
      - Настроить мок `exchangeService.createOrder` так, чтобы он возвращал `mockOrder`.
      - Вызвать `guaranteedService.createOrderWithRetry(...)`.
      - **Убедиться (Assert):** Что `exchangeService.createOrder` был вызван, а `exchangeService.fetchOrder` _не был_ вызван.

### 4.5. Тестирование `ProductionLLMService` (Опционально, Приоритет 5)

- **Логика (Setup):** `vitest.mock('undici', () => ({ fetch: vitest.fn() }))`.
- **Логика (Тест-кейсы):**
  1.  **Zod (Валидация Ответа):**
      - Настроить мок `fetch` так, чтобы он возвращал `Response.json()` с _невалидным_ JSON (e.g., `decisions: "OPEN_LONG"` (строка вместо массива)).
      - Вызвать `llmService.ask(...)`.
      - **Убедиться (Assert):** Что сервис бросил ошибку `ZodError`, а _не_ другую ошибку.

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Setup

    `vitest` и `@vitest/coverage-v8` установлены в `devDependencies`.

2.  Setup

    В `package.json` добавлены скрипты `"test": "vitest run"`, `"test:watch": "vitest"`, `"test:ui": "vitest --ui"`, `"test:coverage": "vitest run --coverage"`.

3.  Setup

    Создан `vitest.config.ts` с настройками coverage, thresholds и setupFiles.

3.  Validator(6.1−6.6)

    Создан `src/services/ValidatorService.test.ts`.

4.  Validator(6.1−6.6)

    Тесты для `ValidatorService` покрывают _как минимум_ 5 различных сценариев ошибок (по одному на каждый уровень валидации).

5.  Validator(Math)

    Тест на `_calculatePositionSizing` _корректно_ использует `decimal.js` для `expect(...)`.

6.  TAEngine(4.1)

    Создан `src/services/TAEngineService.test.ts`.

7.  TAEngine(4.1)

    Тест `TAEngineService` _корректно_ проверяет логику "Базовый" vs "Расширенный" пакет (проверяет, что `ADX` _не_ вызывается, если не запрошен).

8.  Guaranteed(7.0)

    Создан `src/services/GuaranteedOrderExecutionService.test.ts`.

9.  Guaranteed(7.0)

    Тест `GuaranteedOrderExecutionService` _корректно_ проверяет логику `retry-then-verify` при `ccxt.NetworkError`.

11. Run

    Все новые юнит-тесты успешно проходят при выполнении `npm run test` или `npm run test:coverage`.

12. Coverage

    Отчет о покрытии (`coverage/`) показывает, что покрытие `ValidatorService` составляет > 80%. Пороги покрытия настроены в `vitest.config.ts` (lines: 70%, functions: 70%, branches: 60%, statements: 70%).
