# Техническое Задание (ТЗ): 1.3 Модуль Конфигурации (ConfigService)

**Эпик:** 1. 🏗️ Ядро Проекта, Окружение и TypeScript (Core Project & Environment) **Задача:** 1.3 Модуль Конфигурации (ConfigService) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать строго типизированный Singleton-сервис `ConfigService`, отвечающий за загрузку, валидацию и предоставление переменных окружения (`.env`) всему приложению.

## 2\. Новые Зависимости

Для реализации этой задачи необходимо установить две новые runtime-зависимости:

- **`dotenv`**: Для загрузки переменных из `.env` файла в `process.env`.
- **`zod`**: Для парсинга и строгой валидации схемы переменных окружения.

**Команды для выполнения:** `npm install dotenv zod`

## 3\. Описание и Нюансы Реализации

### 3.1. Создание `.env.example`

В корне проекта должен быть создан файл `.env.example`, который служит шаблоном для всех необходимых переменных.

    # .env.example

    # 1. Application Mode
    # 'production' - реальная торговля
    # 'testnet' - торговля на Binance Testnet
    # 'dry_run' - симуляция (без реальных ордеров)
    APP_MODE="dry_run"

    # 2. Binance API
    BINANCE_API_KEY="YOUR_BINANCE_API_KEY"
    BINANCE_API_SECRET="YOUR_BINANCE_API_SECRET"

    # 3. Database (PostgreSQL)
    DB_HOST="localhost"
    DB_PORT="5432"
    DB_USER="trader_user"
    DB_PASSWORD="trader_pass"
    DB_NAME="trader_db"

    # 4. Watchlist (через запятую, без пробелов)
    WATCHLIST="BTC/USDT,ETH/USDT"

    # 5. LLM API
    LLM_API_URL="http://localhost:8080/v1/chat/completions"
    LLM_API_KEY="your_llm_api_key_if_needed"
    LLM_MODEL_NAME="gpt-4"  # Опционально, имя модели LLM

    # 6. Notifications (Telegram)
    TELEGRAM_BOT_TOKEN="YOUR_TELEGRAM_BOT_TOKEN"
    TELEGRAM_CHAT_ID="YOUR_TELEGRAM_CHAT_ID"

    # 7. Strategy Context
    # Вариант 1: JSON формат (рекомендуется)
    STRATEGY_CONTEXT='{"role":"Ты — профессиональный риск-менеджер и помощник трейдера","style":"Консервативный свинг-трейдер"}'
    # Вариант 2: Legacy формат (используется как fallback, если STRATEGY_CONTEXT не задан)
    STRATEGY_ROLE="Ты — профессиональный риск-менеджер и помощник трейдера."
    STRATEGY_STYLE="Ты — консервативный свинг-трейдер. Фокусируйся на старших таймфреймах."

    # 8. Risk Rules
    # Вариант 1: JSON формат (рекомендуется)
    RISK_RULES='{"default_risk_per_trade_percent":1.5,"max_allowed_risk_per_trade_percent":3.0,"max_total_portfolio_risk_percent":10.0,"desired_risk_reward_ratio":3.0}'
    # Вариант 2: Legacy формат (используется как fallback, если RISK_RULES не задан)
    RISK_DEFAULT_PERCENT="1.0"
    RISK_MAX_PER_TRADE_PERCENT="2.0"
    RISK_MAX_TOTAL_PORTFOLIO_PERCENT="10.0"
    RISK_DESIRED_RR_RATIO="3.0"

    # 9. Dry Run Configuration
    DRY_RUN_INITIAL_USDT="10000"  # Опционально, начальный баланс для dry_run режима (по умолчанию 10000)

    # 10. Worker Configuration
    WORKER_LOCAL_EXECUTION_BALANCE_PERCENT="0.1"  # Опционально, процент баланса для локального выполнения (0.0-1.0, по умолчанию 0.1)

### 3.2. `src/services/ConfigService.ts`

Разработчик должен создать `ConfigService` как класс-Singleton.

#### 3.2.1. Схема Валидации (`zod`)

Внутри сервиса должна быть определена схема `zod` (`configSchema`), которая описывает ВСЕ переменные из `.env.example`.

- **Нюанс:** Числовые значения (например, `DB_PORT`, `RISK_...`) должны быть определены с использованием `z.coerce.number()`, чтобы `zod` автоматически преобразовал строку из `.env` в тип `number`.
- **Нюанс:** `DB_PORT` должен использовать `.int().positive()` для строгой валидации целого положительного числа.
- **Нюанс:** `APP_MODE` должен использовать `z.enum(['production', 'testnet', 'dry_run'])`.
- **Нюанс:** `LLM_API_URL`, `LLM_API_KEY`, `LLM_MODEL_NAME` могут быть опциональными (`.optional()`), так как `MockLLMService` (Задача 3.3) не будет их использовать.
- **Нюанс:** `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID` опциональны, так как уведомления могут быть отключены.
- **Нюанс:** `STRATEGY_CONTEXT` и `RISK_RULES` опциональны и могут быть заданы в JSON формате. Если они не заданы, используются legacy переменные (`STRATEGY_ROLE`, `STRATEGY_STYLE`, `RISK_DEFAULT_PERCENT` и т.д.).
- **Нюанс:** `DB_PASSWORD` используется вместо `DB_PASS` для согласованности с современными практиками именования.

