# Техническое Задание (ТЗ): 2.3 Сервис-обертка для СУБД (DatabaseService)

**Эпик:** 2. 🐘 Архитектура Базы Данных (PostgreSQL) **Задача:** 2.3 Сервис-обертка для СУБД (DatabaseService) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать строго типизированный Singleton-сервис `DatabaseService`, который инкапсулирует управление пулом соединений `pg.Pool` (библиотека `node-postgres`). Сервис должен предоставлять простые методы для выполнения запросов и, что **критически важно**, helper-функцию `executeInTransaction()` для гарантированного атомарного выполнения операций (как того требует `WorkerService` из Эпика 7).

## 2\. Архитектурное Решение

1.  **Асинхронная Инициализация (Критично):** `DatabaseService` **не должен** быть простым Singleton. Мы _обязаны_ реализовать асинхронный `public static async initialize()` метод.
2.  **Причина:** Этот `initialize()` _обязан_ не просто создать `Pool`, но и "пропинговать" (`SELECT NOW()`) базу данных. Если БД недоступна при старте, `initialize()` _обязан_ "уронить" приложение (`process.exit(1)`). Это предотвращает запуск "полуживого" бота, который не сможет сохранять свое состояние.
3.  **Атомарность (Критично):** `WorkerService` (Эпик 7) _обязан_ выполнять свои операции (e.g., `INSERT ActivePosition` + `DELETE ActiveOrders`) атомарно. `DatabaseService` _обязан_ предоставить `executeInTransaction(callback)` helper, который гарантирует `BEGIN`, `COMMIT` / `ROLLBACK` и `client.release()` (`finally`).
4.  **Graceful Shutdown:** Сервис _обязан_ предоставить `async closePool()` для `index.ts` (Задача 8.1.1), чтобы корректно закрыть все соединения с БД при остановке.

## 3\. Зависимости Задачи

- **`ConfigService` (1.3):** (Зависимость) Для получения учетных данных БД (`getDatabaseConfig`).
- **`LoggingService` (1.4):** (Зависимость) Для логирования ошибок запросов и транзакций.
- **`pg` / `@types/pg` (Задача 1.2):** (Зависимость) Ядро `node-postgres`.

## 4\. Описание и Нюансы Реализации

### 4.1. Создание Файла и Класса

1.  **Логика:** Разработчик _обязан_ создать `src/services/DatabaseService.ts`.
2.  **Нюанс реализации:** Класс _обязан_ использовать `private static instance` и `private constructor`, но `getInstance()` будет иметь особую логику (см. 4.3).

### 4.2. Асинхронная Инициализация (Метод `initialize`)

1.  **Логика:** Разработчик _обязан_ реализовать `public static async initialize(): Promise<void>`.
2.  **Нюанс реализации (Критично):**
    - Этот метод _обязан_ вызываться _один_ раз в `index.ts`.
    - Он _обязан_ получить `dbConfig` из `ConfigService.getInstance()`.
    - Он _обязан_ создать `new Pool(...)` с настройками из `dbConfig` (и оптимальными `max`, `idleTimeoutMillis`).
    - Он _обязан_ (в `try/catch`):
      1.  Выполнить `await pool.query('SELECT NOW()')` для проверки соединения.
      2.  В случае успеха: создать `this.instance = new DatabaseService(pool)` и залогировать `info`.
      3.  В случае _ошибки_: залогировать `FATAL`, вызвать `process.exit(1)`.

### 4.3. Получение Экземпляра (Метод `getInstance`)

1.  **Логика:** Разработчик _обязан_ реализовать `public static getInstance(): DatabaseService`.
2.  **Нюанс реализации:**
    - Этот метод _обязан_ проверить `if (!this.instance)`.
    - Если `instance` нет (т.е. `initialize()` не был вызван или еще не завершился), он _обязан_ `throw new Error('DatabaseService has not been initialized. Call initialize() first.')`.
    - Это гарантирует, что `index.ts` контролирует порядок загрузки.

