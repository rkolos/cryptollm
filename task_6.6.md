# Техническое Задание (ТЗ): 6.6 Валидация и Округление Точности (Precision Handling)

**Эпик:** 6. 🛡️ "Валидатор" (Validator Service) **Задача:** 6.6 Валидация и Округление Точности **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Реализовать **первую часть Уровня 4** проверок в `ValidatorService`. Эта задача отвечает за округление "сырых" (raw) значений, рассчитанных в Уровне 2, до точных спецификаций (`precision.amount`, `precision.price`), требуемых биржей.

Мы также повторно рассчитаем стоимость ордера (`roundedAmountUsd`) на основе этих _новых_, округленных значений.

## 2\. Зависимости Задачи

- **`ValidatorService.ts` (6.3):** (Модифицируемый) Файл, в который добавляется новая логика.
- **`ExchangeRulesService` (3.2):** (Зависимость) Используется для получения правил `precision` через `getRules(pair).precision`.
- **`decimal.js` (1.2):** (Зависимость) Используется для всех расчетов и округления.
- **`src/interfaces/IValidatorTypes.ts`:** (Модифицируемый) Файл, в который мы _возвращаем_ округленные значения.

## 3\. Описание и Нюансы Реализации

### 3.1. Модификация `src/interfaces/IValidatorTypes.ts`

Мы обновляем `CalculatedAmounts`, чтобы он содержал _и_ сырые, _и_ округленные значения. Округленные пойдут в `Worker` (Исполнитель), а сырые (`usdAtRisk`) — в следующие шаги валидации (6.4, 6.5).

    // src/interfaces/types.ts (Модификация)

    // ... (импорты)
    import { Decimal } from 'decimal.js';

    // ... (другие типы)

    export interface CalculatedAmounts {
        // "Сырые" (неокругленные) значения (из 6.2)
        rawAmountCoin: Decimal;
        rawAmountUsd: Decimal;

        // (Новые) Округленные значения (из 6.6)
        roundedAmountCoin: Decimal;
        roundedAmountUsd: Decimal;
        roundedEntryPrice: Decimal; // (Округленная цена входа)

        // (Существующие)
        usdAtRisk: Decimal;
        entryPrice: Decimal; // (Неокругленная цена входа)
    }

### 3.2. Модификация `src/services/ValidatorService.ts`

