# Техническое Задание (ТЗ): 6.6 Валидация и Округление Точности (Precision Handling)

**Эпик:** 6. 🛡️ "Валидатор" (Validator Service) **Задача:** 6.6 Валидация и Округление Точности **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Реализовать **первую часть Уровня 4** проверок в `ValidatorService`. Эта задача отвечает за округление "сырых" (raw) значений, рассчитанных в Уровне 2, до точных спецификаций (`precision.amount`, `precision.price`), требуемых биржей.

Мы также повторно рассчитаем стоимость ордера (`roundedAmountUsd`) на основе этих _новых_, округленных значений.

## 2\. Зависимости Задачи

- **`ValidatorService.ts` (6.3):** (Модифицируемый) Файл, в который добавляется новая логика.
- **`ExchangeRulesService` (3.2):** (Зависимость) Используется для получения правил `precision`.
- **`ccxt` (1.2):** (Зависимость) Используется для импорта статических функций `amountToPrecision` и `priceToPrecision`.
- **`decimal.js` (1.2):** (Зависимость)
- **`src/interfaces/types.ts`:** (Модифицируемый) Файл, в который мы _возвращаем_ округленные значения.

## 3\. Описание и Нюансы Реализации

### 3.1. Модификация `src/interfaces/types.ts`

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

        public validateAndCalculate(
            decision: LLMDecision,
            accountState: AccountState,
            marketData: MarketData,
            riskRules: RiskRules
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
            const { rawAmountCoin, rawAmountUsd, usdAtRisk } = this._calculatePositionSizing(
                decision, entryPrice, accountState, riskRules
            );

            // === УРОВЕНЬ 3 (Реализован в 6.3) ===
            this._validatePortfolioRisk(usdAtRisk, accountState, riskRules);

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

            // 1. Округляем 'amount' (количество монеты)
            // (Используем ccxt.amountToPrecision, который возвращает string)
            const roundedAmountStr = ccxt.amountToPrecision(
                pair,
                rawAmountCoin.toNumber(), // (Конвертируем Decimal в number для ccxt)
                precision.amount
            );
            const roundedAmountCoin = new Decimal(roundedAmountStr);

            // 2. Округляем 'price' (цену входа)
            const roundedPriceStr = ccxt.priceToPrecision(
                pair,
                rawEntryPrice.toNumber(),
                precision.price
            );
            const roundedEntryPrice = new Decimal(roundedPriceStr);

            // 3. (Критично) Пересчитываем 'amount_usd' на основе ОКРУГЛЕННЫХ значений
            // rounded_amount_usd = rounded_amount_coin * rounded_price
            const roundedAmountUsd = roundedAmountCoin.times(roundedEntryPrice);

            this.logger.debug(`[${pair}] Округление: Qty ${rawAmountCoin.toFixed(12)} -> ${roundedAmountCoin.toString()}`);
            this.logger.debug(`[${pair}] Округление: Price ${rawEntryPrice.toFixed(5)} -> ${roundedEntryPrice.toString()}`);
            this.logger.debug(`[${pair}] Округление: USD Value ${rawAmountCoin.times(rawEntryPrice).toFixed(5)} -> ${roundedAmountUsd.toFixed(5)}`);

            if (roundedAmountCoin.isZero() || roundedAmountUsd.isZero()) {
                throw new ValidationError(`[${pair}] После округления размер позиции стал 0. Увеличьте риск или дистанцию до стопа.`);
            }

            return { roundedAmountCoin, roundedAmountUsd, roundedEntryPrice };
        }

        // (Заглушки для будущих Задач 6.4, 6.5)
    }

## 4\. Критерии Приемки (Acceptance Criteria)

1.  **\[Interface\]** `src/interfaces/types.ts` обновлен: `CalculatedAmounts` теперь содержит `roundedAmountCoin`, `roundedAmountUsd` и `roundedEntryPrice`.
2.  **\[Service\]** В `ValidatorService.ts` добавлен импорт `ccxt`.
3.  **\[Service\]** В `ValidatorService.ts` добавлен новый приватный метод `_validateAndRoundPrecision`.
4.  **\[Logic (Критично)\]** `_validateAndRoundPrecision` вызывает `this.exchangeRules.getPrecision(pair)` и бросает `ValidationError`, если правила не найдены.
5.  **\[Logic\]** `_validateAndRoundPrecision` использует `ccxt.amountToPrecision` для округления `rawAmountCoin` до `precision.amount`.
6.  **\[Logic\]** `_validateAndRoundPrecision` использует `ccxt.priceToPrecision` для округления `rawEntryPrice` до `precision.price`.
7.  **\[Logic (Критично)\]** `_validateAndRoundPrecision` **повторно рассчитывает** `roundedAmountUsd`, используя формулу `roundedAmountCoin.times(roundedEntryPrice)`.
8.  **\[Logic\]** `_validateAndRoundPrecision` бросает `ValidationError`, если `roundedAmountCoin` или `roundedAmountUsd` стали равны 0 после округления.
9.  **\[Service\]** `validateAndCalculate` (главный метод) теперь вызывает `_validateAndRoundPrecision` (после Уровня 3) и возвращает _все_ рассчитанные значения (raw, rounded, risk) в объекте `CalculatedAmounts`.
