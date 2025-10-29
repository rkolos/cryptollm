# Техническое Задание (ТЗ): 6.3 Валидация Риска Портфеля (Total Portfolio Risk Check)

**Эпик:** 6. 🛡️ "Валидатор" (Validator Service) **Задача:** 6.3 Валидация Риска Портфеля **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Реализовать **Уровень 3** проверок в `ValidatorService`. Этот уровень отвечает за проверку `max_total_portfolio_risk_percent` (Раздел 3 "Техзадания 2.1" в `about.md`).

Эта проверка гарантирует, что риск новой сделки, _сложенный_ с рисками _всех_ уже открытых позиций, не превысит глобальный лимит, установленный в `ConfigService`.

## 2\. Зависимости Задачи

- **`ValidatorService.ts` (6.2):** (Модифицируемый) Файл, в который добавляется новая логика.
- **`decimal.js` (1.2):** (Критическая Зависимость) Используется для **всех** финансовых расчетов.
- **Типы (Types):** `AccountState`, `RiskRules`.

## 3\. Описание и Нюансы Реализации

### 3.1. Модификация `src/services/ValidatorService.ts`

Мы добавляем новый приватный метод `_validatePortfolioRisk` и интегрируем его в `validateAndCalculate` сразу после Уровня 2.

    // src/services/ValidatorService.ts (Дополнения)

    // ... (импорты из 6.1)
    // ... (интерфейсы, включая CalculatedAmounts из 6.2)

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
            this._validatePortfolioRisk(usdAtRisk, accountState, riskRules);

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
            usdAtRisk: Decimal,
            accountState: AccountState,
            riskRules: RiskRules
        ): void {

            const totalValue = new Decimal(accountState.total_portfolio_value_usdt);
            if (totalValue.isZero()) {
                // Предотвращение деления на ноль, если портфель пуст
                this.logger.warn("Total portfolio value is 0. Пропуск проверки общего риска.");
                return;
            }

            let totalCurrentRiskUsd = new Decimal(0);

            // 1. Суммируем риск *существующих* позиций
            for (const pos of accountState.open_positions) {
                // (Критично) Убеждаемся, что данные из БД корректны
                if (pos.average_entry_price && pos.stop_loss_price && pos.amount) {
                    const entry = new Decimal(pos.average_entry_price);
                    const stop = new Decimal(pos.stop_loss_price);
                    const amount = new Decimal(pos.amount);

                    // pos_risk_usd = abs(pos.average_entry_price - pos.stop_loss_price) * pos.amount
                    const posRiskUsd = entry.sub(stop).abs().times(amount);
                    totalCurrentRiskUsd = totalCurrentRiskUsd.plus(posRiskUsd);
                }
            }

            // 2. Рассчитываем % риска существующих позиций
            // total_current_risk_percent = (totalCurrentRiskUsd / total_value) * 100
            const totalCurrentRiskPercent = totalCurrentRiskUsd.div(totalValue).times(100);

            // 3. Рассчитываем % риска *новой* сделки
            // new_trade_risk_percent = (usd_at_risk / total_value) * 100
            const newTradeRiskPercent = usdAtRisk.div(totalValue).times(100);

            // 4. Сравниваем сумму с лимитом
            const maxTotalRiskPercent = new Decimal(riskRules.max_total_portfolio_risk_percent);
            const projectedTotalRiskPercent = totalCurrentRiskPercent.plus(newTradeRiskPercent);

            this.logger.debug(`Проверка Общего Риска: Текущий ${totalCurrentRiskPercent.toFixed(2)}% + Новый ${newTradeRiskPercent.toFixed(2)}% = Прогноз ${projectedTotalRiskPercent.toFixed(2)}% (Лимит: ${maxTotalRiskPercent}%)`);

            // if (projectedTotalRiskPercent > maxTotalRiskPercent)
            if (projectedTotalRiskPercent.greaterThan(maxTotalRiskPercent)) {
                throw new ValidationError(
                    `Новая сделка (риск ${newTradeRiskPercent.toFixed(2)}%) + ` +
                    `Открытые позиции (риск ${totalCurrentRiskPercent.toFixed(2)}%) = ` +
                    `${projectedTotalRiskPercent.toFixed(2)}%. ` +
                    `Это превышает max_total_portfolio_risk ${maxTotalRiskPercent}%.`
                );
            }
        }

        // (Заглушки для будущих Задач 6.6, 6.4, 6.5)
    }

## 4\. Критерии Приемки (Acceptance Criteria)

1.  **\[Service\]** В `ValidatorService.ts` добавлен новый приватный метод `_validatePortfolioRisk`.
2.  **\[Logic (Критично)\]** `_validatePortfolioRisk` выполняет **все** расчеты (суммирование рисков, расчет процентов) с использованием `decimal.js`.
3.  **\[Logic\]** `_validatePortfolioRisk` корректно итерирует `accountState.open_positions` и рассчитывает `posRiskUsd` для каждой позиции, используя формулу `abs(entry - stop) * amount`.
4.  **\[Logic\]** `_validatePortfolioRisk` корректно рассчитывает `totalCurrentRiskPercent` (суммарный риск _открытых_ позиций) и `newTradeRiskPercent` (риск _новой_ сделки).
5.  **\[Logic\]** `_validatePortfolioRisk` бросает `ValidationError` с информативным сообщением, если `projectedTotalRiskPercent` (сумма) > `riskRules.max_total_portfolio_risk_percent`.
6.  **\[Logic\]** `_validatePortfolioRisk` корректно обрабатывает случай, когда `total_portfolio_value_usdt` равен 0 (пропускает проверку).
7.  **\[Service\]** `validateAndCalculate` (главный метод) теперь вызывает `_validatePortfolioRisk` (после `_calculatePositionSizing`) для `OPEN_LONG` / `OPEN_SHORT`.
