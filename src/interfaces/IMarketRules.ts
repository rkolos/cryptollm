import Decimal from 'decimal.js';

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
