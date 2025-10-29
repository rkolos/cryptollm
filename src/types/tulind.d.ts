declare module 'tulind' {
  export interface IndicatorFunction {
    (
      data: number[][],
      options: number[],
      callback: (err: Error | null, result: number[][]) => void,
    ): void;
  }

  export interface Indicators {
    [key: string]: IndicatorFunction;
    rsi: IndicatorFunction;
    sma: IndicatorFunction;
    ema: IndicatorFunction;
    macd: IndicatorFunction;
    adx: IndicatorFunction;
    atr: IndicatorFunction;
    obv: IndicatorFunction;
    vwap: IndicatorFunction;
    stochastic: IndicatorFunction;
  }

  export const indicators: Indicators;
}

