# Техническое Задание (ТЗ): 8.2.2 Интеграционные Тесты - WorkerService

**Эпик:** 8. 🚀 Сборка, Тестирование и Запуск **Задача:** 8.2.2. Интеграционные Тесты - WorkerService **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Проверить, что `WorkerService` ("Исполнитель") _корректно_ и _атомарно_ (`executeInTransaction`) изменяет состояние **реальной** базы данных PostgreSQL в ответ на "успешные" решения LLM (прошедшие `Validator`).

## 2\. Архитектурное Решение

1.  **Среда:** Этот тест _обязан_ выполняться с использованием конфигурации `vitest.config.integration.ts` и `globalSetup.ts`, созданных в **Задаче 8.2.1**.
2.  **Имя Файла:** Тестовый файл _обязан_ иметь суффикс `*.integration.test.ts` (например, `src/services/WorkerService.integration.test.ts`), чтобы `vitest` "увидел" его.
3.  **Частичная Интеграция:** Мы тестируем _только_ связку `WorkerService` + `DatabaseService`.
    - `DatabaseService` (2.3): Используется **реальный** экземпляр, подключенный к "одноразовой" БД (`process.env.TEST_DATABASE_URL`).
    - `IExchangeService` (3.1): "Мокается" (Mocked). Мы будем использовать `MockExchangeService` (3.5) для имитации ответов биржи.
    - `ValidatorService` (6.x): "Мокается". Его метод `validate()` _всегда_ будет возвращать "успешный" `ValidationResult`.
    - `NotificationService` (1.5), `EventBusService` (4.5.1), `GlobalStateService` (1.6): "Мокаются" (stubbed), так как их поведение не является предметом этого теста.

4.  **Изоляция Тестов (Критично):** _Каждый_ тест (`it(...)`) _обязан_ запускаться с _абсолютно чистой_ БД. Это достигается путем `TRUNCATE` (очистки) _всех_ таблиц в хуке `afterEach`.

## 3\. Зависимости Задачи

- **Тестируемый Модуль:** `WorkerService` (7.1-7.5).
- **Реальные Зависимости:** `DatabaseService` (2.3).
- **"Замоканные" Зависимости:** `IExchangeService` (будет `MockExchangeService`), `ValidatorService`, `GuaranteedOrderExecutionService` (7.0) (будет использовать `MockExchangeService`), `NotificationService`, `EventBusService`, `GlobalStateService`.

## 4\. Описание и Нюансы Реализации

### 4.1. Создание Файла Теста

1.  **Логика:** Разработчик должен создать `src/services/WorkerService.integration.test.ts`.

### 4.2. Настройка (`describe`, `beforeAll`, `afterEach`)

1.  **Логика `beforeAll`:**
    - Разработчик _обязан_ инициализировать `DatabaseService` и вызвать `await DatabaseService.connect(ConfigService)`, передав ему _тестовый_ URL (`process.env.TEST_DATABASE_URL`).
    - Разработчик _обязан_ инициализировать (DI) `WorkerService` и все его "замоканные" зависимости. `WorkerService` должен получить _реальный_ `DatabaseService`.

2.  **Логика `afterEach` (Критично):**
    - Разработчик _обязан_ получить `pg.Pool` из `DatabaseService`.
    - Нюанс реализации: `await pool.query('TRUNCATE ActivePositions, ActiveOrders, TSL_State, TradeHistory, LLM_Triggers, LLM_Decision_Log RESTART IDENTITY CASCADE')`. Это очищает _все_ таблицы и сбрасывает счетчики `SERIAL` (id).

### 4.3. Тест-Кейс 1: `action: OPEN (Market)`

- **Цель:** Проверить, что `WorkerService` корректно создает 5 записей в 5 разных таблицах при `OPEN (Market)`.
- **Логика `(Arrange - Подготовка)`:**
  1.  Подготовить "фейковый" `LLMDecision` (e.g., `OPEN_LONG` `market` для `BTC/USDT`).
  2.  Подготовить "фейковый" `ValidationResult` (e.g., `{ roundedAmountCoin: new Decimal(0.1), ... }`).
  3.  Настроить `vitest.spyOn(ValidatorService, 'validate')` так, чтобы он возвращал `ValidationResult`.
  4.  Настроить `MockExchangeService` так, чтобы он возвращал "успешные" фейковые ордера (один `market`, один `stop_loss_limit`, один `take_profit_limit`).

