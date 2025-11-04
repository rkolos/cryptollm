# Техническое Задание (ТЗ): 6.1 Валидация "Здравого Смысла" и Логики (Sanity & Logic Checks)

**Эпик:** 6. 🛡️ "Валидатор" (Validator Service) **Задача:** 6.1 Валидация "Здравого Смысла" и Логики (Sanity & Logic Checks) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать "скелет" **Singleton-сервиса** `ValidatorService` и реализовать **Уровень 1** проверок. Этот уровень отвечает за базовую "вменяемость" приказа от LLM и базовую логику Stop Loss / Take Profit, прежде чем переходить к сложным расчетам риска.

## 2\. Архитектурное Решение и Принципы

1.  **Финансовая Точность (Критично):** **Все** сравнения и расчеты цен (`entryPrice`, `stop_loss_price`) _обязаны_ выполняться с использованием **`decimal.js`** для предотвращения ошибок с плавающей запятой.
2.  **Стандартизированная Ошибка:** _обязан_ быть создан кастомный класс **`ValidationError`**. Он должен иметь флаг **`isHold: boolean`** для отличия _реальной_ ошибки (невалидный приказ) от штатного приказа "Пропуск" (`action: HOLD`).
3.  **Возврат Цены:** Метод `_validateSanityAndLogicChecks` должен **вернуть** рассчитанную цену входа (`entryPrice`) в виде `Decimal` для использования в следующих уровнях валидации.

## 3\. Зависимости Задачи

- **`decimal.js` (1.2)**
- **`ExchangeRulesService` (3.2):** Внедряется (DI) для будущих задач (6.4, 6.6).
- **`LoggingService` (1.4)**
- **`ValidationError` (Новый класс)**
- **Типы:** `LLMDecision`, `AccountState`, `MarketData`.

## 4\. Описание и Нюансы Реализации Логики

### 4.1. Создание `ValidationError`

- Создать класс `ValidationError` с конструктором `constructor(message: string, isHold: boolean = false)`.
- Этот класс _обязан_ бросаться, если приказ невалиден.
- Если `action: HOLD` (или `decisions` — пустой массив), _обязан_ бросаться `ValidationError` с `isHold: true`.

### 4.2. Приватный метод `toDecimal`

- **Цель:** Вспомогательный метод для преобразования значений в `DecimalValue`.
- **Логика:**
  - Если значение `null` или `undefined`, вернуть `new Decimal(0)`.
  - Если значение уже является `DecimalValue` (проверка на наличие поля `e`), вернуть его как есть.
  - Иначе преобразовать в строку и создать `new Decimal(String(value))`.

### 4.3. Реализация `_validateSanityAndLogicChecks` (УРОВЕНЬ 1)

Этот приватный метод выполняет проверки Разделов 1 и 2 из `about.md`.

#### 4.2.1. Проверки "Здравого Смысла" (Sanity Checks)

1.  **Обязательные поля:** Проверить наличие `decision.pair` и `decision.action`. Если отсутствует, бросить `ValidationError` с информативным сообщением.
2.  **HOLD:** Если `decision.action === 'HOLD'`, бросить `ValidationError` с флагом `isHold: true` и сообщением "HOLD action detected".
3.  **Тип Ордера и SL (Критично):**
    - Для **`OPEN_LONG`** и **`OPEN_SHORT`**: _обязан_ проверить наличие `params.type` и что он равен `'market'` или `'limit'`. Если нет, бросить `ValidationError`.
    - Для **`type: 'limit'`**: _обязан_ проверить, что `params.price !== null && params.price !== undefined`. Если нет, бросить `ValidationError`.
    - Для **`OPEN_LONG/SHORT`**: _обязан_ проверить наличие `params.stop_loss_price` (не `null` и не `undefined`). Если нет, бросить `ValidationError`.

4.  **Trailing Stop (Нюанс):** Если LLM указала `params.trailing_stop_config` (не `null`), но не указала `params.stop_loss_price` (который нужен как _начальный_ стоп), _обязан_ бросить `ValidationError` с сообщением "trailing_stop_config requires stop_loss_price as initial stop".
5.  **MODIFY_POSITION:** _обязан_ проверить, что есть хотя бы один параметр модификации: `params.new_stop_loss_price`, `params.new_take_profit_price` или `params.new_trailing_stop_config`. Если нет ни одного, бросить `ValidationError`.
6.  **CLOSE_POSITION:** _обязан_ проверить, что `params.amount_percent` существует (`!== null && !== undefined`). Если нет, бросить `ValidationError`. Использовать `toDecimal()` для преобразования и проверить диапазон `(0, 100]` через `amountPercent.lte(zero) || amountPercent.gt(hundred)`. Если `params.type === 'limit'`, проверить наличие `params.price`. Примечание: проверка наличия позиции в `accountState.open_positions` выполняется в главном методе `validateDecision` перед вызовом `_validateSanityAndLogicChecks`.