#### 3.2.2. Реализация Singleton

Класс должен иметь `private static instance: ConfigService | undefined` и `public static getInstance(): ConfigService` для обеспечения единственного экземпляра. Поле `instance` может быть `undefined` до вызова `load()`.

#### 3.2.3. Метод `load()`

- Этот статический метод должен быть **единственной** точкой входа для инициализации сервиса.
- Он должен вызываться **один раз** при старте приложения (в `index.ts`) **до** инициализации всех остальных сервисов.
- **Логика `load()`:**
  1.  Вызвать `dotenv.config()`.
  2.  Обернуть `configSchema.parse(process.env)` в `try...catch`.
  3.  **При успехе:** Сохранить типизированный и валидированный объект `config` в `private` свойстве экземпляра Singleton.
  4.  **При ошибке (провал валидации):**
      - **Критично:** Вывести ошибку валидации `zod` в лог (`console.error`). Для каждой ошибки валидации должен выводиться путь (path) и сообщение (message) для удобства отладки. Ошибка `zod` детально покажет, каких переменных не хватает или какие имеют неверный тип.
      - **Критично:** Принудительно завершить работу приложения: `process.exit(1)`. Это предотвратит запуск бота в некорректной или небезопасной конфигурации.

#### 3.2.4. Геттеры (Getters)

- Сервис не должен предоставлять доступ ко всему объекту `config` напрямую.
- Должны быть созданы типизированные геттеры для каждой группы настроек.
- **Нюанс для `getWatchlist()`:** Этот геттер должен возвращать `string[]`, а не строку. Он должен парсить строку из `config.WATCHLIST.split(',').map(pair => pair.trim()).filter(pair => pair.length > 0)` для удаления пробелов и пустых значений.
- **Нюанс для `getDbConfig()`:** Геттер должен возвращать объект с полем `password` (из `DB_PASSWORD`), а не `DB_PASS`.
- **Нюанс для `getStrategyContext()`:** Геттер должен поддерживать несколько форматов:
  - Если `APP_MODE` равен `'testnet'` или `'dry_run'`, возвращается агрессивный профиль: `{ role: 'aggressive_trader', style: 'high_frequency_swing' }`.
  - Если задан `STRATEGY_CONTEXT` (JSON строка), она парсится и возвращается. При ошибке парсинга используется fallback к legacy формату.
  - В противном случае используется legacy формат из `STRATEGY_ROLE` и `STRATEGY_STYLE`.
- **Нюанс для `getRiskRules()`:** Геттер должен поддерживать несколько форматов:
  - Если `APP_MODE` равен `'testnet'` или `'dry_run'`, возвращаются агрессивные настройки: `{ defaultRiskPercent: 20.0, maxAllowedRiskPercent: 50.0, maxTotalPortfolioRiskPercent: 100.0, desiredRiskRewardRatio: 1.0 }`.
  - Если задан `RISK_RULES` (JSON строка), она парсится и возвращается с преобразованием ключей в camelCase. При ошибке парсинга используется fallback к legacy формату.
  - В противном случае используется legacy формат из отдельных переменных `RISK_*`.
- **Дополнительные геттеры:**
  - `getDryRunInitialBalance(): number` - возвращает `DRY_RUN_INITIAL_USDT` или `10000` по умолчанию.
  - `getSlowCycleIntervalMs(): number` - возвращает интервал медленного цикла в миллисекундах (по умолчанию `600000`).
  - `getLocalExecutionBalancePercent(): number` - возвращает процент баланса для локального выполнения (по умолчанию `0.1`).
  - `getDefaultTriggerTimeoutMinutes(): number` - возвращает дефолтный таймаут триггера в минутах (по умолчанию `30`).

