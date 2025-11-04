# Техническое Задание (ТЗ): 4.2 Сборщик Рыночных Данных (MarketDataService)

**Эпик:** 4. 📊 "Наблюдатель" (Watcher) - Сбор Данных и Технический Анализ **Задача:** 4.2 Сборщик Рыночных Данных **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать **Singleton-сервис** `MarketDataService`, который отвечает за сбор, агрегацию и форматирование всех "детальных" рыночных данных для `triggered_pair` (согласно Категории 1 в `about.md`), подготавливая их для отправки в LLM.

## 2\. Архитектурное Решение

1.  **Параллельность (Критично):** Главный метод сбора _обязан_ использовать `Promise.all` для одновременного получения OHLCV, Order Book и Trades, чтобы минимизировать задержку между моментом триггера и моментом запроса LLM.
2.  **Финансовая Точность (Критично):** Сервис _обязан_ реализовать сложную логику агрегации стакана (расчет объемов в пределах 0.5% от лучшей цены) с использованием **`decimal.js`** для всех расчетов (`.times`, `.plus`, `.filter`), как того требует `about.md` (Категория 1.2).
3.  **Трансляция Типов:** Сервис _обязан_ работать исключительно с типами `Decimal` (которые уже возвращает `IExchangeService`) и гарантировать, что все возвращаемые им структуры (`AggregatedOrderBook`, `RecentTrade`) используют `Decimal | null`.
4.  **Отказоустойчивость:** В случае сбоя API или пустого стакана, метод _обязан_ вернуть пустую/нулевую структуру, чтобы не вызвать сбой `TAEngineService` (4.1) или `LLMRequestAssemblerService` (4.6).

## 3\. Зависимости Задачи

- **`IExchangeService` (3.1):** (Зависимость) Предоставляет сырые данные API (`fetchOHLCV`, `fetchOrderBook`, `fetchMyTrades`).
- **`decimal.js` (1.2):** (Зависимость) Для агрегации стакана.
- **`LoggingService` (1.4):** (Зависимость) Для логирования.
- **Интерфейсы (4.1/4.2):** Необходимо определить типы `AggregatedOrderBook`, `RecentTrade` и `DetailedMarketData` с полями `Decimal | null`.

## 4\. Описание и Нюансы Реализации

### 4.1. Метод `fetchDetailedMarketData(pair, timeframe, ohlcvLimit?, tradesLimit: 50)`

1.  **Логика:** Этот метод _обязан_ запустить три асинхронные операции через `Promise.all`:
    - `this.fetchOHLCV(pair, timeframe, undefined, ohlcvLimit)`
    - `this.fetchAggregatedOrderBook(pair, 100)`
    - `this.fetchRecentTrades(pair, tradesLimit)`
2.  **Нюанс:** В случае ошибки в одной из операций `Promise.all` произойдет сбой. Общий `try/catch` _обязан_ перехватить этот сбой, залогировать его (`error`) и вернуть отказоустойчивую структуру (`{ ohlcv: [], orderBook: null, recentTrades: [] }`).

### 4.2. Метод `fetchAggregatedOrderBook(pair, depth: 100)`

1.  **Загрузка:** Вызвать `exchangeService.fetchOrderBook(pair, depth)` в блоке `try/catch`.
2.  **Проверка пустого стакана:** Если `orderBook.bids` или `orderBook.asks` пусты, залогировать `warn` и вернуть `AggregatedOrderBook` со всеми полями `null`.
3.  **Определение Лимитов (Критично):** _обязан_ получить `best_bid` (первый элемент `bids[0][0]`) и `best_ask` (первый элемент `asks[0][0]`), которые уже являются `DecimalValue` благодаря `IExchangeService`.
    - **Проверка:** Если `best_bid` или `best_ask` отсутствуют, залогировать `warn` и вернуть `AggregatedOrderBook` со всеми полями `null`.
    - _Расчет:_ `bid_limit_price` _обязан_ быть рассчитан как `best_bid.mul(new Decimal(0.995))`.
    - _Расчет:_ `ask_limit_price` _обязан_ быть рассчитан как `best_ask.mul(new Decimal(1.005))`.

