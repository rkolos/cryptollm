# Техническое Задание (ТЗ): 6.3 Валидация Риска Портфеля (Total Portfolio Risk Check)

**Эпик:** 6. 🛡️ "Валидатор" (Validator Service) **Задача:** 6.3 Валидация Риска Портфеля **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Реализовать **Уровень 3** проверок в `ValidatorService`. Этот уровень отвечает за проверку `max_total_portfolio_risk_percent` (Раздел 3 "Техзадания 2.1" в `about.md`).

Эта проверка гарантирует, что риск новой сделки, _сложенный_ с рисками _всех_ уже открытых позиций, не превысит глобальный лимит, установленный в `ConfigService`.

## 2\. Зависимости Задачи

- **`ValidatorService.ts` (6.2):** (Модифицируемый) Файл, в который добавляется новая логика.
- **`decimal.js` (1.2):** (Критическая Зависимость) Используется для **всех** финансовых расчетов.
- **Типы (Types):** `AccountState`, `StrategyContext` (вместо `RiskRules`).

## 3\. Описание и Нюансы Реализации

### 3.1. Модификация `src/services/ValidatorService.ts`

Мы добавляем новый приватный метод `_validatePortfolioRisk` и интегрируем его в `validateAndCalculate` сразу после Уровня 2.

    // src/services/ValidatorService.ts (Дополнения)

    // ... (импорты из 6.1)
    // ... (интерфейсы, включая CalculatedAmounts из 6.2)

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

            // (Проверка) Если это не 'OPEN' - расчеты не нужны.
            if (decision.action !== 'OPEN_LONG' && decision.action !== 'OPEN_SHORT') {
                // ... (возврат пустых значений, как в 6.2)
                return {
                    rawAmountCoin: new Decimal(0),
                    rawAmountUsd: new Decimal(0),
                    usdAtRisk: new Decimal(0),
                    entryPrice: entryPrice || new Decimal(0)
                };
            }

            // === УРОВЕНЬ 2 (Реализован в 6.2) ===
            const { rawAmountCoin, rawAmountUsd, usdAtRisk } = this._calculatePositionSizing(
                decision, entryPrice, accountState, riskRules
            );

            // === УРОВЕНЬ 3 (Эта Задача: 6.3) ===
            this._validatePortfolioRisk(usdAtRisk, accountState, strategyContext);

            // === УРОВЕНЬ 4 (Задачи 6.6, 6.4, 6.5) ===
            // const { roundedAmountCoin, roundedAmountUsd } = this._validatePrecisionAndExchangeRules(
            //     decision, rawAmountCoin, entryPrice, usdAtRisk
            // );

            this.logger.info(`[${decision.pair}] Валидация Уровня 3 (Total Portfolio Risk) пройдена.`);

            // (Возвращаем 'raw' значения для следующих уровней)
            return {
                rawAmountCoin: rawAmountCoin,
                rawAmountUsd: rawAmountUsd,
                usdAtRisk: usdAtRisk,
                entryPrice: entryPrice
            };
        }

        // --- (Реализован в 6.1) ---
        // private _validateSanityAndLogicChecks(...) { ... }

        // --- (Реализован в 6.2) ---
        // private _calculatePositionSizing(...) { ... }

        // --- Реализация Уровня 3 (Эта Задача) ---

        /**
         * УРОВЕНЬ 3: Проверяет, что риск новой сделки + риск открытых позиций
         * не превышает max_total_portfolio_risk_percent.
         * (Раздел 3 из Техзадания 2.1 в about.md)
         * @param usdAtRisk - Риск *новой* сделки (рассчитан в Уровне 2)
         * @throws {ValidationError}
         */
        private _validatePortfolioRisk(
            usdAtRisk: DecimalValue,
            accountState: AccountState,
            strategyContext: StrategyContext
        ): void {
            const riskRules = strategyContext.risk_rules;
            // Использовать toDecimal() для преобразования total_portfolio_value_usdt
            const totalValueDecimal = accountState.total_portfolio_value_usdt as any;
            const zero = new DecimalConstructor(0);

            if (totalValueDecimal.isZero() || totalValueDecimal.eq(zero)) {
                this.logger.warn('Total portfolio value is 0. Skipping total portfolio risk check.');
                return;
            }

            // Суммируем риск существующих позиций
            let totalCurrentRiskUsd = new DecimalConstructor(0) as any;

            for (const pos of accountState.open_positions) {
                if (pos.average_entry_price && pos.stop_loss_price && pos.amount) {
                    const entryDecimal = pos.average_entry_price as any;
                    const stopDecimal = pos.stop_loss_price as any;
                    const amountDecimal = pos.amount as any;

                    // pos_risk_usd = abs(entry - stop) * amount
                    const posRiskUsd = entryDecimal.sub(stopDecimal).abs().mul(amountDecimal) as any;
                    totalCurrentRiskUsd = totalCurrentRiskUsd.add(posRiskUsd);
                }
            }

            // Рассчитываем % риска существующих позиций
            // total_current_risk_percent = (totalCurrentRiskUsd / total_value) * 100
            const hundred = new DecimalConstructor(100);
            const totalCurrentRiskPercent = totalCurrentRiskUsd.div(totalValueDecimal).mul(hundred) as any;

            // Рассчитываем % риска новой сделки
            // new_trade_risk_percent = (usd_at_risk / total_value) * 100
            const usdAtRiskDecimal = usdAtRisk as any;
            const newTradeRiskPercent = usdAtRiskDecimal.div(totalValueDecimal).mul(hundred) as any;

            // Сравниваем сумму с лимитом
            const maxTotalRiskPercent = this.toDecimal(riskRules.max_total_portfolio_risk_percent) as any;
            const projectedTotalRiskPercent = totalCurrentRiskPercent.add(newTradeRiskPercent) as any;

            this.logger.debug(
                `Portfolio Risk Check: Current ${totalCurrentRiskPercent.toFixed(2)}% + New ${newTradeRiskPercent.toFixed(2)}% = Projected ${projectedTotalRiskPercent.toFixed(2)}% (Limit: ${maxTotalRiskPercent.toFixed(2)}%)`,
            );

            if (projectedTotalRiskPercent.gt(maxTotalRiskPercent)) {
                throw new ValidationError(
                    `New trade (risk ${newTradeRiskPercent.toFixed(2)}%) + Open positions (risk ${totalCurrentRiskPercent.toFixed(2)}%) = ${projectedTotalRiskPercent.toFixed(2)}%. This exceeds max_total_portfolio_risk_percent (${maxTotalRiskPercent.toFixed(2)}%).`,
                );
            }
        }

        // (Заглушки для будущих Задач 6.6, 6.4, 6.5)
    }

