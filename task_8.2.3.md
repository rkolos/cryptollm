# Техническое Задание (ТЗ): 8.2.3 Интеграционные Тесты - SyncEngine (Forensic Logic)

**Эпик:** 8. 🚀 Сборка, Тестирование и Запуск **Задача:** 8.2.3. Интеграционные Тесты - SyncEngine (Forensic Logic) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Проверить, что `SyncEngineService` (конкретно "судебная" логика из Задачи 5.1.1) _корректно_ восстанавливает "потерянные" (`lost`) позиции.

Тест должен симулировать расхождение, при котором в `ActivePositions` (БД) пусто, но `AccountStateService` (имитируя баланс биржи) сообщает о наличии актива, и `TradeHistory` (БД) содержит "потерянную" сделку.

## 2\. Архитектурное Решение

1.  **Среда:** Этот тест _обязан_ выполняться с использованием конфигурации `vitest.config.integration.ts` и `globalSetup.ts`, созданных в **Задаче 8.2.1** (т.е. с "одноразовой" БД).
2.  **Имя Файла:** Тестовый файл _обязан_ иметь суффикс `*.integration.test.ts` (например, `src/services/SyncEngineService.integration.test.ts`), чтобы `vitest` "увидел" его.
3.  **Частичная Интеграция:**
    - `DatabaseService` (2.3): Используется **реальный** экземпляр.
    - `SyncEngineService` (5.x): Используется **реальный** экземпляр.
    - `AccountStateService` (4.5): "Мокается" (Mocked). Это **критически важно** для имитации расхождения (пустая БД `ActivePositions` против _непустого_ баланса биржи).
    - `IExchangeService` (3.1): "Мокается" (`MockExchangeService`). Используется для имитации `fetchMyTrades()`, которые `SyncEngine` запросит для "судебной" сверки.

4.  **Изоляция Тестов:** Как и в 8.2.2, _каждый_ тест (`it(...)`) _обязан_ запускаться с _абсолютно чистой_ БД (через `TRUNCATE` в `afterEach`).

## 3\. Зависимости Задачи

- **Тестируемый Модуль:** `SyncEngineService` (5.0, 5.1.1).
- **Реальные Зависимости:** `DatabaseService` (2.3).
- **"Замоканные" Зависимости:** `AccountStateService` (4.5), `IExchangeService` (3.1/3.5).

## 4\. Описание и Нюансы Реализации

### 4.1. Создание Файла Теста

1.  **Логика:** Разработчик должен создать `src/services/SyncEngineService.integration.test.ts`.

### 4.2. Настройка (`describe`, `beforeAll`, `afterEach`)

1.  **Логика `beforeAll`:**
    - Разработчик _обязан_ инициализировать `DatabaseService` (реальный, с `TEST_DATABASE_URL`).
    - Разработчик _обязан_ инициализировать `SyncEngineService` (реальный), `AccountStateService` (мок), `IExchangeService` (мок).

2.  **Логика `afterEach` (Критично):**
    - Разработчик _обязан_ выполнить `TRUNCATE` _всех_ таблиц, как это было сделано в Задаче 8.2.2 (Раздел 4.2).

### 4.3. Тест-Кейс 1: "Судебное Восстановление Позиции"

- **Цель:** Проверить сценарий "потерянной" позиции (согласно плану 8.2.3).
- **Логика `(Arrange - Подготовка)`:**
  1.  **"Засеять" (Seed) БД (Критично):** Разработчик _обязан_ выполнить `INSERT` в `TradeHistory` (БД), имитируя "потерянную" сделку (e.g., `side: 'buy'`, `amount: 0.5`, `pair: 'ETH/USDT'`).
  2.  **Настроить Мок `AccountStateService` (Критично):** Разработчик _обязан_ "замокать" `accountStateService.getAccountState()` так, чтобы он возвращал `AccountState`, где:
      - `activePositions: []` (Пусто! Это расхождение №1).
      - `assets: [{ asset: 'ETH', total: 0.5, ... }]` (Актив есть! Это расхождение №2).

  3.  **Настроить Мок `IExchangeService`:** "Замокать" `exchangeService.fetchMyTrades()` так, чтобы он возвращал массив, _содержащий_ ту же "потерянную" сделку (e.g., `id: '123'`, `amount: 0.5`, `side: 'buy'`).

- **Логика `(Act - Действие)`:**
  1.  Разработчик _обязан_ вызвать `await syncEngineService.reconcileStateForPair('ETH/USDT')` (или `reconcileStateAll()`).

- **Логика `(Assert - Проверка)`:**
  1.  **Нюанс реализации (Критично):** Разработчик _обязан_ выполнить _реальный_ SQL-запрос к `DatabaseService`.
  2.  `const pos = await db.query('SELECT * FROM ActivePositions WHERE pair = $1', ['ETH/USDT'])`.
  3.  Убедиться (Assert), что `pos.rowCount === 1`.
  4.  Убедиться (Assert), что `pos.rows[0].status === 'reconciled'`.
  5.  Убедиться (Assert), что `pos.rows[0].amount` (e.g., `0.5`) и `pos.rows[0].average_entry_price` _корректно_ восстановлены из `TradeHistory`.

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Setup

    Создан файл `src/services/SyncEngineService.integration.test.ts`.

2.  Setup

    Тест _корректно_ использует `DatabaseService` (реальный) и _мокает_ `AccountStateService` и `IExchangeService`.

3.  Setup

    В `afterEach` _успешно_ выполняется `TRUNCATE` _всех_ таблиц.

4.  Test1

    Тест-кейс "Судебное Восстановление" _корректно_ "засеивает" `TradeHistory` (БД) _перед_ запуском.

5.  Test1

    Тест-кейс _корректно_ мокает `AccountStateService` для имитации расхождения (пустые `activePositions`, но непустой `assets`).

6.  Test1

    Тест-кейс _успешно_ проходит и _подтверждает_ (через `SELECT`) создание 1 записи в `ActivePositions` со статусом `reconciled`.

7.  Run

    `npm run test:integration` успешно выполняет этот тест.
