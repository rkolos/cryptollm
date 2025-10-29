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

### 4.2. Реализация `_validateSanityAndLogicChecks` (УРОВЕНЬ 1)

Этот приватный метод выполняет проверки Разделов 1 и 2 из `about.md`.

#### 4.2.1. Проверки "Здравого Смысла" (Sanity Checks)

1.  **Обязательные поля:** Проверить наличие `pair` и `action`. Если отсутствует, бросить ошибку.
2.  **HOLD:** Если `action === 'HOLD'` или `decisions` — пустой массив, бросить `ValidationError` с флагом `isHold: true`.
3.  **Тип Ордера и SL (Критично):**
    - Для **`OPEN_LONG`** и **`OPEN_SHORT`**: _обязан_ проверить наличие `type: 'market'/'limit'`.
    - Для **`type: 'limit'`**: _обязан_ проверить наличие `price`.
    - Для **`OPEN_LONG/SHORT`** и **`MODIFY_POSITION`**: _обязан_ проверить наличие `stop_loss_price` (или `new_stop_loss_price`).

4.  **Trailing Stop (Нюанс):** Если LLM указала `trailing_stop_config`, но не указала `stop_loss_price` (который нужен как _начальный_ стоп), _обязан_ бросить ошибку.
5.  **CLOSE_POSITION:** _обязан_ проверить, что `amount_percent` существует и находится в диапазоне `(0, 100]` (включительно). _обязан_ бросить ошибку, если позиция, которую LLM пытается закрыть, _не найдена_ в `accountState.open_positions` (см. `about.md` Раздел 2.1).

#### 4.2.2. Расчет `entryPrice`

- **Расчет:** `entryPrice` _обязан_ быть установлен как `parameters.price` (если `limit`) или `marketData.current_price` (если `market`). Оба значения _обязаны_ быть преобразованы в `Decimal` (либо из `marketData` и `parameters`, либо из `new_stop_loss_price` для `MODIFY`).

#### 4.2.3. Проверки Логики SL/TP

**Критично:** Все проверки должны использовать `Decimal` для сравнения `slPrice`, `tpPrice` и `entryPrice`.

1.  **`OPEN_LONG` (или `MODIFY_POSITION` Long):**
    - Проверка SL: `slPrice` _обязан_ быть строго меньше (`.lessThan()`) `entryPrice`.
    - Проверка TP (если есть): `tpPrice` _обязан_ быть строго больше (`.greaterThan()`) `entryPrice`.
    - Нюанс (Limit): Если `Limit Buy Price` (`entryPrice`) **больше** (`.greaterThan()`) `Current Price`, _обязан_ залогировать `WARN` (т.к. ордер исполнится как Market), но **не** бросать ошибку.

2.  **`OPEN_SHORT` (или `MODIFY_POSITION` Short):**
    - Проверка SL: `slPrice` _обязан_ быть строго больше (`.greaterThan()`) `entryPrice`.
    - Проверка TP (если есть): `tpPrice` _обязан_ быть строго меньше (`.lessThan()`) `entryPrice`.
    - Нюанс (Limit): Если `Limit Sell Price` (`entryPrice`) **меньше** (`.lessThan()`) `Current Price`, _обязан_ залогировать `WARN` (т.к. ордер исполнится как Market), но **не** бросать ошибку.

## 5\. Критерии Приемки (Acceptance Criteria)

1.  CustomError

    Создан класс `ValidationError` с обязательным свойством `isHold: boolean`.

2.  ServiceSkeleton

    Создан `ValidatorService.ts` (Singleton), корректно внедряющий `LoggingService` и `ExchangeRulesService`.

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

    Метод _обязан_ успешно возвращать объект с рассчитанной ценой входа (`entryPrice: Decimal`).