Мы добавляем импорт `ccxt`, новый приватный метод `_validateAndRoundPrecision` и интегрируем его в `validateAndCalculate`.

    // src/services/ValidatorService.ts (Дополнения)

    import { Decimal } from 'decimal.js';
    import ccxt from 'ccxt'; // (НОВЫЙ ИМПОРТ)
    import { LLMDecision, AccountState, MarketData, RiskRules, CalculatedAmounts } from '../interfaces';
    import { ExchangeRulesService } from './ExchangeRulesService';
    import { LoggingService } from './LoggingService';
    import { ValidationError } from '../errors/ValidationError';

    export class ValidatorService {
        // ... (instance, logger, exchangeRules, constructor, getInstance из 6.1)

        public validateDecision(
            decision: LLMDecision,
            accountState: AccountState,
            strategyContext: StrategyContext,
            marketData: MarketData,
            _exchangeRules: IMarketRules
        ): CalculatedAmounts {

            this.logger.debug(`[${decision.pair}] Запуск валидации для action: ${decision.action}...`);

            // === УРОВЕНЬ 1 (Реализован в 6.1) ===
            const { entryPrice } = this._validateSanityAndLogicChecks(decision, marketData);

            if (decision.action !== 'OPEN_LONG' && decision.action !== 'OPEN_SHORT') {
                // ... (возврат пустых значений, как в 6.3)
                return {
                    rawAmountCoin: new Decimal(0), rawAmountUsd: new Decimal(0),
                    roundedAmountCoin: new Decimal(0), roundedAmountUsd: new Decimal(0),
                    roundedEntryPrice: new Decimal(0),
                    usdAtRisk: new Decimal(0),
                    entryPrice: entryPrice || new Decimal(0)
                };
            }

            // === УРОВЕНЬ 2 (Реализован в 6.2) ===
            const calculatedAmounts = this._calculatePositionSizing(
                decision, accountState, strategyContext, entryPrice
            );
            const { rawAmountCoin, rawAmountUsd, usdAtRisk } = calculatedAmounts;

            // === УРОВЕНЬ 3 (Реализован в 6.3) ===
            this._validatePortfolioRisk(usdAtRisk, accountState, strategyContext);

            // === УРОВЕНЬ 4 (Часть 1 - Эта Задача: 6.6) ===
            const { roundedAmountCoin, roundedAmountUsd, roundedEntryPrice } = this._validateAndRoundPrecision(
                decision.pair,
                rawAmountCoin,
                entryPrice // (Неокругленная цена входа)
            );

            // === УРОВЕНЬ 4 (Часть 2 - Задачи 6.4, 6.5) ===
            // this._validateExchangeRules(
            //     decision.pair, roundedAmountUsd, usdAtRisk
            // );

            this.logger.info(`[${decision.pair}] Валидация Уровня 4 (Precision) пройдена.`);

            // (Обновлено) Возвращаем ВСЕ рассчитанные значения
            return {
                rawAmountCoin, rawAmountUsd,
                roundedAmountCoin, roundedAmountUsd, roundedEntryPrice,
                usdAtRisk,
                entryPrice
            };
        }

        // --- (Реализован в 6.1) ---
        // private _validateSanityAndLogicChecks(...) { ... }

        // --- (Реализован в 6.2) ---
        // private _calculatePositionSizing(...) { ... }

        // --- (Реализован в 6.3) ---
        // private _validatePortfolioRisk(...) { ... }

        // --- Реализация Уровня 4 (Часть 1 - Эта Задача) ---

        /**
         * УРОВЕНЬ 4 (Часть 1): Округляет 'сырые' значения до точности,
         * требуемой биржей, и пересчитывает 'amount_usd'.
         * @throws {ValidationError}
         */
        private _validateAndRoundPrecision(
            pair: string,
            rawAmountCoin: Decimal,
            rawEntryPrice: Decimal // (Неокругленная цена входа из Уровня 1)
        ): { roundedAmountCoin: Decimal; roundedAmountUsd: Decimal; roundedEntryPrice: Decimal } {

            const precision = this.exchangeRules.getPrecision(pair);
            if (!precision) {
                this.logger.error(`[${pair}] НЕ УДАЛОСЬ получить правила точности (precision).`);
                throw new ValidationError(`[${pair}] Критическая ошибка: Отсутствуют правила точности (precision)`);
            }

            // 1. Округляем 'amount' (количество монеты) используя precision.amount
            // Вычисляем множитель на основе precision (например, 0.00000001 -> множитель 10^8)
            // precision.e отрицательное для малых чисел (например, -8 для 0.00000001), поэтому берем abs
            const amountPrecisionDecimal = precision.amount as any;
            const amountPrecisionE = amountPrecisionDecimal.e !== undefined ? Math.abs(amountPrecisionDecimal.e) : 0;
            const amountMultiplier = new DecimalConstructor(10).pow(amountPrecisionE);
            // Округляем вниз до нужной точности
            const rawAmountCoinDecimal = rawAmountCoin as any;
            const roundedAmountCoin = rawAmountCoinDecimal.mul(amountMultiplier).floor().div(amountMultiplier) as DecimalValue;

            // 2. Округляем 'price' (цену входа) используя precision.price
            // Вычисляем множитель на основе precision (например, 0.01 -> множитель 10^2)
            // precision.e отрицательное для малых чисел (например, -2 для 0.01), поэтому берем abs
            const pricePrecisionDecimal = precision.price as any;
            const pricePrecisionE = pricePrecisionDecimal.e !== undefined ? Math.abs(pricePrecisionDecimal.e) : 0;
            const priceMultiplier = new DecimalConstructor(10).pow(pricePrecisionE);
            // Округляем вниз до нужной точности
            const rawEntryPriceDecimal = rawEntryPrice as any;
            const roundedEntryPrice = rawEntryPriceDecimal.mul(priceMultiplier).floor().div(priceMultiplier) as DecimalValue;

            // 3. (Критично) Пересчитываем 'amount_usd' на основе ОКРУГЛЕННЫХ значений
            // rounded_amount_usd = rounded_amount_coin * rounded_entry_price
            const roundedAmountCoinDecimal = roundedAmountCoin as any;
            const roundedEntryPriceDecimal = roundedEntryPrice as any;
            const roundedAmountUsd = roundedAmountCoinDecimal.mul(roundedEntryPriceDecimal) as DecimalValue;

            this.logger.debug(
                `[${pair}] Округление: Qty ${rawAmountCoinDecimal.toFixed(12)} -> ${roundedAmountCoinDecimal.toString()}`,
            );
            this.logger.debug(
                `[${pair}] Округление: Price ${rawEntryPriceDecimal.toFixed(5)} -> ${roundedEntryPriceDecimal.toString()}`,
            );
            const rawAmountUsdDecimal = rawAmountCoinDecimal.mul(rawEntryPriceDecimal) as any;
            const roundedAmountUsdDecimal = roundedAmountUsd as any;
            this.logger.debug(
                `[${pair}] Округление: USD Value ${rawAmountUsdDecimal.toFixed(5)} -> ${roundedAmountUsdDecimal.toFixed(5)}`,
            );

            // Проверка нулевых значений после округления
            const zero = new DecimalConstructor(0);
            if (
                roundedAmountCoinDecimal.isZero() ||
                roundedAmountCoinDecimal.eq(zero) ||
                roundedAmountUsdDecimal.isZero() ||
                roundedAmountUsdDecimal.eq(zero)
            ) {
                throw new ValidationError(
                    `[${pair}] После округления размер позиции стал 0. Увеличьте риск или дистанцию до стопа.`,
                );
            }

            return { roundedAmountCoin, roundedAmountUsd, roundedEntryPrice };
        }

        // (Заглушки для будущих Задач 6.4, 6.5)
    }

