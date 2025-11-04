# Техническое Задание (ТЗ): 1.4 Система Логирования (LoggingService)

**Эпик:** 1. 🏗️ Ядро Проекта, Окружение и TypeScript (Core Project & Environment) **Задача:** 1.4 Система Логирования (LoggingService) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать строго типизированный Singleton-сервис `LoggingService` (на базе `winston`), который предоставляет контекстно-зависимые логгеры другим сервисам. Конфигурация логгера (вывод в консоль/файл, формат) должна зависеть от режима `APP_MODE`.

## 2\. Зависимости Задачи

- **ConfigService (Задача 1.3):** `LoggingService` должен быть инициализирован **после** `ConfigService` и использовать его для получения `APP_MODE`.
- **`winston` (Задача 1.2):** Используется как ядро системы логирования.
- **Node.js `fs` и `path`:** Необходимы для создания директории логов.

## 3\. Описание и Нюансы Реализации

### 3.1. Создание Директории Лог-файлов

Сервис должен убедиться, что директория `./logs` существует.

- **Нюанс:** При инициализации сервис должен синхронно (т.к. это происходит при старте) проверить наличие `./logs` с помощью `fs.existsSync()` и создать ее, если она отсутствует (`fs.mkdirSync('logs', { recursive: true })`).
- **Нюанс:** Директория `logs/` должна быть немедленно добавлена в `.gitignore` (задача 1.1), так как файлы логов не должны попадать в репозиторий.

### 3.2. `src/services/LoggingService.ts`

Разработчик должен создать `LoggingService` как класс-Singleton.

#### 3.2.1. Инициализация и Singleton

- Класс должен использовать тот же паттерн, что и `ConfigService`: `private static instance: LoggingService | undefined` и `public static getInstance()`.
- **Критично:** Должен быть создан **новый** статический метод `public static initialize()`. Этот метод должен вызываться в `index.ts` **после** `ConfigService.load()` и **до** `getInstance()`.
- Метод `getInstance()` должен выбрасывать ошибку, если `initialize()` не был вызван.
- `private constructor(config: ConfigService)`: Конструктор будет `private` и будет принимать экземпляр `ConfigService`.
- `private readonly mainLogger: winston.Logger;`: В конструкторе будет создан и сохранен основной (родительский) логгер `winston`. Поле должно быть `readonly`, так как оно не изменяется после инициализации.

#### 3.2.2. Конфигурация `winston` (в `private constructor`)

1.  Получить `const appMode = config.getAppMode();`
2.  Определить массив транспортов: `const transports: winston.transport[] = [];`
3.  Определить директорию логов: `const logDir = 'logs';` и создать ее (`fs.mkdirSync...`).
4.  **Форматы:**
    - `splat()`: Для поддержки `printf`\-стиля (`logger.info('User %s', name)`).
    - `errors({ stack: true })`: Для корректного логгирования стектрейсов ошибок.
    - `timestamp()`: Для добавления временных меток.

5.  **Логика транспортов:**
    - **Если `appMode === 'dry_run'` (Режим разработки):**
      - Создать `devConsoleFormat`: `winston.format.combine(winston.format.colorize(), winston.format.timestamp({ format: 'HH:mm:ss' }), winston.format.splat(), winston.format.errors({ stack: true }), winston.format.printf(({ timestamp, level, message, context, stack }) => { ... }))`
      - Формат `printf` должен выводить лог в виде: `HH:mm:ss level: [Context] Message` (с пробелом после контекста). Если `context` отсутствует, он не выводится. Если есть `stack`, он выводится на новой строке после сообщения.
      - `transports.push(new winston.transports.Console({ format: devConsoleFormat, level: 'debug' }));` (Включить `debug` уровень для разработки).

    - **Если `appMode === 'production'` или `appMode === 'testnet'` (Режим Production/Testnet):**
      - **JSON Формат (для файлов):** `const jsonFormat = winston.format.combine(winston.format.timestamp(), winston.format.splat(), winston.format.errors({ stack: true }), winston.format.json());`
      - **File (Errors):** `transports.push(new winston.transports.File({ filename: path.join(logDir, 'error.log'), level: 'error', format: jsonFormat }));`
      - **File (Combined):** `transports.push(new winston.transports.File({ filename: path.join(logDir, 'combined.log'), format: jsonFormat }));`
      - **Console (Prod):** Добавить простой консольный логгер для `stdout` (важно для Docker/PM2). `const prodConsoleFormat = winston.format.combine(winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), winston.format.splat(), winston.format.errors({ stack: true }), winston.format.printf(({ timestamp, level, message, context, stack }) => { ... }))`
      - Формат `printf` должен выводить лог в виде: `YYYY-MM-DD HH:mm:ss LEVEL: [Context] Message` (уровень в верхнем регистре через `level.toUpperCase()`). Если `context` отсутствует, он не выводится. Если есть `stack`, он выводится на новой строке после сообщения.
      - `transports.push(new winston.transports.Console({ format: prodConsoleFormat, level: 'info' }));`

