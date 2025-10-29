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
    DB_PASS="trader_pass"
    DB_NAME="trader_db"

    # 4. Watchlist (через запятую, без пробелов)
    WATCHLIST="BTC/USDT,ETH/USDT"

    # 5. LLM API
    LLM_API_URL="http://localhost:8080/v1/chat/completions"
    LLM_API_KEY="your_llm_api_key_if_needed"

    # 6. Notifications (Telegram)
    TELEGRAM_BOT_TOKEN="YOUR_TELEGRAM_BOT_TOKEN"
    TELEGRAM_CHAT_ID="YOUR_TELEGRAM_CHAT_ID"

    # 7. Strategy Context (Категория 4)
    STRATEGY_ROLE="Ты — профессиональный риск-менеджер и помощник трейдера."
    STRATEGY_STYLE="Ты — консервативный свинг-трейдер. Фокусируйся на старших таймфреймах."

    # 8. Risk Rules (Категория 4)
    RISK_DEFAULT_PERCENT="1.0"
    RISK_MAX_PER_TRADE_PERCENT="2.0"
    RISK_MAX_TOTAL_PORTFOLIO_PERCENT="10.0"
    RISK_DESIRED_RR_RATIO="3.0"

### 3.2. `src/services/ConfigService.ts`

Разработчик должен создать `ConfigService` как класс-Singleton.

#### 3.2.1. Схема Валидации (`zod`)

Внутри сервиса должна быть определена схема `zod` (`configSchema`), которая описывает ВСЕ переменные из `.env.example`.

- **Нюанс:** Числовые значения (например, `DB_PORT`, `RISK_...`) должны быть определены с использованием `z.coerce.number()`, чтобы `zod` автоматически преобразовал строку из `.env` в тип `number`.
- **Нюанс:** `APP_MODE` должен использовать `z.enum(['production', 'testnet', 'dry_run'])`.
- **Нюанс:** `LLM_API_URL` и `LLM_API_KEY` могут быть опциональными (`.optional()`), так как `MockLLMService` (Задача 3.3) не будет их использовать.

#### 3.2.2. Реализация Singleton

Класс должен иметь `private static instance: ConfigService` и `public static getInstance(): ConfigService` для обеспечения единственного экземпляра.

#### 3.2.3. Метод `load()`

- Этот статический метод должен быть **единственной** точкой входа для инициализации сервиса.
- Он должен вызываться **один раз** при старте приложения (в `index.ts`) **до** инициализации всех остальных сервисов.
- **Логика `load()`:**
  1.  Вызвать `dotenv.config()`.
  2.  Обернуть `configSchema.parse(process.env)` в `try...catch`.
  3.  **При успехе:** Сохранить типизированный и валидированный объект `config` в `private` свойстве экземпляра Singleton.
  4.  **При ошибке (провал валидации):**
      - **Критично:** Вывести ошибку валидации `zod` в лог (`console.error`). Ошибка `zod` детально покажет, каких переменных не хватает или какие имеют неверный тип.
      - **Критично:** Принудительно завершить работу приложения: `process.exit(1)`. Это предотвратит запуск бота в некорректной или небезопасной конфигурации.

#### 3.2.4. Геттеры (Getters)

- Сервис не должен предоставлять доступ ко всему объекту `config` напрямую.
- Должны быть созданы типизированные геттеры для каждой группы настроек.
- **Нюанс для `getWatchlist()`:** Этот геттер должен возвращать `string[]`, а не строку. Он должен парсить строку из `config.WATCHLIST.split(',')`.

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
          password: this.config.DB_PASS,
          database: this.config.DB_NAME,
        };
      }

      public getWatchlist(): string[] {
        return this.config.WATCHLIST.split(',');
      }

      public getRiskRules() {
        return {
          defaultRiskPercent: this.config.RISK_DEFAULT_PERCENT,
          maxAllowedRiskPercent: this.config.RISK_MAX_PER_TRADE_PERCENT,
          maxTotalPortfolioRiskPercent: this.config.RISK_MAX_TOTAL_PORTFOLIO_PERCENT,
          desiredRiskRewardRatio: this.config.RISK_DESIRED_RR_RATIO,
        };
      }

      public getStrategyContext() {
         return {
            role: this.config.STRATEGY_ROLE,
            style: this.config.STRATEGY_STYLE,
         };
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
9.  **\[Тест Геттера\]** Временный `console.log(ConfigService.getInstance().getWatchlist())` в `index.ts` (после `load()`) корректно выводит массив `['BTC/USDT', 'ETH/USDT']` (а не строку).
10. **\[Тест Геттера 2\]** Временный `console.log(ConfigService.getInstance().getRiskRules())` выводит объект, где все значения имеют тип `number`.
