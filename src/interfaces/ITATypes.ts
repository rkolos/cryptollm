import Decimal from 'decimal.js';
import type { IDecimalOHLCV } from './IExchangeService.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const decimalInstance = new (Decimal as any)(0);
export type DecimalValue = typeof decimalInstance;

export interface KeyLevels {
  period: number;
  high: DecimalValue | null;
  low: DecimalValue | null;
}

export interface BollingerBands {
  upper: DecimalValue | null;
  middle: DecimalValue | null;
  lower: DecimalValue | null;
}

export interface MACDResult {
  macd: DecimalValue | null;
  signal: DecimalValue | null;
  histogram: DecimalValue | null;
}

export interface AnalysisResult {
  // Базовый пакет (всегда рассчитывается)
  ema_50: DecimalValue | null;
  ema_200: DecimalValue | null;
  rsi: DecimalValue | null;
  macd: MACDResult | null;
  bollinger: BollingerBands | null;
  key_levels: KeyLevels | null;

  // Расширенный пакет (только по запросу)
  adx: DecimalValue | null;
  atr: DecimalValue | null;
  obv: DecimalValue | null;
  vwap: DecimalValue | null;
  stochastic: {
    k: DecimalValue | null;
    d: DecimalValue | null;
  } | null;
}

export interface TAInput {
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
}