6.  **Создание `mainLogger`:**
    - `this.mainLogger = winston.createLogger({ level: (appMode === 'dry_run' ? 'debug' : 'info'), transports: transports });`

#### 3.2.3. Метод `getLogger()`

- Это **основной** метод, который будут использовать другие сервисы.
- `public getLogger(context: string): winston.Logger { ... }`
- **Нюанс:** Он должен возвращать **дочерний** логгер `winston`, который автоматически добавляет поле `context` в объект лога.
- **Реализация:** `return this.mainLogger.child({ context: context });`

### 3.3. Интеграция в `index.ts`

В `src/index.ts` необходимо обновить `main()`:

    // src/index.ts (фрагмент)
    import { ConfigService } from './services/ConfigService';
    import { LoggingService } from './services/LoggingService';

    async function main() {
      // 1. Загрузка Конфигурации
      ConfigService.load();

      // 2. Инициализация Логгирования (ЗАВИСИТ от ConfigService)
      LoggingService.initialize();

      // 3. Получение логгера для "ядра" приложения
      const logger = LoggingService.getInstance().getLogger('Application');

      logger.info('LoggingService initialized.');
      logger.info(`APP_MODE set to: ${ConfigService.getInstance().getAppMode()}`);

      // ... (дальнейшая инициализация сервисов)
    }

    main().catch(error => {
      // Аварийный лог, если LoggingService еще не инициализирован
      console.error('Unhandled error during application startup:', error);
      process.exit(1);
    });

## 4\. Критерии Приемки (Acceptance Criteria)

Задача считается выполненной, если:

1.  **\[Реализация\]** Файл `src/services/LoggingService.ts` создан как Singleton с методами `initialize()` и `getLogger()`.
2.  **\[Интеграция\]** `index.ts` обновлен: `LoggingService.initialize()` вызывается **после** `ConfigService.load()`.
3.  **\[Запуск\]** При запуске `npm run dev` (`APP_MODE="dry_run"`):
    - В консоли появляются цветные, отформатированные логи (включая `"LoggingService initialized."` и `"APP_MODE set to: dry_run"`).
    - Лог `[Application]` (контекст) присутствует.
    - Директория `logs/` создается, но **остается пустой** (т.к. файловый транспорт не активен).

4.  **\[Тест Контекста\]** Если в `index.ts` добавить `LoggingService.getInstance().getLogger('TestContext').debug('Debug test')`, в консоли (в режиме `dry_run`) появится сообщение `[TestContext] Debug test`.
5.  **\[Тест Production\]** Если временно изменить `APP_MODE="production"` в `.env`:
    - При запуске `npm run dev` (или `npm run start:prod`) в консоли появляются **не** цветные, а JSON-подобные (или простые) логи уровня `info` и выше.
    - Файлы `logs/combined.log` и `logs/error.log` создаются.
    - `logger.info('Prod test')` попадает в `combined.log` (как JSON) и в консоль.
    - `logger.error(new Error('Prod Error Test'))` попадает в `error.log` (с полем `stack`) и в `combined.log`.

6.  **\[`.gitignore`\]** Файл `.gitignore` обновлен и включает `logs/`.
