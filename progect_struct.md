# 🚀 План Разработки: LLM-Трейдер (Логический Порядок)

## 🏛️ Фаза 1: Фундамент и Ядро Системы

На этом этапе мы создаем все базовые "несущие" сервисы, которые не зависят от бизнес-логики, но от которых зависит всё остальное.

### Эпик 1: 🏗️ Ядро Проекта, Окружение и TypeScript (Core Project & Environment)

**Цель:** Создать фундамент проекта на TypeScript, настроить окружение, зависимости и базовые сервисы (конфигурация, логирование, состояние).

- **Задача 1.1: Инициализация TypeScript-проекта**
  - Описание: Настройка `npm`, `package.json`, `tsconfig.json`. Интеграция `ESLint` и `Prettier` для строгого контроля качества кода.
  - Функционал: `tsc`, `lint`, `format`, структура папок (`src`, `dist`).

- **Задача 1.2: Установка и типизация зависимостей**
  - Описание: Установка `ccxt`, `pg` (node-postgres), `decimal.js`, `technicalindicators`, `tulind`, `winston` (логирование). Установка всех необходимых `@types/*` пакетов.
  - Функционал: `npm install`, `package.json` финализирован.

- **Задача 1.3: Модуль Конфигурации (ConfigService)**
  - Описание: Создание строго типизированного `ConfigService` (Singleton), который читает `.env` файлы.
  - Функционал: Загрузка `APP_MODE` ('production', 'testnet', 'dry_run'). Загрузка `BINANCE_API_KEY/SECRET`, `DB_HOST/USER/PASS`, `WATCHLIST`, `LLM_API_URL` (для Mock-сервера), `LLM_API_KEY` (для Production).  Загрузка `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Загрузка `strategy_context` (Роль, Стиль) и `risk_rules` (default_risk_percent, max_allowed_risk_percent, max_total_portfolio_risk_percent, desired_risk_reward_ratio) из Категории 4. Валидация переменных окружения при старте.

- **Задача 1.4: Система Логирования (LoggingService)**
  - Описание: Настройка `winston`. Создание `LoggingService` (Singleton).
  - Функционал: Структурированные JSON-логи. Раздельные транспорты для `console` (цветной, `dev`) и `file` (JSON, `prod`). Контекстные логггеры (e.g., `[Watcher]`, `[Worker]`).

- **Задача 1.6 : Глобальный Cервис Состояния (GlobalStateService)**
  - Описание: Создание Singleton-сервиса, который хранит `in-memory` флаги состояния приложения (`isPaused`, `isShuttingDown`).
  - Функционал: `isPaused: boolean = false`, `isShuttingDown: boolean = false`. Методы `pause()`, `resume()`, `getIsPaused()`. Методы `startShutdown()`, `getIsShuttingDown()`.

### Эпик 2: 🐘 Архитектура Базы Данных (PostgreSQL)

**Цель:** Спроектировать, реализовать и подготовить к работе схему данных в `PostgreSQL` в соответствии с `about.md`.

- **Задача 2.1: Проектирование Схемы БД (Schema Design)**
  - Описание: Написание DDL-скрипта (`.sql`) для создания всех таблиц.
  - Функционал: Таблицы `ActivePositions`, `ActiveOrders`, `TSL_State`, `LLM_Triggers`, `TradeHistory`. **Критично:** Использование `NUMERIC` или `DECIMAL` для всех цен, сумм и PnL.  Таблица `ActiveOrders` должна включать `nullable` поля: `target_stop_loss_price`, `target_take_profit_price`, `target_trailing_stop_json`. Эти поля _обязательны_ для ордеров типа `OPEN_LIMIT`.

- **Задача 2.4 : Таблица Аудита (LLM_Decision_Log)**
  - Описание: Проектирование и добавление в миграцию (2.2) таблицы для полного "черного ящика" (журнала аудита) каждого вызова LLM.
  - Функционал: Таблица `LLM_Decision_Log`. Колонки: `id (primary key)`, `timestamp`, `triggered_pair`, `trigger_reason`, `request_payload_json` (полный JSON запроса), `response_payload_json` (полный JSON ответа), `decision_result` ('pending', 'accepted', 'rejected_by_validator', 'failed_by_worker'), `validator_error_message` (nullable, text), `worker_error_message` (nullable, text).

- **Задача 2.2: Внедрение системы Миграций**
  - Описание: Интеграция инструмента миграций (например, `node-pg-migrate`).
  - Функционал: Создание `initial-schema.ts` (миграция 1). Скрипты `npm run migrate:up`, `npm run migrate:down`.

- **Задача 2.3: Сервис-обертка для СУБД (DatabaseService)**
  - Описание: Создание `DatabaseService` (Singleton) для инкапсуляции работы с `pg.Pool`.
  - Функционал: Управление `pg.Pool`. Методы `query()`, `getClient()`. **Критично:** Создание helper-функции `executeInTransaction(callback)` для атомарного выполнения операций (как требуется для `Worker` и `SyncEngine`).  Метод `async closePool()` для Graceful Shutdown.

### Эпик 3: 🔌 Core-Сервисы и Клиенты (Core Services & Clients)

**Цель:** Создать типизированные клиенты для взаимодействия со всеми внешними системами (Биржа, LLM), включая симулятор для `DRY_RUN`.

- **Задача 3.1: Клиент Биржи (ExchangeService)**
  - Описание: Создание `ExchangeService` (Singleton) как типизированной обертки над `ccxt`.
  - Функционал: Инициализация `ccxt.binance()` (в режиме Spot). Централизованная обработка ошибок `ccxt` (`RateLimitError`, `NetworkError` и т.д.).  Метод `async close()` для закрытия WS-соединений.

- **Задача 3.2: Загрузчик Правил Биржи (ExchangeRulesLoader)**
  - Описание: Реализация функции `loadExchangeRules` (раздел A.1 из `about.md`).
  - Функционал: Вызов `ccxt.loadMarkets()`. Парсинг и кэширование `limits.cost.min` (`minNotional`), `taker` (комиссия).  **Критично:** Парсинг и кэширование `precision.amount` (точность количества) и `precision.price` (размер тика) для каждой пары.

- **Задача 3.3: Mock-Клиент LLM (MockLLMService)**
  - Описание: Создание "заглушки" (`MockLLMService`), которая имитирует API LLM (согласно "Дипсик").
  - Функционал: Метод `async ask(payload: LLMRequest): Promise<LLMResponse>`. Возвращает предопределенный, валидный JSON-ответ (из Примера 2 в `about.md`).

- **Задача 3.4 : Production-Клиент LLM (ProductionLLMService)**
  - Описание: Реализация production-ready клиента для API LLM (e.g., OpenAI, Anthropic).
  - Функционал: Реализация того же интерфейса `async ask(...)`, что и у `MockLLMService`. Использование `axios/fetch` с `LLM_API_KEY`. **Критично:** Реализация логики `retry` (exponential backoff) для ошибок 429 (Rate Limit) и 5xx (Server Error). Обработка таймаутов.

- **Задача 3.5 (Переименована): Симулятор Биржи (MockExchangeService)**
  - Описание: **(Ранее 3.4)** Создание `MockExchangeService` (симулятора) для режима `DRY_RUN`.
  - Функционал: Хранение `in-memory` "фальшивого" баланса. Реализация `createOrder` (market исполняется сразу, limit добавляется во "внутренний" стакан), `cancelOrder`, `fetchBalance`, `fetchOpenOrders`. Симуляция `fetchMyTrades` (возврат "исполненного" `market`\-ордера с `fakeFee`).

## 🏛️ Фаза 2: Контракты, Правила и Логика Ядра

На этом этапе мы определяем "мозг" системы: _что_ мы отправляем, _что_ мы ожидаем, _как_ мы это валидируем и _как_ мы управляем одновременным доступом.

### Эпик 10: 🧠 Архитектура Промптов и "Личность" Трейдера (Prompt Engineering)

**Цель:** Спроектировать и реализовать **единую** систему промптов для первой итерации. Эта система должна "загружаться" `WatcherOrchestrator` (Эпик 5) и гарантировать, что LLM (1) действует в рамках строгих правил управления рисками, (2) корректно анализирует предоставленные JSON-данные и (3) **всегда** возвращает ответ в валидном JSON-формате, требуемом `WorkerService` (Эпик 7).

- **Задача 10.1: 📜 Проектирование "Системного Промпта" (System Prompt) - Ядро Личности и Стратегии**
  - **Описание:** Создание основного, высокоуровневого файла `system_prompt.md`. Этот промпт определяет роль, ограничения, **единую стратегию** и основную директиву LLM.
  - **Функционал:**
    - Определение **Роли:** "Ты — профессиональный риск-менеджер и помощник трейдера".
    - **Определение Стратегии:** Включает в себя _единое_, _неизменное_ описание стиля торговли (e.g., 'Ты — консервативный свинг-трейдер. Фокусируйся на старших таймфреймах (`analysis_4h`), `EMA_200`, `key_levels` и `fear_and_greed_index`. Твоя главная цель - сохранение капитала.').
    - **Главная Директива:** "Твоя задача — анализировать JSON-данные о рынке и портфеле и возвращать решения в **строго** определенном JSON-формате. Ошибки в формате недопустимы".
    - **Фокус на Риск (Критично):** "Первоочередная задача — управление риском и сохранение капитала. Вторая — получение прибыли. Ты ДОЛЖЕН всегда ссылаться на `risk_rules` при принятии решений".
    - **Инструкция по Формату:** "Твой ответ ДОЛЖЕН быть только валидным JSON-объектом, без какого-либо предшествующего или последующего текста".

- **Задача 10.2: 🧩 Упрощение Загрузки "Профиля Стратегии"**
  - **Описание:** Упрощение для первой итерации. Вместо модульных файлов, базовая стратегия и стиль торговли (см. 10.1) определяются _непосредственно_ в `system_prompt.md`.
  - **Функционал:**
    - **(Архитектор):** `ConfigService` (Эпик 1) и `LLMRequestAssemblerService` (Эпик 4) _не_ реализуют логику переключения стратегий. `LLMRequestAssemblerService` просто собирает JSON, включающий `risk_rules` из `ConfigService`, без загрузки отдельных файлов стратегий.

- **Задача 10.3: ⛓️ Внедрение "Цепочки Размышлений" (Chain-of-Thought / CoT)**
  - **Описание:** Модификация `system_prompt.md` (Задача 10.1) с требованием к LLM сначала думать, а потом отвечать. Это критично для отладки и аудита (данные пойдут в `LLM_Decision_Log` из Эпика 2).
  - **Функционал:**
    - **Инструкция в System Prompt:** "Прежде чем дать JSON-ответ, ты ДОЛЖЕН сформулировать свой анализ в поле `justification` внутри JSON. Этот анализ должен быть твоей "цепочкой размышлений"".
    - **Требования к `justification`:** "В `justification` ты должен кратко объяснить: 1. Какие индикаторы (TA) ты увидел? 2. Как `macro_context` (`Fear & Greed`) повлиял на твое решение? 3. Как `account_state` (текущие позиции/риск) повлиял на твое решение? 4. Почему ты выбрал именно такой `risk_percent` (если открываешь позицию)?".

- **Задача 10.4: ✍️ Создание Шаблона "Задачи" (User Prompt Template)**
  - **Описание:** Создание файла `user_prompt_template.md`, который является "оберткой" для всех динамических данных из `about.md` (Категории 1, 2, 3).
  - **Функционал:**
    - Файл должен содержать плейсхолдеры (например, `{{STRATEGY_CONTEXT}}`, `{{MARKET_DATA_JSON}}`, `{{ACCOUNT_STATE_JSON}}`, `{{FINAL_QUESTION}}`).
    - Проектирование плейсхолдера `{{FINAL_QUESTION}}` (из `about.md`), который четко ставит задачу.
    - **Пример `{{FINAL_QUESTION}}`:** "Триггер сработал для `{{TRIGGERED_PAIR}}`. Текущий макро-контекст: `{{MACRO_TEXT}}`. Проанализируй `{{TRIGGERED_PAIR}}` (включая TA и `order_book`) в контексте всего портфеля (`{{ACCOUNT_STATE_JSON}}`) и прими торговое решение. Действуй в рамках своей роли и `risk_rules`, предоставленных в `strategy_context`."

- **Задача 10.5: 🗃️ Формализация и Внедрение Выходной Схемы (JSON Output Schema)**
  - **Описание:** Создание текстового описания (или `JSON Schema`) _ожидаемого ответа LLM_ (согласно "Пример ОЖИДАЕМОГО ОТВЕТА" из `about.md`).
  - **Функционал:**
    - Создание файла `output_schema.md`.
    - Этот файл будет содержать описание _каждого_ поля JSON, которое LLM _должна_ вернуть (e.g., `decisions`, `action`, `parameters`, `risk_percent`, `next_call_triggers`, `request_additional_data`).
    - **Критично (Архитектор):** Этот файл `output_schema.md` ДОЛЖЕН быть включен в `user_prompt_template.md` (Задача 10.4). LLM должна _видеть_ требуемую схему при каждом вызове, чтобы минимизировать ошибки форматирования.

- **Задача 10.6: 🧪 Создание "Промпт-Реестра" и Тестовых Кейсов**
  - **Описание:** Структурирование всех созданных `.md` файлов в единый, версионированный каталог и написание "юнит-тестов" для промптов.
  - **Функционал:**
    - Создание структуры папок: `/src/prompts/v1/`
    - Размещение файлов: `system.md`, `user_template.md`, `output_schema.md`.
    - Создание `prompt_test_cases.md`:
      - **Тест-кейс 1 (Long):** Пример JSON-входа (Рынок "Extreme Fear", RSI 25, цена у `key_levels.low`). Ожидаемый `justification` (e.g., "Рынок перепродан, вхожу контртренд с _уменьшенным_ риском 0.5%"). Ожидаемый `decision` (`OPEN_LONG`).
      - **Тест-кейс 2 (Hold):** Пример JSON-входа (Рынок "Neutral", ADX < 20 (из "Расширенного пакета"), цена в середине BB). Ожидаемый `justification` ("Нет тренда (ADX < 20), в рынок не лезу"). Ожидаемый `decision` (`[]`).
      - **Тест-кейс 3 (Risk Limit):** Пример JSON-входа (Сигнал на `OPEN_LONG`, но `account_state.total_portfolio_risk` уже 9.5% при лимите 10%). Ожидаемый `justification` ("Вижу сигнал, но не могу войти, так как превышу `max_total_portfolio_risk_percent`"). Ожидаемый `decision` (`[]`).

### Эпик 9: 🚦 Контроль Конкурентности и Блокировок (Concurrency Control)

**Цель:** Устранить риск "гонки состояний" (Race Conditions) между `SyncEngine`, `TSLHandler` и `WorkerService` путем внедрения "Actor-lite" модели, которая сериализует все критические операции _для каждой пары_.

- **Задача 9.1: Менеджер "Актеров" (PairActorManagerService)**
  - Описание: Создание Singleton-сервиса, который управляет `Promise`\-очередями (сериализаторами) для каждой торговой пары.
  - Функционал: `private promiseQueues = new Map<string, Promise<any>>()`. Метод `async execute<T>(pair: string, task: () => Promise<T>): Promise<T>`. Логика `execute` (сериализация `task` в цепочку `Promise`). Использование `.catch(() => {})` в цепочке `Promise` для предотвращения "сломанной" цепочки.  Метод `async waitForAllQueuesToSettle(timeout: number)` (использует `Promise.allSettled()` на `Map.values()` с `Promise.race()` для таймаута).

- **Задача 9.2: Внедрение в "Медленный Цикл" (SlowCycle Integration)**
  - Описание: Модификация `SyncEngine` (5.1, 5.1.1, 5.1.2) и `StopLossJanitor` (5.2.1) для использования `PairActorManagerService`.
  - Функционал: Все операции (reconcile, forensic-logic, janitor) _внутри_ цикла по парам должны быть обернуты: `await this.pairActorManager.execute(pair, async () => { ... (существующая логика) ... })`.

- **Задача 9.3: Внедрение в "Быстрый Цикл" (FastCycle Integration)**
  - Описание: Модификация `TSLHandlerService` (5.4) и `PriceTriggerHandler` (5.5) для использования `PairActorManagerService`.
  - Функционал: `if (trigger_hit)` -> `this.pairActorManager.execute(pair, async () => { ... (существующая логика) ... })`. **Критично:** `execute` вызывается _без_ `await`, чтобы не блокировать event loop WebSocket.

- **Задача 9.4: Внедрение в "Исполнитель" (Worker Integration)**
  - Описание: Модификация `WatcherOrchestrator` (5.6) и `WorkerService` (7.1).
  - Функционал: `WatcherOrchestrator` _больше не_ вызывает `WorkerService.execute` напрямую. Вместо этого он вызывает `this.pairActorManager.execute(pair, async () => { ... (логика вызова LLM (5.6) + вызов Worker (7.1)) ... })`. Это гарантирует, что `Worker` также находится в той же очереди, что и `Sync` и `TSL`.

### Эпик 6: 🛡️ "Валидатор" (Validator Service)

**Цель:** Реализовать "предохранитель" системы (`Validator`) согласно Техзаданию 2.1. **Требование: 100% расчетов на `decimal.js`**.

- **Задача 6.1: Валидация "Здравого Смысла" и Логики (Sanity & Logic Checks)**
  - Описание: Реализация проверок из разделов 1 и 2 техзадания `Validator`. Внедрение (DI) `ExchangeRulesLoaderService` (из 3.2).
  - Функционал: `validateDecision()`. Проверка наличия `pair`, `stop_loss_price` (для `OPEN`). Проверка `SL < entry_price` (для `long`) и `SL > entry_price` (для `short`). Проверка `TP > entry_price` (для `long`).

- **Задача 6.2: Расчет Размера Позиции (Position Sizing Logic)**
  - Описание: Реализация "Volatility-Based Position Sizing" (раздел 3). Расчет _"сырого"_ (raw) `amount_coin` до округления.
  - Функционал: Расчет `usd_at_risk` (на основе `risk_percent_to_use`). Расчет `distance_to_stop_usd_per_coin`. **Возврат** `{ raw_amount_coin, raw_amount_usd, usd_at_risk }`.

- **Задача 6.3: Валидация Риска Портфеля (Total Portfolio Risk Check)**
  - Описание: Реализация проверки `max_total_portfolio_risk_percent` (раздел 3).
  - Функционал: Суммирование рисков _всех_ `ActivePositions` из `account_state` + `usd_at_risk` новой сделки (из 6.2).

- **Задача 6.6 : Валидация и Округление Точности (Precision Handling)**
  - Описание: Обязательное округление `amount_coin` и `price` в соответствии с `precision` (из 3.2).
  - Функционал: 1. Получение `precision.amount` и `precision.price` из `ExchangeRulesLoaderService`. 2. `rounded_amount_coin = ccxt.amountToPrecision(pair, raw_amount_coin, precision.amount)`. 3. `rounded_price = ccxt.priceToPrecision(pair, raw_price, precision.price)` (для limit-ордеров). 4. _Повторный расчет_ `rounded_amount_usd = rounded_amount_coin * rounded_price`. 5. _Повторная проверка_ `rounded_amount_usd >= minNotional`. 6. Возврат округленных значений для `Worker`.

- **Задача 6.4: Валидация Баланса и Биржи (Balance & Exchange Checks)**
  - Описание: Реализация проверок баланса (раздел 3) и `minNotional` (раздел 4), _используя округленные значения из 6.6_.
  - Функционал: Проверка `rounded_amount_usd <= available_quote_balance`. Проверка `rounded_amount_usd >= minNotional`.

- **Задача 6.5: Валидация Комиссии (Fee Logic Check)**
  - Описание: Реализация критической проверки "Комиссия против Риска" (раздел 4).
  - Функционал: Расчет `round_trip_fee_usd` (на основе _округленного_ `rounded_amount_usd` из 6.6). Проверка `usd_at_risk > round_trip_fee_usd`.

## 🏛️ Фаза 3: Функциональные Модули (Сбор и Исполнение)

Теперь, когда у нас есть все сервисы, правила и контракты, мы можем построить два главных функциональных блока: "сборщик данных" и "исполнитель".

### Эпик 4: 📊 "Наблюдатель" (Watcher) - Сбор Данных и Технический Анализ

**Цель:** Реализовать все сервисы, отвечающие за сбор, расчет и агрегацию данных (Категории 1, 2, 3, 4) для LLM.

- **Задача 4.1: Движок Технического Анализа (TAEngineService)**
  - Описание: Создание сервиса, инкапсулирующего `technicalindicators` и `tulind` (согласно Приложениям А и Б).
  - Функционал: `async getAnalysis(ohlcv, requestedData: string[])`. Сервис _всегда_ считает "Базовый Пакет" (Приложение А). Если `requestedData` (e.g., `['ADX', 'ATR']`) не пуст, он _также_ считает "Расширенный Пакет" (Приложение Б) и объединяет результаты. **Критично:** Использование `decimal.js` для всех числовых результатов.

- **Задача 4.2: Сборщик Рыночных Данных (MarketDataService)**
  - Описание: Сервис для сбора детальных данных по `triggered_pair` (Категория 1).
  - Функционал: `fetchOHLCV(pair, timeframe)`. `fetchAggregatedOrderBook(pair)` (с `decimal.js` для агрегации 0.5%). `fetchRecentTrades(pair)`.

- **Задача 4.3: Сборщик Обзора Watchlist (WatchlistOverviewService)**
  - Описание: Сервис для "легкого" среза данных по `watchlist` (Категория 1.4).
  - Функционал: `fetchWatchlistOverview(triggered_pair)`. Асинхронный параллельный запрос `RSI` и `current_price` для всех _других_ пар в `watchlist`.

- **Задача 4.4: Сборщик Макро-Контекста (MacroContextService)**
  - Описание: Реализация `updateMacroContext` (раздел Г).
  - Функционал: `async fetchFearAndGreed()`. Использование `axios` или `node-fetch`. Кэширование результата in-memory (e.g., на 1 час).

- **Задача 4.5: Сборщик Состояния Портфеля (AccountStateService)**
  - Описание: Реализация `fetchFullAccountState()` (Категория 3). Создание сервиса, который кэширует `globalAccountState` (in-memory) и отвечает за его обновление.
  - Функционал: Агрегация данных из `ExchangeService.fetchBalance()`, `DB.query('SELECT * FROM ActivePositions')`, `DB.query('SELECT * FROM ActiveOrders')`. Расчет `total_portfolio_value_usdt` (с `decimal.js`).  Добавление метода `async refreshNow()` (который выполняет всю логику сбора) и `getAccountState()` (который возвращает кэш).

- **Задача 4.5.1 : Немедленная Инвалидация Кэша (Cache Invalidation)**
  - Описание: Подписка `AccountStateService` на событие `trade_executed` от `WorkerService`.
  - Функционал: При получении события, `AccountStateService` немедленно вызывает `this.refreshNow()` для обновления `globalAccountState`.

- **Задача 1.5 / 3.6: Сервис Уведомлений (NotificationService)**
  - Описание: Создание Singleton-сервиса для отправки PUSH-уведомлений (e.g., Telegram-бот) о штатных и критических событиях.
  - Функционал: `async sendAlert(message: string, includeAccountState: boolean = false)`. Читает `TELEGRAM_BOT_TOKEN/CHAT_ID` из `ConfigService`.  Получает `AccountStateService` (через DI), чтобы `if (includeAccountState)` -> прикрепить к сообщению `globalAccountState` (балансы).

- **Задача 4.6: Сборщик Запроса к LLM (LLMRequestAssemblerService)**
  - Описание: Сервис, который объединяет данные из всех других сервисов (4.1-4.5) и `ConfigService` (risk_rules) в единый JSON-запрос (Пример 1).
  - Функционал: `async buildRequest(triggered_pair, reason)`.  1. `const row = await DB.query('SELECT requested_data_json FROM LLM_Triggers WHERE pair = ?', [triggered_pair])`. 2. `const requestedData = JSON.parse(row.requested_data_json || '[]')`. 3. Вызов `TAEngineService.getAnalysis(ohlcv, requestedData)`. 4. Сборка итогового JSON.

### Эпик 7: 👷 "Исполнитель" (Worker Service)

**Цель:** Реализовать `Worker`, который физически исполняет приказы, прошедшие `Validator`, и **гарантированно (атомарно)** обновляет состояние в БД, **корректно обрабатывая Market и Limit ордера**.

- **Задача 7.0: Сервис Гарантированного Исполнения (GuaranteedOrderExecutionService)**
  - Описание: Создание сервиса-обертки над `ExchangeService`, который инкапсулирует логику `clientOrderId` и `NetworkError` retry (принцип DRY).
  - Функционал: `async createOrderWithRetry(...)`: Генерирует `clientOrderId (uuid)`. `try { ccxt.createOrder(...) } catch (e) {` (Обработка `NetworkError` с `fetchOrder(uuid)` -> retry). `}`. `async cancelOrderWithRetry(...)`: `try { ccxt.cancelOrder(...) } catch (e) {` (Обработка `NetworkError` с `fetchOrder(id)` -> retry). `}`.

- **Задача 7.1: Диспетчер "Исполнителя" (WorkerService Dispatcher)**
  - Описание: Создание `WorkerService` с методом `execute(decision, llm_decision_log_id)`. Реализация (DI) для `GuaranteedOrderExecutionService` (7.0), `EventBus`, `NotificationService`, `GlobalStateService`. **(Требует Эпик 9)**.
  - Функционал: `execute` _должен_ вызываться _внутри_ `PairActorManager` (см. 5.6 / 9.4). `let validationResult; try { ... } catch (validationError) {` (Логика обновления `LLM_Decision_Log` и `NotificationService.sendAlert`). `return; }` `try {` (Логика `switch (decision.action)` -> вызов `handle...`). `this.eventBus.emit('trade_executed')`. (Логика `NotificationService.sendAlert`). (Логика `UPDATE LLM_Decision_Log SET result = 'accepted'`). `} catch (executionError) {`  `if (executionError instanceof ccxt.InsufficientFundsError)` -> `await GlobalStateService.pause()` + `await NotificationService.sendAlert("FATAL: InsufficientFunds! Pausing bot.", true)` + `await AccountStateService.refreshNow()`. (Логика `UPDATE LLM_Decision_Log` и `NotificationService.sendAlert`). `}`

- **Задача 7.1.3 : Публикация Событий (Event Publishing)**
  - Описание: Эта задача теперь является частью `Задачи 7.1`. `EventBus` (`EventEmitter3`) используется для немедленной инвалидации кэша (`AccountStateService`).
  - Функционал: `this.eventBus.emit('trade_executed')` (вызывается в `Задаче 7.1` после успешной транзакции).

- **Задача 7.2: Реализация `action: OPEN (Market)`**
  - Описание: Логика для немедленного (`market`) открытия позиции. Обернута в `DatabaseService.executeInTransaction()`.
  - Функционал: `const order = await this.guaranteedOrderService.createOrderWithRetry(...)`. `waitForOrderExecution`. `fetchMyTrades`. `await this.guaranteedOrderService.createOrderWithRetry(...)` (для SL/TP). **Транзакция БД:** `INSERT INTO ActivePositions`, `INSERT INTO ActiveOrders` (SL/TP), `INSERT INTO TSL_State`, `INSERT INTO TradeHistory`.

- **Задача 7.2.1 : Реализация `action: OPEN (Limit)`**
  - Описание: Логика для отложенного (`limit`) открытия позиции.
  - Функционал: `const order = await this.guaranteedOrderService.createOrderWithRetry(...)`. **НЕ ЖДАТЬ ИСПОЛНЕНИЯ.** **Транзакция БД:** `INSERT INTO ActiveOrders` (с `order.id`, `type: 'limit_open'`, `status: 'open'`, `target_stop_loss_price`, `target_take_profit_price`).

- **Задача 7.3: Реализация `action: CLOSE_POSITION (Market)`**
  - Описание: Логика для немедленного (`market`) закрытия позиции. Обернута в `DatabaseService.executeInTransaction()`. _Не вызывает_ `cancelAllOrders` для предотвращения "гонки".
  - Функционал: `const order = await this.guaranteedOrderService.createOrderWithRetry(...)`. `waitForOrderExecution`. `fetchMyTrades`. **Транзакция БД:** `DELETE FROM ActivePositions`, `DELETE FROM ActiveOrders`, `DELETE FROM TSL_State`. `INSERT INTO TradeHistory` (с расчетом PnL).

- **Задача 7.3.1 : Реализация `action: CLOSE_POSITION (Limit)`**
  - Описание: Логика для отложенного (`limit`) закрытия позиции (Take Profit).
  - Функционал: `const order = await this.guaranteedOrderService.createOrderWithRetry(...)`. **НЕ ЖDАТЬ ИСПОЛНЕНИЯ.** **Транзакция БД:** `INSERT INTO ActiveOrders` (с `order.id`, `type: 'limit_close'`, `status: 'open'`).

- **Задача 7.4: Реализация `action: MODIFY_POSITION`**
  - Описание: Изменение SL/TP существующей позиции, _включая TSL_.
  - Функционал: `await this.guaranteedOrderService.cancelOrderWithRetry(oldSlOrder.id)`. `const newSlOrder = await this.guaranteedOrderService.createOrderWithRetry(...)`. **Транзакция БД:** `UPDATE ActiveOrders`, `UPDATE ActivePositions`. `UPSERT/DELETE TSL_State`.

- **Задача 7.5: Реализация `action: CANCEL_ORDERS`**
  - Описание: Отмена ордеров (limit, SL) без закрытия позиции.
  - Функционал: `await this.guaranteedOrderService.cancelOrderWithRetry(order_id)`. **Транзакция БД:** `DELETE FROM ActiveOrders WHERE id = ?`.

## 🏛️ Фаза 4: Интеграция и Главный Цикл

Мы собрали все "детали". Теперь мы соединяем их в единый работающий механизм.

### Эпик 5: 🔄 "Наблюдатель" (Watcher) - Синхронизация, Циклы и Триггеры

**Цель:** "Оживить" Наблюдателя, реализовав логику сверки состояния при старте, циклы (WS, `setInterval`) и обработку триггеров.

- **Задача 5.0 : Движок Синхронизации (SyncEngine) - API Сервиса**
  - Описание: Создание `SyncEngineService` (Singleton), который предоставляет два публичных метода для плановой и принудительной сверки. **(Требует Эпик 9)**.
  - Функционал: `async reconcileStateForPair(pair)`: (Вызывает 5.1, 5.1.1, 5.1.2 _внутри_ `pairActorManager.execute(pair, ...)`). `async reconcileStateAll()`: (Вызывает `reconcileStateForPair` для _каждой_ пары в `watchlist`).

- **Задача 5.1: Логика Сверки - Ордера (Зомби / Офлайн)**
  - Описание: Реализация "Сверки Состояния" (раздел A.1) **только для ордеров**. _Вызывается из `reconcileStateForPair`_.
  - Функционал: `fetchOpenOrders()` (Биржа) vs `ActiveOrders` (БД). Реализация Сценариев 3 и 4: "Ордер на Бирже ЕСТЬ, в БД — НЕТ" -> `ccxt.cancelOrder()`; "Ордер в БД ЕСТЬ, на Бирже — НЕТ" -> `DELETE FROM ActiveOrders`.

- **Задача 5.1.1 : Логика Сверки - "Судебная" Сверка Позиций**
  - Описание: Реализация "судебной логики" для восстановления `ActivePositions` (на основе `fetchMyTrades`). _Вызывается из `reconcileStateForPair`_.
  - Функционал: `if (balance > 0 && active_position_missing)`: 1. `exchangeTrades = await ccxt.fetchMyTrades(pair, since=...)`. 2. `dbTrades = await DB.query(...)`. 3. `missingTrades = findMissingTrades(exchangeTrades, dbTrades)`. 4. `for (trade of missingTrades) { DB.query('INSERT INTO TradeHistory ...') }`. 5. `reconstructedPosition = reconstructPositionFromHistory(pair)`. 6. `DB.query('INSERT INTO ActivePositions ...')`.

- **Задача 5.1.2 : Логика Сверки - Исполнение `OPEN_LIMIT`**
  - Описание: Реализация логики обработки частичного или полного исполнения `OPEN_LIMIT` ордеров. _Вызывается из `reconcileStateForPair`_.
  - Функционал: `SELECT * FROM ActiveOrders WHERE type = 'OPEN_LIMIT'`. `if (exchangeOrder.filled > 0)` -> **Атомарная Транзакция** (Cancel -> Delete -> Create SL -> Insert Position -> Insert SL Order -> Insert History).

- **Задача 5.6: Главный Контроллер "Наблюдателя" (WatcherOrchestrator)**
  - Описание: Реализация `executeLLMCall` (раздел Д). _Эта функция всегда вызывается внутри `PairActorManager` (Эпик 9)_.
  - Функционал: 1. Блокировка (`isCallingLLM`). 2. Сборка запроса (через `LLMRequestAssemblerService`). 3. Вызов `this.llmService.ask()`. 4. Запись Аудита (`INSERT INTO LLM_Decision_Log (..., status: 'pending') ... RETURNING id`). 5. Сохранение триггеров (`UPSERT` в `LLM_Triggers`). 6. Передача `decisions` и `log.id` в `WorkerService.execute` (Эпик 7). 7. **(Новый Шаг) Принудительная Синхронизация:** `if (response.decisions.length > 0)` -> `Logger.info('Actions executed by Worker. Forcing post-action state reconciliation for [pair]...')` -> `await this.syncEngine.reconcileStateForPair(triggered_pair)` (Вызов Задачи 5.0). 8. Разблокировка.

- **Задача 5.2: "Медленный Цикл" (SlowCycleService - `setInterval`)**
  - Описание: Реализация `checkIndicatorsAndOhlcv` (раздел В).
  - Функционал: `setInterval` (e.g., 60s). `if (GlobalStateService.isPaused || GlobalStateService.isShuttingDown) return;`. Вызов `AccountStateService.refreshNow()`. Вызов `SyncEngine.reconcileStateAll()` (для плановой сверки всех пар). Проверка `timeout` / `indicator` триггеров. Вызов `WatcherOrchestrator.executeLLMCall`.  Метод `async stop()` (для `clearInterval`).

- **Задача 5.2.1 : Аварийная Проверка "Зависшего Стопа" (Stop-Loss Janitor)**
  - Описание: Добавление "предохранителя" в `SlowCycleService`. **(Требует Эпик 9)**.
  - Функционал: `if (GlobalStateService.isPaused) return;`. `for (const position of globalAccountState.active_positions)`: `if (current_price < position.stop_loss_price)` И `if (SL-ордер ... 'open')` -> **ЧП**: `Logger.fatal(...)`. `await pairActorManager.execute(position.pair, async () => { ... (Вызов` WorkerService.execute({ action: 'CLOSE_POSITION', type: 'market' })`и`NotificationService.sendAlert(...)`) ... })`.

- **Задача 5.3: "Быстрый Цикл" (FastCycleService - WebSocket)**
  - Описание: Реализация `onTickerData` (раздел Б) через `ccxt.watchTickers()`.
  - Функционал: `if (GlobalStateService.isPaused || GlobalStateService.isShuttingDown) return;`. Подписка на `watchlist`. Делегирование обработки `TSLHandlerService` и `PriceTriggerHandler`.  Метод `async stop()` (для `ws.close()`).

- **Задача 5.4: Обработчик TSL (TSLHandlerService)**
  - Описание: Реализация "Задачи №1" из `onTickerData` (раздел Б). **(Требует Эпик 9)**.
  - Функционал: `if (GlobalStateService.isPaused) return;`. `handleTicker(ticker, ...)`. `if (TSL_needs_update)` -> `this.pairActorManager.execute(ticker.pair, async () => { ... (Логика` cancelOrder`+`createOrder `(новый SL) + **Атомарное** обновление БД) ... })`. **Критично:** `execute` вызывается _без_ `await`, чтобы не блокировать WS-цикл.

- **Задача 5.5: Обработчик Триггеров Цены (PriceTriggerHandler)**
  - Описание: Реализация "Задачи №2" из `onTickerData`. **(Требует Эпик 9)**.
  - Функционал: `if (GlobalStateService.isPaused) return;`. `handleTicker(ticker, ...)`. `if (priceTrigger_hit)`:  `const accountState = this.accountStateService.getAccountState()`.  `const hasOpenLimit = accountState.open_orders.find(o => o.pair === ticker.pair && o.type === 'limit_open')`.  `if (hasOpenLimit) { Logger.debug('Price trigger ignored due to active OPEN_LIMIT order. Handing off to SyncEngine.'); return; }`. `this.pairActorManager.execute(ticker.pair, async () => { ... (Вызов` WatcherOrchestrator.executeLLMCall`) ... })`. **Критично:** `execute` вызывается _без_ `await`.

## 🏛️ Фаза 5: Сборка и Тестирование

Финальный этап, где мы пишем "клей" (`index.ts`), объединяющий все сервисы, и покрываем всю систему интеграционными и E2E тестами.

### Эпик 8: 🚀 Сборка, Тестирование и Запуск (Application & Testing)

**Цель:** Объединить все сервисы, покрыть их тестами и создать точку входа для запуска приложения.

- **Задача 8.1: Главная Точка Входа (Main Application - `index.ts`)**
  - Описание: Создание `index.ts`, который инициализирует все Singleton-сервисы (DB, Config, Logger, Exchange, etc.).
  - Функционал: `async function main()`. 1. `Config.load()`. 2. `DB.connect()`. 3. `DB.runMigrations()`. 4. `ExchangeRulesLoader.loadRules()`. 5. Создание `EventBus`. 6. `PairActorManagerService` (Эпик 9). 7. `GlobalStateService` (Эпик 1). 8. `exchangeClient` (Mock/Real) и `llmClient` (Mock/Real). 9. `AccountStateService` (с `eventBus`). 10. `NotificationService` (с `AccountStateService`). 11. `SyncEngine.init(...)`. 12. `SyncEngine.reconcileStateAll(exchangeClient)`. 13. `SlowCycle.start(...)`. 14. `FastCycle.start(...)`. 15.  `GuaranteedOrderExecutionService.init(exchangeClient)`. 16. `WorkerService.init(..., guaranteedOrderService, ...)`.

- **Задача 8.1.1 : Реализация "Корректного Завершения" (Graceful Shutdown)**
  - Описание: Добавление обработчиков `process.on('SIGINT')` и `process.on('SIGTERM')` в `index.ts` (Задача 8.1).
  - Функционал: 1. `Logger.warn("SIGINT/SIGTERM received. Starting graceful shutdown...")`. 2. `GlobalStateService.startShutdown()`. 3. `SlowCycleService.stop()`. 4. `FastCycleService.stop()`. 5. `Logger.info("Waiting for all pending tasks to complete (max 20s)...")`. 6. `await PairActorManagerService.waitForAllQueuesToSettle(20000)`. 7. `Logger.info("All tasks settled.")`. 8. `await NotificationService.sendAlert("Bot shutting down gracefully.")`. 9. `await DatabaseService.closePool()`. 10. `process.exit(0)`.

- **Задача 8.2: Модульное Тестирование (Unit Tests)**
  - Описание: Написание `jest` или `vitest` тестов для "чистой" логики (без БД).
  - Функционал: Тесты для `ValidatorService` (все кейсы ошибок). Тесты для `TAEngineService`. Тесты для `decimal.js` расчетов. Тесты для `MockExchangeService`. Тесты для `ProductionLLMService`.  Тесты для `GuaranteedOrderExecutionService` (mocking `ccxt` и `NetworkError`).

- **Задача 8.2.1 : Настройка Среды Интеграционного Тестирования**
  - Описание: Настройка `jest` (или `vitest`) с `testcontainers` или `docker-compose` для запуска ephemeral (временной) `PostgreSQL` БД для каждого тестового прогона.
  - Функционал: `docker-compose.test.yml`, `jest.globalSetup.ts` для запуска/остановки контейнера, `DatabaseService` (для тестов), который подключается к тестовой БД.

- **Задача 8.2.2 : Интеграционные Тесты - WorkerService**
  - Описание: Написание тестов, которые вызывают `WorkerService` и проверяют _реальное_ состояние БД `PostgreSQL`.
  - Функционал: Тест "OPEN (Market)": `worker.execute(openMarketDecision)` -> `assert(SELECT * FROM ActivePositions) = 1`, `assert(SELECT * FROM TradeHistory) = 1`. Тест "CLOSE (Market)": `worker.execute(closeMarketDecision)` -> `assert(SELECT * FROM ActivePositions) = 0`.

- **Задача 8.2.3 : Интеграционные Тесты - SyncEngine (Forensic Logic)**
  - Описание: Написание тестов для "судебной" логики `SyncEngine`.
  - Функционал: 1. `setup`: `INSERT INTO TradeHistory` (симуляция покупки), `MockExchangeService.setBalance('ETH', 5)`. 2. `execute`: `syncEngine.reconcileStateAll()`. 3. `assert`: `assert(SELECT * FROM ActivePositions WHERE status = 'reconciled') = 1`.

- **Задача 8.3: E2E Тестирование (Paper Trading / Testnet)**
  - Описание: Подготовка к запуску на Testnet или в режиме `DRY_RUN`.
  - Функционал: Переключение `Config.APP_MODE` в `dry_run` или `testnet`. Проверка E2E-цепочки: Price Trigger -> LLM Call -> Validation -> `MockExchangeService` Execution -> `EventBus` emit -> `AccountStateService` refresh -> DB state update.