**Пример структуры (неполный):**

    // src/services/ConfigService.ts
    import { z } from 'zod';
    import dotenv from 'dotenv';

    // 1. Схема Zod (определить снаружи класса)
    const configSchema = z.object({
      APP_MODE: z.enum(['production', 'testnet', 'dry_run']),
      BINANCE_API_KEY: z.string().min(1),
      // ... все остальные переменные ...
      WATCHLIST: z.string().min(1),
      RISK_DEFAULT_PERCENT: z.coerce.number().positive(),
      // ...
    });

    type AppConfig = z.infer<typeof configSchema>;

    // 2. Класс ConfigService
    export class ConfigService {
      private static instance: ConfigService;
      private config: AppConfig;

      private constructor(config: AppConfig) {
        this.config = config;
      }

      // 3. Метод загрузки и валидации
      public static load(): void {
        dotenv.config();
        try {
          const parsedConfig = configSchema.parse(process.env);
          ConfigService.instance = new ConfigService(parsedConfig);
          console.log('Config loaded and validated successfully.');
        } catch (error) {
          if (error instanceof z.ZodError) {
            console.error('Failed to validate .env configuration:', error.errors);
          } else {
            console.error('An unexpected error occurred during config load:', error);
          }
          process.exit(1); // Остановка приложения
        }
      }

      // 4. Метод получения экземпляра
      public static getInstance(): ConfigService {
        if (!ConfigService.instance) {
          throw new Error('ConfigService must be loaded before use (call load())');
        }
        return ConfigService.instance;
      }

      // 5. Геттеры
      public getAppMode(): AppConfig['APP_MODE'] {
        return this.config.APP_MODE;
      }

      public getDbConfig() {
        return {
          host: this.config.DB_HOST,
          port: this.config.DB_PORT,
          user: this.config.DB_USER,
          password: this.config.DB_PASSWORD,
          database: this.config.DB_NAME,
        };
      }

      public getWatchlist(): string[] {
        return this.config.WATCHLIST.split(',')
          .map((pair) => pair.trim())
          .filter((pair) => pair.length > 0);
      }

      public getRiskRules() {
        // Логика с поддержкой демо-счетов и JSON формата (см. реализацию)
        // ...
      }

      public getStrategyContext() {
        // Логика с поддержкой демо-счетов и JSON формата (см. реализацию)
        // ...
      }

      public getDryRunInitialBalance(): number {
        return this.config.DRY_RUN_INITIAL_USDT ?? 10000;
      }

      public getSlowCycleIntervalMs(): number {
        return 600000; // 10 минут
      }

      public getLocalExecutionBalancePercent(): number {
        return this.config.WORKER_LOCAL_EXECUTION_BALANCE_PERCENT ?? 0.1;
      }

      public getDefaultTriggerTimeoutMinutes(): number {
        return 30;
      }

      // ... другие геттеры (getBinanceConfig, getLlmConfig, getTelegramConfig) ...
    }

## 4\. Критерии Приемки (Acceptance Criteria)

Задача считается выполненной, если:

1.  **\[Установка\]** Библиотеки `dotenv` и `zod` добавлены в `dependencies` в `package.json`.
2.  **\[Шаблон\]** Файл `.env.example` создан в корне проекта и содержит все переменные из п. 3.1.
3.  **\[Реализация\]** Файл `src/services/ConfigService.ts` реализован как Singleton в соответствии с п. 3.2.
4.  **\[Интеграция\]** В `src/index.ts` (из Задачи 1.1) **первой строкой** в `async function main()` добавлен вызов `ConfigService.load()`.
5.  **\[Тест Успеха\]** При наличии корректного `.env` файла, приложение запускается, в консоль выводится "Config loaded..."
6.  **\[Тест Провала 1 (Отсутствие)\]** Если файл `.env` отсутствует (или в нем не хватает `BINANCE_API_KEY`), `ConfigService.load()` выбрасывает ошибку, выводит в консоль сообщение (например, "BINANCE_API_KEY: Required") и приложение **не запускается** (завершается с кодом 1).
7.  **\[Тест Провала 2 (Неверный тип)\]** Если в `.env` указано `APP_MODE="wrong_mode"`, `ConfigService.load()` выбрасывает ошибку (например, "Invalid enum value. Expected 'production' | 'testnet' | 'dry_run', received 'wrong_mode'") и приложение **не запускается**.
8.  **\[Тест Провала 3 (Coerce)\]** Если в `.env` указано `RISK_DEFAULT_PERCENT="abc"`, `ConfigService.load()` выбрасывает ошибку (например, "Expected number, received nan") и приложение **не запускается**.
9.  **\[Тест Геттера\]** Временный `console.log(ConfigService.getInstance().getWatchlist())` в `index.ts` (после `load()`) корректно выводит массив `['BTC/USDT', 'ETH/USDT']` (а не строку). Пробелы вокруг запятых должны быть удалены.
10. **\[Тест Геттера 2\]** Временный `console.log(ConfigService.getInstance().getRiskRules())` выводит объект, где все значения имеют тип `number`.
11. **\[Тест JSON формата Strategy\]** При задании `STRATEGY_CONTEXT` в JSON формате, `getStrategyContext()` должен корректно парсить и возвращать объект. При ошибке парсинга должен использоваться fallback к legacy формату.
12. **\[Тест JSON формата Risk\]** При задании `RISK_RULES` в JSON формате, `getRiskRules()` должен корректно парсить и возвращать объект с преобразованными ключами. При ошибке парсинга должен использоваться fallback к legacy формату.
13. **\[Тест Демо-счетов\]** При `APP_MODE="dry_run"` или `APP_MODE="testnet"`, методы `getStrategyContext()` и `getRiskRules()` должны возвращать агрессивные настройки для быстрого тестирования.
14. **\[Тест Дополнительных геттеров\]** Методы `getDryRunInitialBalance()`, `getSlowCycleIntervalMs()`, `getLocalExecutionBalancePercent()`, `getDefaultTriggerTimeoutMinutes()` должны возвращать корректные значения или значения по умолчанию.