#### 4.3.2. Расчет `entryPrice`

- **Расчет:** `entryPrice` _обязан_ быть установлен следующим образом:
  - Для **`OPEN_LONG`** и **`OPEN_SHORT`**: Если `params.type === 'limit'` и `params.price !== null && params.price !== undefined`, использовать `toDecimal(params.price)`. Иначе использовать `toDecimal(marketData.current_price)`.
  - Для **`MODIFY_POSITION`**: Использовать `toDecimal(marketData.current_price)` (не используется для SL/TP проверок напрямую).
  - Для **`CLOSE_POSITION`** и других действий: Если `params.type === 'limit'` и `params.price !== null && params.price !== undefined`, использовать `toDecimal(params.price)`. Иначе использовать `toDecimal(marketData.current_price)`.

#### 4.3.3. Проверки Логики SL/TP

**Критично:** Все проверки должны использовать `Decimal` для сравнения `slPrice`, `tpPrice` и `entryPrice`. Использовать приватный метод `toDecimal()` для преобразования всех значений.

1.  **`OPEN_LONG`:**
    - Преобразовать `params.stop_loss_price` в `Decimal` через `toDecimal()`.
    - Проверка SL: `slPrice` _обязан_ быть строго меньше (`.lt()`) `entryPrice`. Если нет, бросить `ValidationError` с информативным сообщением.
    - Проверка TP (если `params.take_profit_price !== null && !== undefined`): Преобразовать в `Decimal` и проверить, что `tpPrice` строго больше (`.gt()`) `entryPrice`. Если нет, бросить `ValidationError`.
    - Нюанс (Limit): Если `params.type === 'limit'` и `params.price !== null && !== undefined`, проверить, что `limitPrice.gt(currentPrice)`. Если да, залогировать `warn` с сообщением о том, что ордер исполнится как Market, но **не** бросать ошибку.

2.  **`OPEN_SHORT`:**
    - Преобразовать `params.stop_loss_price` в `Decimal` через `toDecimal()`.
    - Проверка SL: `slPrice` _обязан_ быть строго больше (`.gt()`) `entryPrice`. Если нет, бросить `ValidationError` с информативным сообщением.
    - Проверка TP (если `params.take_profit_price !== null && !== undefined`): Преобразовать в `Decimal` и проверить, что `tpPrice` строго меньше (`.lt()`) `entryPrice`. Если нет, бросить `ValidationError`.
    - Нюанс (Limit): Если `params.type === 'limit'` и `params.price !== null && !== undefined`, проверить, что `limitPrice.lt(currentPrice)`. Если да, залогировать `warn` с сообщением о том, что ордер исполнится как Market, но **не** бросать ошибку.

3.  **`MODIFY_POSITION`:** Базовая проверка наличия параметров модификации уже выполнена в разделе 4.2.1. Детальная проверка SL/TP для MODIFY будет реализована в будущих задачах.

## 5\. Критерии Приемки (Acceptance Criteria)

1.  CustomError

    Создан класс `ValidationError` с обязательным свойством `isHold: boolean`.

2.  ServiceSkeleton

    Создан `ValidatorService.ts` (Singleton) с методом `getInstance(exchangeRulesService)`, корректно внедряющий `LoggingService` и `ExchangeRulesService`.

3.  Logic(Accuracy)

    **Все** сравнения цен и расчет `entryPrice` _обязаны_ использовать `Decimal` и его методы (`.greaterThan()`, `.lessThanOrEqualTo()`, и т.д.).

4.  Logic(SL/TP)

    Проверки SL/TP для `LONG` и `SHORT` (Раздел 2) _корректно_ реализованы с броском `ValidationError` при нарушении.

5.  Logic(CLOSEP​OSITION)

    _обязан_ включать проверку `amount_percent` (диапазон `(0, 100]`) и проверку наличия закрываемой позиции в `accountState.open_positions`.

6.  Logic(HOLD)

    При `action: HOLD` _обязан_ бросаться `ValidationError` с `isHold: true`.

7.  Logic(LimitWarning)

    Реализована логика, которая логирует `WARN`, если `Limit` ордер будет исполнен как `Market` (Taker), но при этом _не_ прерывает валидацию.

8.  ReturnValue

    Метод _обязан_ успешно возвращать объект типа `SanityCheckResult` с полем `entryPrice: DecimalValue`.

9.  ClosePositionCheck

    Проверка наличия позиции для `CLOSE_POSITION` выполняется в главном методе `validateDecision` перед вызовом `_validateSanityAndLogicChecks` через проверку `accountState.open_positions.some((pos) => pos.pair === decision.pair)`.

10. ToDecimal

    Реализован приватный метод `toDecimal(value)` для преобразования значений в `DecimalValue` с обработкой `null`/`undefined` и проверкой типа.