## 4\. Критерии Приемки (Acceptance Criteria)

1.  **\[Service\]** В `ValidatorService.ts` добавлен новый приватный метод `_validatePortfolioRisk(usdAtRisk, accountState, strategyContext)`.
2.  **\[Logic (Критично)\]** `_validatePortfolioRisk` выполняет **все** расчеты (суммирование рисков, расчет процентов) с использованием `decimal.js` и методов `Decimal` (`.sub()`, `.abs()`, `.mul()`, `.div()`, `.add()`, `.gt()`).
3.  **\[Logic\]** `_validatePortfolioRisk` корректно итерирует `accountState.open_positions` и рассчитывает `posRiskUsd` для каждой позиции, используя формулу `entry.sub(stop).abs().mul(amount)`.
4.  **\[Logic\]** `_validatePortfolioRisk` корректно рассчитывает `totalCurrentRiskPercent` (суммарный риск _открытых_ позиций) по формуле `totalCurrentRiskUsd.div(totalValue).mul(100)` и `newTradeRiskPercent` (риск _новой_ сделки) по формуле `usdAtRisk.div(totalValue).mul(100)`.
5.  **\[Logic\]** `_validatePortfolioRisk` использует `toDecimal()` для преобразования `riskRules.max_total_portfolio_risk_percent` и бросает `ValidationError` с информативным сообщением на английском языке, если `projectedTotalRiskPercent.gt(maxTotalRiskPercent)`.
6.  **\[Logic\]** `_validatePortfolioRisk` корректно обрабатывает случай, когда `total_portfolio_value_usdt` равен 0 (проверка через `.isZero()` или `.eq(zero)`, пропускает проверку с `warn` логом).
7.  **\[Service\]** `validateDecision` (главный метод) теперь вызывает `_validatePortfolioRisk(calculatedAmounts.usdAtRisk, accountState, strategyContext)` (после `_calculatePositionSizing`) для `OPEN_LONG` / `OPEN_SHORT`.
8.  **\[Debug\]** `_validatePortfolioRisk` логирует `debug` сообщение с детальной информацией о расчетах риска перед проверкой лимита.