### 4.4. Метод `query()` (Простые Запросы)

1.  **Логика:** Разработчик _обязан_ реализовать `public async query(text: string, params: any[] = []): Promise<QueryResult<any>>`.
2.  **Нюанс реализации:**
    - Это простой "wrapper" над `this.pool.query()`.
    - Он _обязан_ логировать запрос (с `debug`) и его длительность (в `ms`).
    - Он _обязан_ логировать `error` в `catch` блоке, _прежде_ чем `throw e;` (перебросить ошибку).

### 4.5. Метод `executeInTransaction()` (Атомарные Операции - Критично)

1.  **Логика:** Разработчик _обязан_ реализовать `public async executeInTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T>`.
2.  **Нюанс реализации:**
    - Этот helper _обязан_ следовать _строгой_ последовательности:
    - `const client = await this.pool.connect();`
    - `try {`
    - `await client.query('BEGIN');`
    - `const result: T = await callback(client);` (Выполнение `Worker`\-ом своей логики).
    - `await client.query('COMMIT');`
    - `return result;`
    - `} catch (e) {`
    - `await client.query('ROLLBACK');`
    - `throw e;`
    - `} finally {`
    - `client.release();` (Критично: _всегда_ освобождать клиента).
    - `}`
    - Он _обязан_ логировать `debug` ("Transaction client acquired..."), `debug` ("Transaction COMMITTED.") и `error` ("Transaction ROLLED BACK...").

### 4.6. Метод `closePool()` (Graceful Shutdown)

1.  **Логика:** Разработчик _обязан_ реализовать `public async closePool(): Promise<void>`.
2.  **Нюанс реализации:** Этот метод _обязан_ вызвать `await this.pool.end()` для корректного закрытия всех соединений.

### 4.7. Интеграция в `index.ts` (Задача 8.1)

1.  **Логика:** `index.ts` _обязан_ быть обновлен для поддержки асинхронной загрузки.
2.  **Нюанс реализации:**
    - Функция `main()` в `index.ts` _обязана_ стать `async function main()`.
    - Вызов `await DatabaseService.initialize()` _обязан_ быть одним из _первых_ шагов внутри `try` блока, _сразу после_ `ConfigService.load()` и `LoggingService.initialize()`.
    - Это гарантирует, что _ни один_ другой сервис (`SyncEngine`, `WorkerService` и т.д.) не будет инициализирован, если БД недоступна.

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Service

    Файл `src/services/DatabaseService.ts` создан как Singleton с `private constructor` и `private static instance`.

2.  Init(Критично)

    Реализован `public static async initialize()`, который _успешно_ создает `Pool` и _пингует_ БД (`SELECT NOW()`).

3.  Init(Критично)

    `initialize()` _корректно_ вызывает `process.exit(1)`, если `Pool` или "пинг" завершаются с ошибкой (e.g., неверный пароль).

4.  Init

    `getInstance()` _корректно_ `throw` ошибку, если `initialize()` еще не был вызван.

5.  Logic:query

    `query()` успешно выполняет запросы и возвращает `QueryResult`.

6.  Logic:Transaction(Успех)

    `executeInTransaction(async (client) => { ... })` _успешно_ выполняет `BEGIN`, `callback` и `COMMIT`.

7.  Logic:Transaction(Откат)(Критично)

    `executeInTransaction(async (client) => { throw new Error('Test'); })` _успешно_ ловит ошибку, выполняет `ROLLBACK` и _корректно_ освобождает клиента (`finally { client.release(); }`).

8.  Logic:Shutdown

    `closePool()` успешно вызывает `pool.end()`.

9.  Интеграция

    `index.ts` (Задача 8.1) обновлен, `main()` является `async`, и `await DatabaseService.initialize()` вызывается _до_ инициализации других сервисов, зависящих от БД.
