# Техническое Задание (ТЗ): 1.6 Глобальный Cервис Состояния (GlobalStateService)

**Эпик:** 1. 🏗️ Ядро Проекта, Окружение и TypeScript (Core Project & Environment) **Задача:** 1.6 Глобальный Cервис Состояния (GlobalStateService) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать Singleton-сервис, который хранит и управляет `in-memory` флагами состояния приложения (`isPaused`, `isShuttingDown`). Эти флаги будут использоваться другими сервисами (особенно циклами WebSocket и `setInterval`) для принятия решения о приостановке или прекращении работы.

## 2\. Зависимости Задачи

- **LoggingService (Задача 1.4):** `GlobalStateService` должен быть инициализирован **после** `LoggingService` и использовать его для логгирования изменений своего состояния (Пауза, Возобновление, Остановка).

## 3\. Описание и Нюансы Реализации

### 3.1. `src/services/GlobalStateService.ts`

Разработчик должен создать `GlobalStateService` как класс-Singleton.

- **Паттерн Singleton:** `private static instance: GlobalStateService | undefined;` и `public static getInstance(): GlobalStateService;`.
- **Инициализация:** В отличие от `ConfigService` и `LoggingService`, этот сервис не требует асинхронной загрузки. Его `getInstance()` может сам создавать экземпляр при первом вызове (lazy initialization).
- **Логгер:** `private readonly logger: winston.Logger;` (должен быть инициализирован в `private constructor()`). Поле должно быть `readonly`, так как оно не изменяется после инициализации.

#### 3.1.1. Внутреннее Состояние

    private isPaused: boolean = false;
    private isShuttingDown: boolean = false;

#### 3.1.2. Конструктор

    // src/services/GlobalStateService.ts (фрагмент)
    import { LoggingService } from './LoggingService.js';
    import type winston from 'winston';

    export class GlobalStateService {
      private static instance: GlobalStateService | undefined;

      private isPaused: boolean = false;
      private isShuttingDown: boolean = false;
      private readonly logger: winston.Logger;

      private constructor() {
        // Получаем логгер. LoggingService УЖЕ должен быть инициализирован
        this.logger = LoggingService.getInstance().getLogger('GlobalState');
        this.logger.info('GlobalStateService initialized.');
      }

      public static getInstance(): GlobalStateService {
        if (!GlobalStateService.instance) {
          GlobalStateService.instance = new GlobalStateService();
        }
        return GlobalStateService.instance;
      }

      // ... (методы ниже)
    }

#### 3.1.3. Методы Управления Паузой

- `public pause(): void`
  - **Логика:** Устанавливает `this.isPaused = true;`.
  - **Логгирование:** `this.logger.warn('Application state set to PAUSED. New triggers will be ignored.');`

- `public resume(): void`
  - **Логика:** Устанавливает `this.isPaused = false;`.
  - **Логгирование:** `this.logger.info('Application state set to RESUMED.');`

- `public getIsPaused(): boolean`
  - **Логика:** Возвращает `this.isPaused;`.

#### 3.1.4. Методы Управления Остановкой (Shutdown)

- `public startShutdown(): void`
  - **Логика:** Устанавливает `this.isShuttingDown = true;`.
  - **Логгирование:** `this.logger.warn('Application SHUTDOWN initiated. All cycles will stop.');`

- `public getIsShuttingDown(): boolean`
  - **Логика:** Возвращает `this.isShuttingDown;`.

#### 3.1.5. Вспомогательный Метод (Helper)

- `public isRunning(): boolean`
  - **Логика:** Возвращает `!this.isPaused && !this.isShuttingDown;`.
  - **Нюанс:** Этот метод станет **критически важным**. Каждый обработчик цикла (WebSocket, `setInterval`) в `FastCycleService` (5.3) и `SlowCycleService` (5.2) должен будет начинаться с проверки: `if (!GlobalStateService.getInstance().isRunning()) return;`.

### 3.2. Интеграция в `index.ts`

В `src/index.ts` необходимо обновить `main()` для инициализации этого сервиса **после** `LoggingService`.

    // src/index.ts (фрагмент)
    import { ConfigService } from './services/ConfigService';
    import { LoggingService } from './services/LoggingService';
    import { GlobalStateService } from './services/GlobalStateService'; // <-- Импорт

    async function main() {
      // 1. Конфигурация
      ConfigService.load();

      // 2. Логгирование
      LoggingService.initialize();

      // 3. Глобальное состояние (ЗАВИСИТ от LoggingService)
      const globalState = GlobalStateService.getInstance(); // <-- Инициализация

      const logger = LoggingService.getInstance().getLogger('Application');
      logger.info('LoggingService and GlobalStateService initialized.');
      logger.info(`APP_MODE set to: ${ConfigService.getInstance().getAppMode()}`);

      // ... (дальнейшая инициализация)
    }
    // ...

## 4\. Критерии Приемки (Acceptance Criteria)

Задача считается выполненной, если:

1.  **\[Реализация\]** Файл `src/services/GlobalStateService.ts` создан как Singleton с методами `pause`, `resume`, `startShutdown`, `getIsPaused`, `getIsShuttingDown` и `isRunning`.
2.  **\[Интеграция\]** `index.ts` обновлен: `GlobalStateService.getInstance()` вызывается **после** `LoggingService.initialize()`.
3.  **\[Тест `pause()`\]** При вызове `globalState.pause()`:
    - `globalState.getIsPaused()` возвращает `true`.
    - `globalState.isRunning()` возвращает `false`.
    - В логах (консоль/файл) появляется `WARN` сообщение `[GlobalState] Application state set to PAUSED...`.

4.  **\[Тест `resume()`\]** После `pause()`, вызов `globalState.resume()`:
    - `globalState.getIsPaused()` возвращает `false`.
    - `globalState.isRunning()` возвращает `true` (если `isShuttingDown` = `false`).
    - В логах появляется `INFO` сообщение `[GlobalState] Application state set to RESUMED.`.

5.  **\[Тест `startShutdown()`\]** При вызове `globalState.startShutdown()`:
    - `globalState.getIsShuttingDown()` возвращает `true`.
    - `globalState.isRunning()` возвращает `false`.
    - В логах появляется `WARN` сообщение `[GlobalState] Application SHUTDOWN initiated...`.