## 4\. Критерии Приемки (Acceptance Criteria)

1.  **\[Interface\]** `src/interfaces/IValidatorTypes.ts` обновлен: `CalculatedAmounts` теперь содержит `roundedAmountCoin`, `roundedAmountUsd` и `roundedEntryPrice` (типа `DecimalValue`).
2.  **\[Service\]** В `ValidatorService.ts` добавлен новый приватный метод `_validateAndRoundPrecision(pair, rawAmountCoin, rawEntryPrice)`.
3.  **\[Logic (Критично)\]** `_validateAndRoundPrecision` вызывает `this.exchangeRulesService.getRules(pair).precision` и бросает `ValidationError`, если precision не найден.
4.  **\[Logic\]** `_validateAndRoundPrecision` округляет `rawAmountCoin` до `precision.amount` используя вычисление множителя `10^abs(precision.amount.e)` и метод `.floor()` для округления вниз: `rawAmountCoin.mul(amountMultiplier).floor().div(amountMultiplier)`.
5.  **\[Logic\]** `_validateAndRoundPrecision` округляет `rawEntryPrice` до `precision.price` используя вычисление множителя `10^abs(precision.price.e)` и метод `.floor()` для округления вниз: `rawEntryPrice.mul(priceMultiplier).floor().div(priceMultiplier)`.
6.  **\[Logic (Критично)\]** `_validateAndRoundPrecision` **повторно рассчитывает** `roundedAmountUsd`, используя формулу `roundedAmountCoin.mul(roundedEntryPrice)`.
7.  **\[Logic\]** `_validateAndRoundPrecision` логирует `debug` сообщения с детальной информацией об округлении (Qty, Price, USD Value).
8.  **\[Logic\]** `_validateAndRoundPrecision` бросает `ValidationError`, если `roundedAmountCoin` или `roundedAmountUsd` стали равны 0 после округления (проверка через `.isZero()` или `.eq(zero)`).
9.  **\[Service\]** `validateDecision` (главный метод) теперь вызывает `_validateAndRoundPrecision(decision.pair, rawAmountCoin, entryPrice)` (после Уровня 3) и возвращает _все_ рассчитанные значения (raw, rounded, risk) в объекте `CalculatedAmounts`.