4.  **Агрегация Объемов (Критично):**
    - **Bids:** Инициализировать `aggregatedBidVolume = new Decimal(0)`. Пройти циклом по `bids`:
      - Для каждой заявки проверить `price.gte(bidLimitPrice)`.
      - Если условие выполнено, добавить объем: `aggregatedBidVolume = aggregatedBidVolume.plus(amount)`.
      - Если условие не выполнено, прервать цикл (так как bids отсортированы по убыванию).
    - **Asks:** Инициализировать `aggregatedAskVolume = new Decimal(0)`. Пройти циклом по `asks`:
      - Для каждой заявки проверить `price.lte(askLimitPrice)`.
      - Если условие выполнено, добавить объем: `aggregatedAskVolume = aggregatedAskVolume.plus(amount)`.
      - Если условие не выполнено, прервать цикл (так как asks отсортированы по возрастанию).

5.  **Расчет спреда:** Рассчитать `spread = best_ask.sub(best_bid)`.

6.  **Возврат:** _обязан_ вернуть `AggregatedOrderBook` со всеми полями как `DecimalValue | null`.
7.  **Обработка ошибок:** Метод _обязан_ быть обернут в `try/catch`. При ошибке логировать `error` и вернуть `AggregatedOrderBook` со всеми полями `null`.

### 4.3. Методы `fetchOHLCV` и `fetchRecentTrades`

1.  **Метод `fetchOHLCV`:**
    - **Логика:** Метод является тонкой оберткой над `IExchangeService.fetchOHLCV`.
    - **Нюанс:** Метод _обязан_ быть обернут в `try/catch`. При ошибке логировать `error` и возвращать пустой массив `[]`.

2.  **Метод `fetchTicker`:**
    - **Логика:** Метод является тонкой оберткой над `IExchangeService.fetchTicker`.
    - **Нюанс:** Метод _обязан_ быть обернут в `try/catch`. При ошибке логировать `error` и пробросить ошибку дальше.

3.  **Метод `fetchRecentTrades`:**
    - **Логика:** Метод вызывает `IExchangeService.fetchMyTrades(pair, undefined, limit)` и выполняет маппинг результатов.
    - **Нюанс:** `IExchangeService.fetchMyTrades` возвращает `IDecimalTrade[]` (где цены/объемы уже являются `DecimalValue`). Метод _обязан_ выполнить маппинг в наш внутренний `RecentTrade[]`, извлекая поля `timestamp`, `price`, `amount`, `side` из каждой сделки.
    - **Нюанс отказоустойчивости:** Метод _обязан_ быть обернут в `try/catch`. При ошибке логировать `error` и возвращать пустой массив `[]`.

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Interface

    Созданы/дополнены `AggregatedOrderBook`, `RecentTrade` и `DetailedMarketData`, где все финансовые поля имеют тип `Decimal | null`.

2.  Service

    `MarketDataService` создан как Singleton с методом `getInstance(exchangeService)` и корректно получает `IExchangeService` через DI в конструкторе.

3.  Concurrency

    `fetchDetailedMarketData` _обязан_ использовать `Promise.all` для одновременного сбора данных.

4.  OrderBookLogic(Критично)

    Метод `fetchAggregatedOrderBook` _корректно_ реализует логику агрегации 0.5% (определение лимитов, фильтрация).

5.  Precision(Критично)

    `fetchAggregatedOrderBook` _обязан_ использовать **`decimal.js`** (`.times`, `.plus`, `.gte`, `.lte`) для _всех_ расчетов и сравнений.

6.  DataOutput

    `fetchRecentTrades` _обязан_ выполнять маппинг сырых данных в наш внутренний тип `RecentTrade[]` с полями `Decimal`.

7.  Robustness

    Главный метод `fetchDetailedMarketData` _обязан_ обрабатывать ошибки (включая сетевые/API) и возвращать пустую структуру данных (`{ ohlcv: [], orderBook: null, recentTrades: [] }`), чтобы предотвратить сбой вызывающих сервисов. Методы `fetchOHLCV` и `fetchRecentTrades` также обрабатывают ошибки и возвращают пустые массивы.

8.  EmptyOrderBook

    Метод `fetchAggregatedOrderBook` корректно обрабатывает пустой стакан и возвращает структуру со всеми полями `null`.

9.  TradesMapping

    Метод `fetchRecentTrades` корректно маппит `IDecimalTrade[]` в `RecentTrade[]`, извлекая только необходимые поля (`timestamp`, `price`, `amount`, `side`).
