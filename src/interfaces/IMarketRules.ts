import Decimal from 'decimal.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const decimalInstance = new (Decimal as any)(0);
type DecimalValue = typeof decimalInstance;

export interface IMarketRules {
  minNotional: DecimalValue;
  takerFee: DecimalValue;
  precision: {
    amount: DecimalValue;
    price: DecimalValue;
  };
}
