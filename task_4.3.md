# Техническое Задание (ТЗ): 4.3 Сборщик Обзора Watchlist (WatchlistOverviewService)

**Эпик:** 4. 📊 "Наблюдатель" (Watcher) - Сбор Данных и Технический Анализ **Задача:** 4.3 Сборщик Обзора Watchlist **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать **Singleton-сервис** `WatchlistOverviewService`, который отвечает за сбор "легкого" среза рыночных данных по всем парам в `watchlist`, _**за исключением**_ `triggered_pair` (Согласно Категории 1.4 в `about.md`).

Сервис должен предоставлять единый метод `fetchWatchlistOverview`, который параллельно собирает `current_price` и `rsi_1h` для каждой релевантной пары.

## 2\. Архитектурное Решение

1.  **Оркестрация и Фильтрация:** Сервис действует как "оркестратор", используя `ConfigService` для фильтрации пар и делегируя задачи по сбору данных уже существующим сервисам (`IExchangeService`, `MarketDataService`, `TAEngineService`).
2.  **Эффективность:** Для расчета `rsi_1h` _обязан_ запрашиваться минимально необходимый объем OHLCV данных (например, 50 свечей), чтобы не тратить время и пропускную способность.
3.  **Конкурентность и Отказоустойчивость (Критично):** Сбор данных для каждой пары _обязан_ выполняться параллельно. _Критически важно_ использовать `Promise.allSettled` для обработки результатов. Если сбор данных для одной пары (например, из-за ошибки API) завершится неудачей, это _не должно_ прервать сбор данных для всего остального `watchlist`.
4.  **Точность:** Все результаты (`current_price`, `rsi_1h`) _обязаны_ возвращаться как `Decimal | null`.

## 3\. Зависимости Задачи

- **`ConfigService` (1.3):** (Зависимость) Для получения `watchlist`.
- **`IExchangeService` (3.1):** (Зависимость) Для `fetchTicker()` (`current_price`).
- **`MarketDataService` (4.2):** (Зависимость) Для `fetchOHLCV()` (как обертка для `IExchangeService`).
- **`TAEngineService` (4.1):** (Зависимость) Для `getAnalysis()` (чтобы извлечь RSI).
- **`LoggingService` (1.4):** (Зависимость).
- **Интерфейсы:** Необходимо определить тип `WatchlistOverviewItem` с полями `Decimal | null`.

## 4\. Описание и Нюансы Реализации

### 4.1. Метод `fetchWatchlistOverview(triggeredPair)`

1.  **Фильтрация:** _обязан_ получить полный `watchlist` из `ConfigService.getWatchlist()` и отфильтровать `triggeredPair` через `watchlist.filter((pair) => pair !== triggeredPair)`.
2.  **Проверка пустого списка:** Если после фильтрации список пуст, залогировать `debug` и вернуть пустой массив `[]`.
3.  **Параллелизация (Критично):** _обязан_ запустить асинхронный вызов приватного метода (`_fetchSinglePairOverview`) для _каждой_ оставшейся пары через `pairsToProcess.map((pair) => this._fetchSinglePairOverview(pair))` и обернуть это в **`Promise.allSettled`**.
4.  **Обработка `allSettled`:** _обязан_ просмотреть массив результатов `Promise.allSettled`:
    - Пройти циклом по индексам результатов.
    - Для каждого результата получить соответствующую пару из `pairsToProcess[i]`.
    - Если `result.status === 'fulfilled'`, включить `result.value` в итоговый массив.
    - Если `result.status === 'rejected'`, залогировать ошибку (`warn`) с указанием пары и включить в итоговый массив элемент с `pair`, `current_price: null`, `rsi_1h: null`.
5.  **Обработка ошибок:** Весь метод _обязан_ быть обернут в `try/catch`. При фатальной ошибке логировать `error` и вернуть пустой массив `[]`.
6.  **Логирование:** Залогировать `debug` с количеством обработанных пар и финальным количеством элементов в результате.

### 4.2. Метод `_fetchSinglePairOverview(pair)`

1.  **Логика:** Этот метод _обязан_ работать с одной парой и _обязан_ использовать `Promise.all` для параллельного получения цены и свечей:
    - `this.exchangeService.fetchTicker(pair)`
    - `this.marketDataService.fetchOHLCV(pair, '1h', undefined, 50)` (50 свечей достаточно для `RSI(14)`).

2.  **Извлечение цены:** Из полученного `ticker` извлечь `ticker.last` (цена) и сохранить в `currentPrice`. Если `ticker.last` отсутствует, установить `currentPrice = null`.

3.  **Расчет RSI (Критично):** 
    - Проверить, что `ohlcv.length > 0`.
    - Если массив не пуст, передать `ohlcv` в `this.taEngineService.getAnalysis(ohlcv, [])`.
    - Извлечь `analysis.rsi` и сохранить в `rsi1h`.
    - Если массив пуст, установить `rsi1h = null`.

4.  **Возврат:** Вернуть объект `WatchlistOverviewItem` с полями `pair`, `current_price: currentPrice`, `rsi_1h: rsi1h`.

5.  **Обработка ошибок:** Метод _обязан_ быть обернут в `try/catch`. При ошибке логировать `warn` с указанием пары и вернуть объект с `pair`, `current_price: null`, `rsi_1h: null`.

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Interface

    Создан интерфейс `WatchlistOverviewItem` с полями `pair`, `current_price: Decimal | null`, `rsi_1h: Decimal | null`.

2.  Service

    `WatchlistOverviewService` создан как Singleton с методом `getInstance(configService, exchangeService, marketDataService, taEngineService)` и корректно получает все 4 необходимые зависимости через DI в конструкторе.

3.  Filtering

    `fetchWatchlistOverview` _обязан_ корректно исключать `triggeredPair` из списка обработки.

4.  Concurrency(Критично)

    `fetchWatchlistOverview` _обязан_ использовать `Promise.allSettled` для параллельной и отказоустойчивой обработки всех пар.

5.  Logic:DataChain

    Приватный метод `_fetchSinglePairOverview` _обязан_ использовать `Promise.all` для одновременного получения `Ticker` и `OHLCV`.

6.  Logic:RSI

    `_fetchSinglePairOverview` _обязан_ передавать полученный OHLCV (с таймфреймом '1h' и лимитом ~50) в `taEngineService.getAnalysis()` для извлечения `RSI`.

7.  Robustness

    Сервис _обязан_ логировать ошибки отдельных пар (`result.status === 'rejected'`) и возвращать для этих пар элемент с полями `null`, не прерывая выполнение. Метод `_fetchSinglePairOverview` также обрабатывает ошибки и возвращает элемент с `null` полями. Весь метод `fetchWatchlistOverview` обернут в `try/catch` для обработки фатальных ошибок.

8.  EmptyList

    Если после фильтрации список пар пуст, метод возвращает пустой массив без попыток сбора данных.

9.  Logging

    Метод логирует `debug` сообщения о количестве обрабатываемых пар и финальном количестве элементов в результате.
