# Техническое Задание (ТЗ): 8.2.1 Настройка Среды Интеграционного Тестирования

**Эпик:** 8. 🚀 Сборка, Тестирование и Запуск **Задача:** 8.2.1. Настройка Среды Интеграционного Тестирования **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать полностью автоматизированную среду для интеграционного тестирования, которая перед каждым тестовым прогоном (test run) предоставляет **чистую, изолированную, "одноразовую" (ephemeral) базу данных PostgreSQL**. Это гарантирует, что интеграционные тесты (Задачи 8.2.2, 8.2.3) всегда выполняются в 100% предсказуемом и "чистом" окружении, полностью изолированном от `development` БД.

## 2\. Архитектурное Решение

1.  **Инструмент (`testcontainers`):** Вместо использования `docker-compose.test.yml` (как указано в плане), мы будем использовать библиотеку `testcontainers`.
    - **Причина (Почему?):** `testcontainers` позволяет нам управлять жизненным циклом Docker-контейнера (start/stop) _программно_ (прямо из TypeScript/JS), что гораздо надежнее и гибче, чем запуск внешних shell-скриптов.

2.  **Глобальная Настройка (`vitest.globalSetup.ts`):** Мы используем "Global Setup" хук `vitest`. Этот файл будет выполнен _один раз_ до начала _всех_ интеграционных тестов.
3.  **Поток `setup()`:** a. `testcontainers` программно запускает контейнер `postgres:16`. b. Он получает _динамический_ Connection String (URL) к этой "одноразовой" БД. c. Он _обязан_ записать этот URL в `process.env.TEST_DATABASE_URL`. d. Он использует `node-pg-migrate` (из Задачи 2.2), чтобы _применить_ наши реальные миграции (из `src/migrations`) к этой "одноразовой" БД.
4.  **Поток `teardown()`:** После завершения _всех_ тестов `vitest` _автоматически_ вызовет функцию `teardown` (возвращенную из `setup`), которая _гарантированно_ остановит и уничтожит контейнер, даже если тесты провалились.
5.  **Конфигурация `vitest`:** Мы создадим _отдельный_ конфигурационный файл `vitest.config.integration.ts`, который будет использовать этот `globalSetup.ts`.

## 3\. Зависимости Задачи

- **Новые `devDependencies`:**
  - `testcontainers`: Основная библиотека для управления Docker-контейнерами из Node.js.

- **Используемые Модули/Инструменты:**
  - `vitest` (из Задачи 8.2).
  - `node-pg-migrate` (из Задачи 2.2): Для применения миграций.
  - `pg` (из Задачи 1.2): Для `node-pg-migrate`.

## 4\. Описание и Нюансы Реализации

### 4.1. Установка Зависимостей

1.  **Логика:** Разработчик должен установить `testcontainers` как `devDependency`.
    - `npm install -D testcontainers`

### 4.2. Создание "Global Setup" (`tests/globalSetup.ts`)

1.  **Логика:** Разработчик должен создать файл `src/tests/vitest.globalSetup.ts` (или `tests/globalSetup.ts`).
2.  **Логика:** Этот файл должен экспортировать `async function setup()` и `async function teardown()`.
3.  **Логика `setup()`:**
    - Нюанс реализации: `setup` _должен_ импортировать `PostgreSqlContainer` из `testcontainers`.
    - Нюанс реализации: `setup` _должен_ создать экземпляр контейнера (e.g., `new PostgreSqlContainer("postgres:16")`) и вызвать `await container.start()`.
    - Нюанс реализации: `setup` _должен_ получить URL: `const connectionUri = container.getConnectionUri()`.
    - Нюанс реализации: `setup` _должен_ установить этот URL в `process.env.TEST_DATABASE_URL = connectionUri`.
    - Нюанс реализации: `setup` _должен_ сохранить экземпляр `container` в _глобальной_ переменной (e.g., `global.__TEST_CONTAINER__`), чтобы `teardown` мог его найти.
    - Нюанс реализации: `setup` _должен_ настроить и запустить `node-pg-migrate` (аналогично Задаче 2.2), используя `TEST_DATABASE_URL` для подключения.

4.  **Логика `teardown()`:**
    - Нюанс реализации: `teardown` _должен_ получить `container` из `global.__TEST_CONTAINER__`.
    - Нюанс реализации: `teardown` _должен_ вызвать `await container.stop()` внутри `try/finally`, чтобы гарантировать остановку.

### 4.3. Конфигурация `vitest` (`vitest.config.integration.ts`)

1.  **Логика:** Разработчик должен _скопировать_ `vitest.config.ts` (из 8.2) в новый файл `vitest.config.integration.ts`.
2.  **Логика:** В этом _новом_ файле (8.2.1) разработчик _обязан_:
    - Добавить `globalSetup: 'src/tests/vitest.globalSetup.ts'`.
    - Изменить `include` (или `testMatch`), чтобы он искал тесты с суффиксом `*.integration.test.ts`.

### 4.4. Обновление `package.json`

1.  **Логика:** Разработчик должен добавить _новый_ npm-скрипт:
    - `"test:integration": "vitest run -c vitest.config.integration.ts"`

2.  **Логика (Опционально):** Обновить скрипт `test`:
    - `"test": "npm run test:unit && npm run test:integration"`

### 4.5. Доступ к БД в Тестах (Для Задачи 8.2.2)

- **Нюанс реализации (Инструкция для 8.2.2):** Разработчик (в _следующей_ задаче 8.2.2) в своих файлах `*.integration.test.ts` _обязан_ получать `DatabaseService` (2.3) и вызывать его `connect()`, передавая ему `process.env.TEST_DATABASE_URL`.

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Setup

    `testcontainers` установлен в `devDependencies`.

2.  Setup

    Создан файл `vitest.globalSetup.ts` (или аналогичный).

3.  Setup

    `globalSetup.ts` _успешно_ запускает контейнер `postgres:16`.

4.  Setup

    `globalSetup.ts` _корректно_ устанавливает `process.env.TEST_DATABASE_URL`.

5.  Setup

    `globalSetup.ts` _успешно_ применяет миграции (`node-pg-migrate up`) к "одноразовой" БД.

6.  Setup

    `globalSetup.ts` _успешно_ останавливает контейнер в `teardown`.

7.  Config

    Создан `vitest.config.integration.ts`, который _использует_ этот `globalSetup`.

8.  Config

    `vitest.config.integration.ts` настроен на поиск тестов `*.integration.test.ts`.

9.  Script

    В `package.json` добавлен скрипт `"test:integration"`.

10. Run


    Выполнение `npm run test:integration` (даже _без_ тестов) _успешно_ запускает и останавливает контейнер (это видно в логах Docker).
