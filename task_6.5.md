# Техническое Задание (ТЗ): 6.5 Валидация Комиссии (Fee Logic Check)

**Эпик:** 6. 🛡️ "Валидатор" (Validator Service) **Задача:** 6.5 Валидация Комиссии (Fee Logic Check) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Реализовать **третью и финальную часть Уровня 4** проверок в `ValidatorService`. Эта задача отвечает за проверку "Комиссия против Риска" (Раздел 4 из "Техзадания 2.1" в `about.md`).

Эта проверка гарантирует, что сделка экономически целесообразна: наш "сырой" риск (`usdAtRisk`, рассчитанный в 6.2) должен быть строго больше, чем предполагаемые комиссии за вход и выход (`round_trip_fee_usd`).

## 2\. Зависимости Задачи

- **`ValidatorService.ts` (6.4):** (Модифицируемый) Файл, в который добавляется новая логика.
- **`ExchangeRulesService` (3.2):** (Зависимость) Используется для получения правил `taker` (комиссия).
- **`decimal.js` (1.2):** (Зависимость)
- **Типы (Types):** `CalculatedAmounts`.

## 3\. Описание и Нюансы Реализации

### 3.1. Модификация `src/services/ValidatorService.ts`

Мы "раскомментируем" заглушку `_validateFeeVsRisk`, реализуем ее и вызовем из `_validateExchangeAndBalanceRules`.

    // src/services/ValidatorService.ts (Дополнения)

    // ... (импорты из 6.6)
    // ... (интерфейсы, включая CalculatedAmounts из 6.6)

    export class ValidatorService {
        // ... (instance, logger, exchangeRules, constructor, getInstance из 6.1)

        public validateAndCalculate(
            decision: LLMDecision,
            accountState: AccountState,
            marketData: MarketData,
            riskRules: RiskRules
        ): CalculatedAmounts {

            // ... (Код Уровня 1, 2, 3 и 'return' для не-OPEN действий из 6.6)

            // === УРОВЕНЬ 2 (Реализован в 6.2) ===
            const { rawAmountCoin, rawAmountUsd, usdAtRisk } = this._calculatePositionSizing(
                decision, entryPrice, accountState, riskRules
            );

            // === УРОВЕНЬ 3 (Реализован в 6.3) ===
            this._validatePortfolioRisk(usdAtRisk, accountState, riskRules);

            // === УРОВЕНЬ 4 (Часть 1 - Реализован в 6.6) ===
            const { roundedAmountCoin, roundedAmountUsd, roundedEntryPrice } = this._validateAndRoundPrecision(
                decision.pair,
                rawAmountCoin,
                entryPrice
            );

            // === УРОВЕНЬ 4 (Часть 2 и 3 - Задачи 6.4 и 6.5) ===
            this._validateExchangeAndBalanceRules(
                decision.pair,
                roundedAmountUsd, // (Округленная стоимость из 6.6)
                usdAtRisk,          // ("Сырой" риск из 6.2)
                accountState
            );

            this.logger.info(`[${decision.pair}] Валидация Уровня 4 (Fee vs Risk) пройдена.`);
            this.logger.info(`[${decision.pair}] ВАЛИДАЦИЯ УСПЕШНА. Ордер готов к исполнению.`);

            // (Возвращаем ВСЕ рассчитанные значения)
            return {
                rawAmountCoin, rawAmountUsd,
                roundedAmountCoin, roundedAmountUsd, roundedEntryPrice,
                usdAtRisk,
                entryPrice
            };
        }

        // --- (Реализованы в 6.1, 6.2, 6.3) ---
        // private _validateSanityAndLogicChecks(...) { ... }
        // private _calculatePositionSizing(...) { ... }
        // private _validatePortfolioRisk(...) { ... }

        // --- (Реализован в 6.6) ---
        // private _validateAndRoundPrecision(...) { ... }


        // --- Реализация Уровня 4 (Часть 2 - Модификация 6.4) ---

        private _validateExchangeAndBalanceRules(
            pair: string,
            roundedAmountUsd: Decimal,
            usdAtRisk: Decimal,
            accountState: AccountState
        ): void {

            // ... (Код для 1. Получения 'limits' из 6.4) ...
            // ... (Код для 2. Проверки 'minNotional' из 6.4) ...
            // ... (Код для 3. Проверки 'availableBalance' из 6.4) ...

            // 4. (Эта Задача) Вызов проверки Комиссии
            this._validateFeeVsRisk(pair, roundedAmountUsd, usdAtRisk);
        }

        // --- Реализация Уровня 4 (Часть 3 - Эта Задача: 6.5) ---

        /**
         * УРОВЕНЬ 4 (Часть 3): Проверяет, что риск (потенциальный убыток)
         * больше, чем стоимость комиссий (гарантированный убыток).
         * @param pair - Торговая пара
         * @param roundedAmountUsd - Округленная стоимость ордера (из 6.6)
         * @param usdAtRisk - "Сырой" риск (из 6.2)
         * @throws {ValidationError}
         */
        private _validateFeeVsRisk(
            pair: string,
            roundedAmountUsd: Decimal,
            usdAtRisk: Decimal
        ): void {

            // 1. Получаем комиссию 'taker'
            const fees = this.exchangeRules.getFees(pair);
            if (!fees || typeof fees.taker !== 'number') {
                this.logger.error(`[${pair}] НЕ УДАЛОСЬ получить правила комиссий (taker fee).`);
                throw new ValidationError(`[${pair}] Критическая ошибка: Отсутствуют правила комиссий (taker fee)`);
            }

            const takerFee = new Decimal(fees.taker); // (e.g., 0.001 для 0.1%)

            // 2. Рассчитываем комиссию за "туда-обратно" (round-trip)
            // (Мы используем 'roundedAmountUsd' для расчета, т.к. это реальная стоимость ордера)

            // one_way_fee = roundedAmountUsd * takerFee
            const oneWayFeeUsd = roundedAmountUsd.times(takerFee);
            // round_trip_fee = one_way_fee * 2
            const roundTripFeeUsd = oneWayFeeUsd.times(2);

            this.logger.debug(`[${pair}] Проверка Комиссии: Риск $${usdAtRisk.toFixed(4)} vs Комиссия $${roundTripFeeUsd.toFixed(4)}`);

            // 3. (Критично) Проверяем, что Риск > Комиссии
            // if (usdAtRisk <= roundTripFeeUsd)
            if (usdAtRisk.lessThanOrEqualTo(roundTripFeeUsd)) {
                throw new ValidationError(
                    `[${pair}] Сделка невыгодна: Потенциальный убыток (Риск) $${usdAtRisk.toFixed(4)} ` +
                    `меньше или равен гарантированным комиссиям $${roundTripFeeUsd.toFixed(4)}. ` +
                    `Увеличьте дистанцию до стопа.`
                );
            }
        }
    }

## 4\. Критерии Приемки (Acceptance Criteria)

_(Критерии 1-7 из Задачи 6.4 остаются в силе)_

8.  **\[Service\]** В `ValidatorService.ts` добавлен новый приватный метод `_validateFeeVsRisk`.
9.  **\[Service\]** `_validateExchangeAndBalanceRules` (из 6.4) теперь вызывает `_validateFeeVsRisk` в качестве своего последнего шага.
10. **\[Logic (Критично)\]** `_validateFeeVsRisk` вызывает `this.exchangeRules.getFees(pair)` и бросает `ValidationError`, если `fees.taker` не найден.

11. **\[Logic\]** `_validateFeeVsRisk` корректно рассчитывает `roundTripFeeUsd`, используя `roundedAmountUsd` (из 6.6) и `takerFee`.

12. **\[Logic (Критично)\]** `_validateFeeVsRisk` бросает `ValidationError` с информативным сообщением, если `usdAtRisk` (из 6.2) **меньше или равен** `roundTripFeeUsd`.

13. **\[Logic\]** Все расчеты и сравнения комиссий выполняются с использованием `decimal.js`.
