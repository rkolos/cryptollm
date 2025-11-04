# Техническое Задание (ТЗ): 6.5 Валидация Комиссии (Fee Logic Check)

**Эпик:** 6. 🛡️ "Валидатор" (Validator Service) **Задача:** 6.5 Валидация Комиссии (Fee Logic Check) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Реализовать **третью и финальную часть Уровня 4** проверок в `ValidatorService`. Эта задача отвечает за проверку "Комиссия против Риска" (Раздел 4 из "Техзадания 2.1" в `about.md`).

Эта проверка гарантирует, что сделка экономически целесообразна: наш "сырой" риск (`usdAtRisk`, рассчитанный в 6.2) должен быть строго больше, чем предполагаемые комиссии за вход и выход (`round_trip_fee_usd`).

## 2\. Зависимости Задачи

- **`ValidatorService.ts` (6.4):** (Модифицируемый) Файл, в который добавляется новая логика.
- **`ExchangeRulesService` (3.2):** (Зависимость) Используется для получения правил через `getRules(pair)` (`takerFee`).
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

        public validateDecision(
            decision: LLMDecision,
            accountState: AccountState,
            strategyContext: StrategyContext,
            marketData: MarketData,
            _exchangeRules: IMarketRules
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
            roundedAmountUsd: DecimalValue,
            usdAtRisk: DecimalValue
        ): void {
            // 1. Получаем комиссию 'taker'
            const rules = this.exchangeRulesService.getRules(pair);
            const takerFeeDecimal = rules.takerFee as any;
            const roundedAmountUsdDecimal = roundedAmountUsd as any;
            const usdAtRiskDecimal = usdAtRisk as any;

            // 2. Рассчитываем комиссию за "туда-обратно" (round-trip)
            // (Мы используем 'roundedAmountUsd' для расчета, т.к. это реальная стоимость ордера)

            // one_way_fee = roundedAmountUsd * takerFee
            const oneWayFeeUsd = roundedAmountUsdDecimal.mul(takerFeeDecimal) as DecimalValue;
            // round_trip_fee = one_way_fee * 2
            const oneWayFeeUsdDecimal = oneWayFeeUsd as any;
            const two = new DecimalConstructor(2);
            const roundTripFeeUsd = oneWayFeeUsdDecimal.mul(two) as DecimalValue;

            const roundTripFeeUsdDecimal = roundTripFeeUsd as any;
            this.logger.debug(
                `[${pair}] Проверка Комиссии: Риск $${usdAtRiskDecimal.toFixed(4)} vs Комиссия $${roundTripFeeUsdDecimal.toFixed(4)}`,
            );

            // 3. (Критично) Проверяем, что Риск > Комиссии
            if (usdAtRiskDecimal.lte(roundTripFeeUsdDecimal)) {
                throw new ValidationError(
                    `[${pair}] Сделка невыгодна: Потенциальный убыток (Риск) $${usdAtRiskDecimal.toFixed(4)} ` +
                        `меньше или равен гарантированным комиссиям $${roundTripFeeUsdDecimal.toFixed(4)}. ` +
                        `Увеличьте дистанцию до стопа.`,
                );
            }
        }
    }

## 4\. Критерии Приемки (Acceptance Criteria)

_(Критерии 1-7 из Задачи 6.4 остаются в силе)_

8.  **\[Service\]** В `ValidatorService.ts` добавлен новый приватный метод `_validateFeeVsRisk(pair, roundedAmountUsd, usdAtRisk)`, который принимает `DecimalValue` типы.
9.  **\[Service\]** `_validateExchangeAndBalanceRules` (из 6.4) теперь вызывает `_validateFeeVsRisk(pair, roundedAmountUsd, usdAtRisk)` в качестве своего последнего шага.
10. **\[Logic (Критично)\]** `_validateFeeVsRisk` вызывает `this.exchangeRulesService.getRules(pair)` и получает `rules.takerFee` напрямую из объекта rules.
11. **\[Logic\]** `_validateFeeVsRisk` корректно рассчитывает `roundTripFeeUsd`, используя `roundedAmountUsd.mul(takerFee)` для `oneWayFeeUsd` и `oneWayFeeUsd.mul(2)` для `roundTripFeeUsd` через методы `Decimal`.
12. **\[Debug\]** `_validateFeeVsRisk` логирует `debug` сообщение с детальной информацией о проверке (Риск vs Комиссия).
13. **\[Logic (Критично)\]** `_validateFeeVsRisk` бросает `ValidationError` с информативным сообщением на русском языке, если `usdAtRisk.lte(roundTripFeeUsd)`.
14. **\[Logic\]** Все расчеты и сравнения комиссий выполняются с использованием `decimal.js` и методов `Decimal` (`.mul()`, `.lte()`).
