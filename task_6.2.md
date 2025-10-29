# Техническое Задание (ТЗ): 6.2 Расчет Размера Позиции (Position Sizing Logic)

**Эпик:** 6. 🛡️ "Валидатор" (Validator Service) **Задача:** 6.2 Расчет Размера Позиции (Position Sizing Logic) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Реализовать **Уровень 2** проверок в `ValidatorService`. Этот уровень отвечает за расчет **"сырого" (raw, неокругленного)** размера позиции на основе "Volatility-Based Position Sizing" (Раздел 3 "Техзадания 2.1" в `about.md`).

Этот расчет определяет, _сколько_ актива мы можем купить, чтобы наш максимальный убыток (при срабатывании `stop_loss_price`) не превысил `risk_percent_to_use` от общего портфеля.

## 2\. Зависимости Задачи

- **`ValidatorService.ts` (6.1):** (Модифицируемый) Файл, в который добавляется новая логика.
- **`decimal.js` (1.2):** (Критическая Зависимость) Используется для **всех** финансовых расчетов.
- **`src/interfaces/types.ts`:** (Модифицируемый) Файл, содержащий интерфейс `CalculatedAmounts`, который будет обновлен.
- **Типы:** `LLMDecision`, `AccountState`, `RiskRules`.

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
    - Если `decision.parameters.risk_percent` указан LLM, использовать его.
    - Если _не_ указан, использовать `riskRules.default_risk_per_trade_percent`.
    - Оба значения _обязаны_ быть преобразованы в `Decimal`.

2.  **Проверка Лимита Риска:** _обязан_ проверить, что выбранный `% риска` **не превышает** `riskRules.max_allowed_risk_per_trade_percent`. Если превышает, _обязан_ бросить `ValidationError`.
3.  **Расчет USD@Risk:** _обязан_ рассчитать **`usdAtRisk`** по формуле: `AccountState.total_portfolio_value_usdt * (RiskPercent / 100)`.

#### 3.2.2. Расчет Размера Позиции (Volatility Sizing)

1.  **Дистанция до Стопа:** _обязан_ рассчитать **`distanceToStop`** (в USD) по формуле: `|entryPrice - stopPrice|`.
    - _Критично:_ Если `distanceToStop` равна нулю (цены идентичны), _обязан_ бросить `ValidationError`.

2.  **"Сырое" Количество Монеты:** _обязан_ рассчитать **`rawAmountCoin`** по формуле: `usdAtRisk / distanceToStop`.
3.  **"Сырая" Стоимость:** _обязан_ рассчитать **`rawAmountUsd`** по формуле: `rawAmountCoin * entryPrice`.

#### 3.2.3. Возврат

- Метод _обязан_ вернуть объект, содержащий **`rawAmountCoin`**, **`rawAmountUsd`**, и **`usdAtRisk`** (все значения типа `Decimal`).

### 3.3. Обновление `validateAndCalculate`

- Главный метод _обязан_ вызвать `_calculatePositionSizing` и сохранить возвращенные `raw` значения.
- Если `action` не является `OPEN_...`, метод _обязан_ пропустить этот шаг и вернуть `CalculatedAmounts` с нулевыми `Decimal` значениями.
- Метод _обязан_ вернуть этот объект для передачи его на **Уровень 3** (Задача 6.3).

## 4\. Критерии Приемки (Acceptance Criteria)

1.  Interface

    Файл `src/interfaces/types.ts` обновлен: `CalculatedAmounts` теперь содержит `rawAmountCoin` и `rawAmountUsd` и _не_ содержит `roundedAmountCoin`, `roundedAmountUsd`.

2.  Service

    В `ValidatorService.ts` добавлен новый приватный метод `_calculatePositionSizing`.

3.  Logic(Accuracy)

    `_calculatePositionSizing` выполняет **все** финансовые расчеты (включая проверку `max_allowed_risk_per_trade_percent` и `distanceToStop`) с использованием **`decimal.js`**.

4.  Logic(DefaultRisk)

    `_calculatePositionSizing` _корректно_ использует `riskRules.default_risk_per_trade_percent`, если LLM не указала риск.

5.  Logic(ZeroDistance)

    `_calculatePositionSizing` _обязан_ бросить `ValidationError`, если `entryPrice` и `stopPrice` идентичны (`distanceToStop.isZero()`).

6.  ServiceIntegration

    `validateAndCalculate` (главный метод) теперь вызывает `_calculatePositionSizing` (после Уровня 1) для `OPEN_LONG` / `OPEN_SHORT`.

7.  ReturnValue

    `validateAndCalculate` _обязан_ вернуть объект `CalculatedAmounts`, содержащий **`rawAmountCoin`**, **`rawAmountUsd`**, и **`usdAtRisk`** (все типа `Decimal`).
