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

1.  **Фильтрация:** _обязан_ получить полный `watchlist` из `ConfigService` и отфильтровать `triggeredPair`.
2.  **Параллелизация (Критично):** _обязан_ запустить асинхронный вызов приватного метода (`_fetchSinglePairOverview`) для _каждой_ оставшейся пары и обернуть это в **`Promise.allSettled`**.
3.  **Обработка `allSettled`:** _обязан_ просмотреть массив результатов `Promise.allSettled`:
    - Если `result.status === 'fulfilled'`, включить результат в итоговый массив.
    - Если `result.status === 'rejected'`, залогировать ошибку (`warn`) и включить в итоговый массив элемент с `pair: <ошибка>` и полями `current_price: null`, `rsi_1h: null`.

### 4.2. Метод `_fetchSinglePairOverview(pair)`

1.  **Логика:** Этот метод _обязан_ работать с одной парой и _обязан_ использовать `Promise.all` для параллельного получения цены и свечей:
    - `exchangeService.fetchTicker(pair)`
    - `marketDataService.fetchOHLCV(pair, '1h', 50)` (50 свечей достаточно для `RSI(14)`).

2.  **Расчет RSI (Критично):** Полученный `OHLCV[]` _обязан_ быть немедленно передан в `taEngineService.getAnalysis(ohlcv, [])`.
3.  **Извлечение:** _обязан_ извлечь `ticker.last` (цена) и `analysis.rsi` (RSI).
4.  **Обработка `null`:** _обязан_ возвращать `Decimal | null` для каждого поля.

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Interface

    Создан интерфейс `WatchlistOverviewItem` с полями `pair`, `current_price: Decimal | null`, `rsi_1h: Decimal | null`.

2.  Service

    `WatchlistOverviewService` создан как Singleton и корректно получает все 4 необходимые зависимости через DI.

3.  Filtering

    `fetchWatchlistOverview` _обязан_ корректно исключать `triggeredPair` из списка обработки.

4.  Concurrency(Критично)

    `fetchWatchlistOverview` _обязан_ использовать `Promise.allSettled` для параллельной и отказоустойчивой обработки всех пар.

5.  Logic:DataChain

    Приватный метод `_fetchSinglePairOverview` _обязан_ использовать `Promise.all` для одновременного получения `Ticker` и `OHLCV`.

6.  Logic:RSI

    `_fetchSinglePairOverview` _обязан_ передавать полученный OHLCV (с таймфреймом '1h' и лимитом ~50) в `taEngineService.getAnalysis()` для извлечения `RSI`.

7.  Robustness

    Сервис _обязан_ логировать ошибки отдельных пар (result.status === 'rejected') и возвращать для этих пар элемент с полями `null`, не прерывая выполнение.
