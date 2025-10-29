# Техническое Задание (ТЗ): 3.2 Загрузчик Правил Биржи (ExchangeRulesService)

**Эпик:** 3. 🔌 Core-Сервисы и Клиенты (Core Services & Clients) **Задача:** 3.2 Загрузчик Правил Биржи (ExchangeRulesService) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать **Singleton-сервис** `ExchangeRulesService`, который отвечает за _однократную_ загрузку, _парсинг_ и _кэширование_ (in-memory) критически важных правил торгов для каждой пары из `watchlist`.

Этот сервис является **Единым Источником Истины (SSOT)** для всех финансовых и точностных ограничений биржи. Он используется исключительно **`ValidatorService`** (Эпик 6) для проверки исполняемости приказов.

## 2\. Архитектурное Решение

1.  **Асинхронная Инициализация:** Сервис _обязан_ быть инициализирован асинхронно (`async initialize(...)`) один раз при старте приложения, так как он зависит от сетевого вызова `IExchangeService.loadMarkets()`.
2.  **Синхронный API:** После инициализации доступ к правилам _обязан_ осуществляться через **синхронный** метод `getRules(pair)`, так как `ValidatorService` (который работает в высокоскоростном контуре) должен получать данные мгновенно, без `await`.
3.  **Финансовая Точность:** Все финансовые и точностные поля (`minNotional`, `takerFee`, `precision`) _обязаны_ храниться и возвращаться как экземпляры `Decimal` (из `decimal.js`).
4.  **Обработка Отсутствия Данных (Fallback):** Парсинг _обязан_ включать безопасные "резервные" (fallback) значения, если `ccxt` не предоставляет какой-либо лимит (например, `market.limits.cost.min` может быть `null`). Приложение не должно "падать", если не найдено `minNotional`, а должно использовать консервативное значение по умолчанию (e.g., $10).

## 3\. Зависимости Задачи

- `IExchangeService` (3.1): (Зависимость) Для вызова `loadMarkets()` и доступа к сырым рынкам (`getRawMarkets()`).
- `ConfigService` (1.3): (Зависимость) Для получения списка `watchlist`.
- `LoggingService` (1.4): (Зависимость) Для логирования процесса парсинга и фатальных ошибок.
- `decimal.js` (1.2): (Зависимость) Для обеспечения финансовой точности.

## 4\. Описание и Нюансы Реализации

### 4.1. Контракты Данных (`src/interfaces/IMarketRules.ts`)

1.  **Логика:** Разработчик _обязан_ создать интерфейс `IMarketRules`, который описывает конечный, упрощенный набор правил для каждой пары.
2.  **Нюанс реализации:** Интерфейс _обязан_ включать:
    - `minNotional`: `Decimal` (Минимальная стоимость ордера).
    - `takerFee`: `Decimal` (Комиссия Taker).
    - `precision`: Структура, содержащая `amount` (`Decimal`) и `price` (`Decimal`).

### 4.2. Реализация (`src/services/ExchangeRulesService.ts`)

1.  **Структура Класса:** Класс `ExchangeRulesService` _обязан_ быть Singleton и хранить правила в `private rulesCache: Map<string, IMarketRules>`.
2.  **Метод `public static async initialize(...)` (Критично):**
    - **Шаг 1. Загрузка:** Метод _обязан_ вызвать `await exchangeService.loadMarkets()` и получить сырые данные через `exchangeService.getRawMarkets()`.
    - **Шаг 2. Итерация:** _обязан_ пройтись циклом по всем парам из `ConfigService.getWatchlist()`.
    - **Шаг 3. Валидация:** Если пара из `watchlist` не найдена в сырых данных биржи, _обязан_ залогировать `FATAL` и вызвать `process.exit(1)`.
    - **Шаг 4. Парсинг с Fallback (Критично):** Разработчик _обязан_ использовать `try/catch` или операторы `??` для извлечения `minNotional`, `takerFee`, `precision.amount` и `precision.price`. _Обязан_ использовать **консервативные** значения по умолчанию (e.g., $10 для `minNotional`, 0.001 для `takerFee`, `new Decimal('0.01')` для `precision.price`).
    - **Шаг 5. Кэширование:** Каждое правило _обязано_ быть сохранено в `rulesCache` с типом `Decimal`.

3.  **Метод `public getRules(pair: string)` (Синхронный API):**
    - **Логика:** Разработчик _обязан_ реализовать синхронный метод.
    - **Нюанс реализации:** _обязан_ выполнить проверку `if (!rules)` и _бросить ошибку_ (`throw new Error(...)`), если запрошенная пара не была закэширована при старте.

### 4.3. Интеграция в `index.ts` (Задача 8.1)

1.  **Логика:** `index.ts` _обязан_ вызывать инициализацию `ExchangeRulesService` после того, как `IExchangeService` и `ConfigService` уже инициализированы.
2.  **Нюанс реализации:** Вызов _обязан_ выглядеть как `await ExchangeRulesService.initialize(exchangeService, configService)`.

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Service

    `ExchangeRulesService` создан как Singleton с асинхронным `initialize()`.

2.  DataContract

    Файл `IMarketRules.ts` создан, и все его финансовые поля (`minNotional`, `takerFee`, `precision.amount`, `precision.price`) имеют тип `Decimal`.

3.  InitFlow

    `initialize()` корректно вызывает `exchangeService.loadMarkets()` и обрабатывает только пары из `ConfigService.getWatchlist()`.

4.  FatalError

    `initialize()` _корректно_ вызывает `process.exit(1)`, если пара из `watchlist` не найдена в данных биржи.

5.  Parsing(Критично)

    Парсинг _обязан_ конвертировать исходные `number` или `string` из `ccxt` в `Decimal` (e.g., `new Decimal(market.taker)`).

6.  Fallback(Критично)

    Сервис _успешно_ инициализируется, даже если поля `limits` или `precision` в ответе `ccxt` отсутствуют, используя жестко заданные безопасные значения по умолчанию.

7.  API(Критично)

    Метод `getRules(pair)` реализован и является **синхронным**.

8.  APIError

    `getRules(pair)` _корректно_ бросает ошибку, если пара не найдена в кэше `rulesCache`.
