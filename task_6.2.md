# Техническое Задание (ТЗ): 6.2 Расчет Размера Позиции (Position Sizing Logic)

**Эпик:** 6. 🛡️ "Валидатор" (Validator Service) **Задача:** 6.2 Расчет Размера Позиции (Position Sizing Logic) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Реализовать **Уровень 2** проверок в `ValidatorService`. Этот уровень отвечает за расчет **"сырого" (raw, неокругленного)** размера позиции на основе "Volatility-Based Position Sizing" (Раздел 3 "Техзадания 2.1" в `about.md`).

Этот расчет определяет, _сколько_ актива мы можем купить, чтобы наш максимальный убыток (при срабатывании `stop_loss_price`) не превысил `risk_percent_to_use` от общего портфеля.

## 2\. Зависимости Задачи

- **`ValidatorService.ts` (6.1):** (Модифицируемый) Файл, в который добавляется новая логика.
- **`decimal.js` (1.2):** (Критическая Зависимость) Используется для **всех** финансовых расчетов.
- **`src/interfaces/IValidatorTypes.ts`:** (Модифицируемый) Файл, содержащий интерфейс `CalculatedAmounts`, который будет обновлен.
- **Типы:** `LLMDecision`, `AccountState`, `StrategyContext` (вместо `RiskRules`).

## 3\. Описание и Нюансы Реализации

### 3.1. Модификация `src/interfaces/types.ts`

Интерфейс `CalculatedAmounts` (возвращаемый `ValidatorService.validateAndCalculate`) должен быть обновлен. На этом этапе он возвращает _сырые_ (неокругленные) значения. Округление (`rounded...`) будет добавлено в Задаче 6.6.

#### 3.1.1. Изменения в `CalculatedAmounts`

1.  Удалить все временные поля `roundedAmountCoin` и `roundedAmountUsd`, которые были в заглушке из Задачи 6.1.
2.  Добавить поля `rawAmountCoin` и `rawAmountUsd` (типа `Decimal`).

### 3.2. Реализация `_calculatePositionSizing` (УРОВЕНЬ 2)

Этот приватный метод _обязан_ быть вызван в `validateAndCalculate` только для `OPEN_LONG` и `OPEN_SHORT`.

#### 3.2.1. Логика Расчета Риска

1.  **Определение % Риска:** _обязан_ получить процент риска:
    - Извлечь `riskRules = strategyContext.risk_rules`.
    - Если `decision.parameters.risk_percent !== null && !== undefined`, использовать `toDecimal(decision.parameters.risk_percent)`.
    - Если _не_ указан, использовать `toDecimal(riskRules.default_risk_per_trade_percent)`.

2.  **Проверка Лимита Риска:** _обязан_ проверить, что выбранный `% риска` **не превышает** `riskRules.max_allowed_risk_per_trade_percent` через `riskPercent.gt(maxAllowed)`. Если превышает, _обязан_ бросить `ValidationError` с информативным сообщением.
3.  **Расчет USD@Risk:** _обязан_ рассчитать **`usdAtRisk`** по формуле: `total_portfolio_value_usdt.mul(riskPercent).div(100)` используя `Decimal` методы. Использовать `toDecimal()` для преобразования `accountState.total_portfolio_value_usdt`.

#### 3.2.2. Расчет Размера Позиции (Volatility Sizing)

1.  **Дистанция до Стопа:** Преобразовать `decision.parameters.stop_loss_price` в `Decimal` через `toDecimal()`. Рассчитать **`distanceToStop`** (в USD) по формуле: `entryPrice.sub(stopPrice).abs()` используя `Decimal` методы.
    - _Критично:_ Если `distanceToStop.isZero()` или `distanceToStop.eq(zero)`, _обязан_ бросить `ValidationError` с сообщением "Entry price and Stop Loss price are identical".

2.  **"Сырое" Количество Монеты:** _обязан_ рассчитать **`rawAmountCoin`** по формуле: `usdAtRisk.div(distanceToStop)` используя `Decimal` методы.
3.  **"Сырая" Стоимость:** _обязан_ рассчитать **`rawAmountUsd`** по формуле: `rawAmountCoin.mul(entryPrice)` используя `Decimal` методы.

#### 3.2.3. Возврат

- Метод _обязан_ вернуть объект, содержащий **`rawAmountCoin`**, **`rawAmountUsd`**, и **`usdAtRisk`** (все значения типа `Decimal`).

### 3.3. Обновление `validateDecision`

- Главный метод называется `validateDecision` (не `validateAndCalculate`).
- Метод _обязан_ вызвать `_calculatePositionSizing(decision, accountState, strategyContext, entryPrice)` и сохранить возвращенные `raw` значения.
- Метод `_calculatePositionSizing` принимает `strategyContext` вместо `riskRules`.
- Если `action` не является `OPEN_LONG` или `OPEN_SHORT`, метод _обязан_ пропустить этот шаг и вернуть `CalculatedAmounts` с нулевыми `Decimal` значениями (через `toDecimal(0)`).
- Метод _обязан_ вернуть этот объект для передачи его на **Уровень 3** (Задача 6.3).

## 4\. Критерии Приемки (Acceptance Criteria)

1.  Interface

    Файл `src/interfaces/IValidatorTypes.ts` обновлен: `CalculatedAmounts` теперь содержит `rawAmountCoin` и `rawAmountUsd` (типа `DecimalValue`).

2.  Service

    В `ValidatorService.ts` добавлен новый приватный метод `_calculatePositionSizing`.

3.  Logic(Accuracy)

    `_calculatePositionSizing` выполняет **все** финансовые расчеты (включая проверку `max_allowed_risk_per_trade_percent` и `distanceToStop`) с использованием **`decimal.js`**.

4.  Logic(DefaultRisk)

    `_calculatePositionSizing` _корректно_ использует `strategyContext.risk_rules.default_risk_per_trade_percent`, если LLM не указала риск (через `toDecimal()`).

5.  Logic(ZeroDistance)

    `_calculatePositionSizing` _обязан_ бросить `ValidationError`, если `entryPrice` и `stopPrice` идентичны (`distanceToStop.isZero()`).

6.  ServiceIntegration

    `validateDecision` (главный метод) теперь вызывает `_calculatePositionSizing(decision, accountState, strategyContext, entryPrice)` (после Уровня 1) для `OPEN_LONG` / `OPEN_SHORT`.

7.  ReturnValue

    `validateDecision` _обязан_ вернуть объект `CalculatedAmounts`, содержащий **`rawAmountCoin`**, **`rawAmountUsd`**, **`usdAtRisk`**, **`entryPrice`**, и временно **`roundedAmountCoin`**, **`roundedAmountUsd`**, **`roundedEntryPrice`** (все типа `DecimalValue`).

8.  ToDecimal

    Метод `_calculatePositionSizing` использует приватный метод `toDecimal()` для преобразования всех значений в `DecimalValue`.
