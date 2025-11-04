# Техническое Задание (ТЗ): 6.4 Валидация Баланса и Биржи (Balance & Exchange Checks)

**Эпик:** 6. 🛡️ "Валидатор" (Validator Service) **Задача:** 6.4 Валидация Баланса и Биржи **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Реализовать **вторую часть Уровня 4** проверок в `ValidatorService`. Эта задача отвечает за проверку `minNotional` (Раздел 4) и `available_quote_balance` (Раздел 3) из "Техзадания 2.1" в `about.md`.

Эта проверка гарантирует, что ордер, который мы _уже округлили_ (в Задаче 6.6), (а) достаточно велик для биржи и (б) мы можем его себе позволить.

## 2\. Зависимости Задачи

- **`ValidatorService.ts` (6.6):** (Модифицируемый) Файл, в который добавляется новая логика.
- **`ExchangeRulesService` (3.2):** (Зависимость) Используется для получения правил через `getRules(pair)` (`minNotional`, `takerFee`).
- **`decimal.js` (1.2):** (Зависимость)
- **Типы (Types):** `AccountState`, `CalculatedAmounts`.

## 3\. Описание и Нюансы Реализации

### 3.1. Модификация `src/services/ValidatorService.ts`

Мы добавляем новый приватный метод `_validateExchangeAndBalanceRules` и вызываем его из `validateAndCalculate` сразу после Уровня 4 (Часть 1).

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
            const calculatedAmounts = this._calculatePositionSizing(
                decision, accountState, strategyContext, entryPrice
            );
            const { rawAmountCoin, rawAmountUsd, usdAtRisk } = calculatedAmounts;

            // === УРОВЕНЬ 3 (Реализован в 6.3) ===
            this._validatePortfolioRisk(usdAtRisk, accountState, strategyContext);

            // === УРОВЕНЬ 4 (Часть 1 - Реализован в 6.6) ===
            const { roundedAmountCoin, roundedAmountUsd, roundedEntryPrice } = this._validateAndRoundPrecision(
                decision.pair,
                rawAmountCoin,
                entryPrice
            );

            // === УРОВЕНЬ 4 (Часть 2 - Эта Задача: 6.4 и 6.5) ===
            this._validateExchangeAndBalanceRules(
                decision.pair,
                roundedAmountUsd, // (Округленная стоимость из 6.6)
                usdAtRisk,          // ("Сырой" риск из 6.2)
                accountState
            );

            this.logger.info(`[${decision.pair}] Валидация Уровня 4 (Balance, MinNotional) пройдена.`);
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


        // --- Реализация Уровня 4 (Часть 2 - Эта Задача) ---

        /**
         * УРОВЕНЬ 4 (Часть 2): Проверяет правила биржи (minNotional)
         * и доступный баланс.
         * (Готовит почву для 6.5 - Fee Check)
         * @param pair - Торговая пара
         * @param roundedAmountUsd - Округленная стоимость ордера (из 6.6)
         * @param usdAtRisk - "Сырой" риск (из 6.2)
         * @param accountState - Текущее состояние счета
         * @throws {ValidationError}
         */
        private _validateExchangeAndBalanceRules(
            pair: string,
            roundedAmountUsd: DecimalValue,
            usdAtRisk: DecimalValue,
            accountState: AccountState
        ): void {
            // 1. Получаем правила биржи (minNotional)
            const rules = this.exchangeRulesService.getRules(pair);
            const minNotionalDecimal = rules.minNotional as any;
            const roundedAmountUsdDecimal = roundedAmountUsd as any;

            // 2. (Эта Задача) Проверка MinNotional
            if (roundedAmountUsdDecimal.lt(minNotionalDecimal)) {
                throw new ValidationError(
                    `[${pair}] Рассчитанная стоимость ордера $${roundedAmountUsdDecimal.toFixed(2)} ` +
                        `ниже биржевого минимума $${minNotionalDecimal.toString()}. ` +
                        `Увеличьте % риска или дистанцию до стопа.`,
                );
            }

            // 3. (Эта Задача) Проверка Баланса
            const availableBalanceDecimal = accountState.available_quote_balance as any;

            if (roundedAmountUsdDecimal.gt(availableBalanceDecimal)) {
                throw new ValidationError(
                    `[${pair}] Рассчитанная стоимость ордера $${roundedAmountUsdDecimal.toFixed(2)} ` +
                        `превышает доступный баланс $${availableBalanceDecimal.toFixed(2)}.`,
                );
            }

            this.logger.debug(
                `[${pair}] Exchange Rules Check: roundedAmountUsd=${roundedAmountUsdDecimal.toFixed(2)}, minNotional=${minNotionalDecimal.toString()}, availableBalance=${availableBalanceDecimal.toFixed(2)}`,
            );

            // 4. (Задача 6.5) Вызов проверки Комиссии
            this._validateFeeVsRisk(pair, roundedAmountUsd, usdAtRisk);
        }

        // (Заглушка для Задачи 6.5)
        /*
        private _validateFeeVsRisk(
            pair: string,
            roundedAmountUsd: Decimal,
            usdAtRisk: Decimal
        ): void {
            // ... будет реализовано в 6.5
        }
        */
    }

## 4\. Критерии Приемки (Acceptance Criteria)

1.  **\[Service\]** В `ValidatorService.ts` добавлен новый приватный метод `_validateExchangeAndBalanceRules(pair, roundedAmountUsd, usdAtRisk, accountState)`, который принимает `DecimalValue` типы.
2.  **\[Logic (Критично)\]** `_validateExchangeAndBalanceRules` вызывает `this.exchangeRulesService.getRules(pair)` и получает `rules.minNotional` напрямую из объекта rules.
3.  **\[Logic (Критично)\]** `_validateExchangeAndBalanceRules` сравнивает `roundedAmountUsd` (из 6.6) с `minNotional` (из `ExchangeRulesService`) через `.lt()` и бросает `ValidationError` с информативным сообщением на русском языке, если `roundedAmountUsd.lt(minNotional)`.
4.  **\[Logic (Критично)\]** `_validateExchangeAndBalanceRules` сравнивает `roundedAmountUsd` (из 6.6) с `accountState.available_quote_balance` через `.gt()` и бросает `ValidationError` с информативным сообщением на русском языке, если `roundedAmountUsd.gt(availableBalance)`.
5.  **\[Logic\]** Все сравнения (minNotional, balance) выполняются с использованием `decimal.js` и методов `Decimal` (`.lt()`, `.gt()`).
6.  **\[Debug\]** `_validateExchangeAndBalanceRules` логирует `debug` сообщение с детальной информацией о проверке (roundedAmountUsd, minNotional, availableBalance).
7.  **\[Service\]** `_validateExchangeAndBalanceRules` вызывает `this._validateFeeVsRisk(pair, roundedAmountUsd, usdAtRisk)` в качестве последнего шага (для Задачи 6.5).
8.  **\[Service\]** `validateDecision` (главный метод) теперь вызывает `_validateExchangeAndBalanceRules(decision.pair, rounded.roundedAmountUsd, calculatedAmounts.usdAtRisk, accountState)` (после `_validateAndRoundPrecision`).
9.  **\[Service\]** `validateDecision` передает в `_validateExchangeAndBalanceRules` _округленную_ `roundedAmountUsd` (из 6.6) и _сырой_ `usdAtRisk` (из 6.2).