- **Логика `(Act - Действие)`:**
  1.  `await workerService.execute(decision, ...)`

- **Логика `(Assert - Проверка)`:**
  1.  **Нюанс реализации:** Разработчик _обязан_ выполнить 5 _реальных_ SQL-запросов к `DatabaseService`.
  2.  `const pos = await db.query('SELECT * FROM ActivePositions WHERE pair = $1', ['BTC/USDT'])`. Убедиться, что `pos.rowCount === 1`.
  3.  `const orders = await db.query('SELECT * FROM ActiveOrders WHERE pair = $1', ['BTC/USDT'])`. Убедиться, что `orders.rowCount === 2`.
  4.  `const tsl = await db.query('SELECT * FROM TSL_State WHERE pair = $1', ['BTC/USDT'])`. Убедиться, что `tsl.rowCount === 1`.
  5.  `const history = await db.query('SELECT * FROM TradeHistory WHERE pair = $1', ['BTC/USDT'])`. Убедиться, что `history.rowCount === 1` и `side = 'buy'`.
  6.  `const log = await db.query('SELECT * FROM LLM_Decision_Log WHERE decision_result = $1', ['accepted'])`. Убедиться, что `log.rowCount === 1`.

### 4.4. Тест-Кейс 2: `action: CLOSE (Market)`

- **Цель:** Проверить, что `WorkerService` корректно _очищает_ 3 таблицы и _добавляет_ 1 запись в `TradeHistory`.
- **Логика `(Arrange - Подготовка)`:**
  1.  **"Засеять" (Seed) БД:** _Сначала_ выполнить `INSERT` в `ActivePositions`, `ActiveOrders` (2 шт.), `TSL_State` (1 шт.), чтобы имитировать _уже открытую_ позицию.
  2.  Подготовить "фейковый" `LLMDecision` (`CLOSE_POSITION` `market` для `BTC/USDT`).
  3.  Настроить `vitest.spyOn(ValidatorService, 'validate')` так, чтобы он возвращал `isValid: true`.
  4.  Настроить `MockExchangeService` так, чтобы он возвращал "успешный" `market sell` ордер.

- **Логика `(Act - Действие)`:**
  1.  `await workerService.execute(decision, ...)`

- **Логика `(Assert - Проверка)`:**
  1.  `const pos = await db.query('SELECT * FROM ActivePositions WHERE pair = $1', ['BTC/USDT'])`. Убедиться, что `pos.rowCount === 0`.
  2.  `const orders = await db.query('SELECT * FROM ActiveOrders WHERE pair = $1', ['BTC/USDT'])`. Убедиться, что `orders.rowCount === 0`.
  3.  `const tsl = await db.query('SELECT * FROM TSL_State WHERE pair = $1', ['BTC/USDT'])`. Убедиться, что `tsl.rowCount === 0`.
  4.  `const history = await db.query('SELECT * FROM TradeHistory WHERE side = $1', ['sell'])`. Убедиться, что `history.rowCount === 1`.

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Setup

    Создан файл `src/services/WorkerService.integration.test.ts`.

2.  Setup

    Тест _корректно_ использует `DatabaseService` (реальный) и `ValidatorService` (замоканный).

3.  Setup

    В `beforeAll` (или `beforeEach`) _успешно_ устанавливается соединение с `TEST_DATABASE_URL`.

4.  Setup

    В `afterEach` _успешно_ выполняется `TRUNCATE` _всех_ таблиц.

5.  Test1

    Тест-кейс "OPEN (Market)" _успешно_ проходит и _подтверждает_ (через `SELECT`) создание 5 записей в 5 разных таблицах (`ActivePositions`, `ActiveOrders` (2), `TSL_State`, `TradeHistory`).

6.  Test2

    Тест-кейс "CLOSE (Market)" _успешно_ проходит и _подтверждает_ (через `SELECT`) удаление записей из `ActivePositions`, `ActiveOrders`, `TSL_State` и добавление записи в `TradeHistory`.

7.  Run

    `npm run test:integration` успешно выполняет эти тесты (включая `globalSetup` из 8.2.1).
