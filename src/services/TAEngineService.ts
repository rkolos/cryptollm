import Decimal from 'decimal.js';
import { EMA, RSI, MACD, BollingerBands, ADX, ATR, OBV, VWAP, Stochastic } from 'technicalindicators';
import { LoggingService } from './LoggingService.js';
import type { IDecimalOHLCV } from '../interfaces/IExchangeService.js';
import type {
  AnalysisResult,
  TAInput,
  DecimalValue,
  KeyLevels,
  BollingerBands as IBollingerBands,
  MACDResult,
} from '../interfaces/ITATypes.js';
import type winston from 'winston';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DecimalConstructor = Decimal as any;

export class TAEngineService {
  private static instance: TAEngineService | undefined;
  private readonly logger: winston.Logger;

  private constructor() {
    this.logger = LoggingService.getInstance().getLogger('TAEngine');
    this.logger.info('TAEngineService initialized.');
  }

  public static getInstance(): TAEngineService {
    if (!TAEngineService.instance) {
      TAEngineService.instance = new TAEngineService();
    }
    return TAEngineService.instance;
  }

  private toDecimal(value: number | null | undefined): DecimalValue | null {
    if (value === null || value === undefined || isNaN(value) || !isFinite(value)) {
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new DecimalConstructor(value) as DecimalValue;
  }

  private toNumber(decimalValue: DecimalValue | null): number {
    if (decimalValue === null) {
      return 0;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const decimal = decimalValue as any;
    return decimal.toNumber();
  }

  private _prepareTAInput(ohlcv: IDecimalOHLCV[]): TAInput {
    return {
      open: ohlcv.map((candle) => this.toNumber(candle.open)),
      high: ohlcv.map((candle) => this.toNumber(candle.high)),
      low: ohlcv.map((candle) => this.toNumber(candle.low)),
      close: ohlcv.map((candle) => this.toNumber(candle.close)),
      volume: ohlcv.map((candle) => this.toNumber(candle.volume)),
    };
  }

  private _calculateKeyLevels(ohlcv: IDecimalOHLCV[], period: number = 100): KeyLevels {
    try {
      const candlesToCheck = ohlcv.slice(-period);
      if (candlesToCheck.length === 0) {
        return { period, high: null, low: null };
      }

      const firstCandle = candlesToCheck[0];
      if (!firstCandle) {
        return { period, high: null, low: null };
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let maxHigh = firstCandle.high as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let minLow = firstCandle.low as any;

      for (const candle of candlesToCheck) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const highDecimal = candle.high as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lowDecimal = candle.low as any;
        maxHigh = DecimalConstructor.max(maxHigh, highDecimal);
        minLow = DecimalConstructor.min(minLow, lowDecimal);
      }

      return {
        period,
        high: maxHigh as DecimalValue,
        low: minLow as DecimalValue,
      };
    } catch (error) {
      this.logger.error('Error calculating KeyLevels:', error);
      return { period, high: null, low: null };
    }
  }

  private _calculateBasicPackage(ohlcv: IDecimalOHLCV[], taInput: TAInput): Partial<AnalysisResult> {
    const result: Partial<AnalysisResult> = {};

    try {
      // EMA 50
      try {
        const ema50Result = EMA.calculate({ values: taInput.close, period: 50 });
        result.ema_50 = ema50Result.length > 0 ? this.toDecimal(ema50Result[ema50Result.length - 1]) : null;
      } catch (error) {
        this.logger.warn('Error calculating EMA 50:', error);
        result.ema_50 = null;
      }

      // EMA 200
      try {
        const ema200Result = EMA.calculate({ values: taInput.close, period: 200 });
        result.ema_200 = ema200Result.length > 0 ? this.toDecimal(ema200Result[ema200Result.length - 1]) : null;
      } catch (error) {
        this.logger.warn('Error calculating EMA 200:', error);
        result.ema_200 = null;
      }

      // RSI 14
      try {
        const rsiResult = RSI.calculate({ values: taInput.close, period: 14 });
        result.rsi = rsiResult.length > 0 ? this.toDecimal(rsiResult[rsiResult.length - 1]) : null;
      } catch (error) {
        this.logger.warn('Error calculating RSI:', error);
        result.rsi = null;
      }

      // MACD (12, 26, 9)
      try {
        const macdResult = MACD.calculate({
          values: taInput.close,
          fastPeriod: 12,
          slowPeriod: 26,
          signalPeriod: 9,
        });
        if (macdResult.length > 0) {
          const lastMacd = macdResult[macdResult.length - 1];
          if (lastMacd) {
            result.macd = {
              macd: this.toDecimal(lastMacd.MACD),
              signal: this.toDecimal(lastMacd.signal),
              histogram: this.toDecimal(lastMacd.histogram),
            };
          } else {
            result.macd = { macd: null, signal: null, histogram: null };
          }
        } else {
          result.macd = { macd: null, signal: null, histogram: null };
        }
      } catch (error) {
        this.logger.warn('Error calculating MACD:', error);
        result.macd = { macd: null, signal: null, histogram: null };
      }

      // Bollinger Bands (20, 2)
      try {
        const bbResult = BollingerBands.calculate({
          values: taInput.close,
          period: 20,
          stdDev: 2,
        });
        if (bbResult.length > 0) {
          const lastBB = bbResult[bbResult.length - 1];
          if (lastBB) {
            result.bollinger = {
              upper: this.toDecimal(lastBB.upper),
              middle: this.toDecimal(lastBB.middle),
              lower: this.toDecimal(lastBB.lower),
            };
          } else {
            result.bollinger = { upper: null, middle: null, lower: null };
          }
        } else {
          result.bollinger = { upper: null, middle: null, lower: null };
        }
      } catch (error) {
        this.logger.warn('Error calculating Bollinger Bands:', error);
        result.bollinger = { upper: null, middle: null, lower: null };
      }

      // Key Levels
      result.key_levels = this._calculateKeyLevels(ohlcv, 100);
    } catch (error) {
      this.logger.error('Error in _calculateBasicPackage:', error);
    }

    return result;
  }

  private _calculateExtendedPackage(taInput: TAInput, requestedData: string[]): Partial<AnalysisResult> {
    const result: Partial<AnalysisResult> = {};

    try {
      // ADX (14)
      if (requestedData.includes('ADX')) {
        try {
          const adxResult = ADX.calculate({
            high: taInput.high,
            low: taInput.low,
            close: taInput.close,
            period: 14,
          });
          if (adxResult.length > 0) {
            const lastAdx = adxResult[adxResult.length - 1];
            result.adx = lastAdx ? this.toDecimal(lastAdx.adx) : null;
          } else {
            result.adx = null;
          }
        } catch (error) {
          this.logger.warn('Error calculating ADX:', error);
          result.adx = null;
        }
      } else {
        result.adx = null;
      }

      // ATR (14)
      if (requestedData.includes('ATR')) {
        try {
          const atrResult = ATR.calculate({
            high: taInput.high,
            low: taInput.low,
            close: taInput.close,
            period: 14,
          });
          result.atr = atrResult.length > 0 ? this.toDecimal(atrResult[atrResult.length - 1]) : null;
        } catch (error) {
          this.logger.warn('Error calculating ATR:', error);
          result.atr = null;
        }
      } else {
        result.atr = null;
      }

      // OBV
      if (requestedData.includes('OBV')) {
        try {
          const obvResult = OBV.calculate({
            close: taInput.close,
            volume: taInput.volume,
          });
          result.obv = obvResult.length > 0 ? this.toDecimal(obvResult[obvResult.length - 1]) : null;
        } catch (error) {
          this.logger.warn('Error calculating OBV:', error);
          result.obv = null;
        }
      } else {
        result.obv = null;
      }

      // VWAP
      if (requestedData.includes('VWAP')) {
        try {
          const vwapResult = VWAP.calculate({
            high: taInput.high,
            low: taInput.low,
            close: taInput.close,
            volume: taInput.volume,
          });
          result.vwap = vwapResult.length > 0 ? this.toDecimal(vwapResult[vwapResult.length - 1]) : null;
        } catch (error) {
          this.logger.warn('Error calculating VWAP:', error);
          result.vwap = null;
        }
      } else {
        result.vwap = null;
      }

      // Stochastic (14, 3, 3)
      if (requestedData.includes('Stochastic')) {
        try {
          const stochResult = Stochastic.calculate({
            high: taInput.high,
            low: taInput.low,
            close: taInput.close,
            period: 14,
            signalPeriod: 3,
          });
          if (stochResult.length > 0) {
            const lastStoch = stochResult[stochResult.length - 1];
            if (lastStoch) {
              result.stochastic = {
                k: this.toDecimal(lastStoch.k),
                d: this.toDecimal(lastStoch.d),
              };
            } else {
              result.stochastic = { k: null, d: null };
            }
          } else {
            result.stochastic = { k: null, d: null };
          }
        } catch (error) {
          this.logger.warn('Error calculating Stochastic:', error);
          result.stochastic = { k: null, d: null };
        }
      } else {
        result.stochastic = null;
      }
    } catch (error) {
      this.logger.error('Error in _calculateExtendedPackage:', error);
    }

    return result;
  }

  public getAnalysis(ohlcv: IDecimalOHLCV[], requestedData: string[] = []): AnalysisResult {
    try {
      if (!ohlcv || ohlcv.length === 0) {
        this.logger.warn('Empty OHLCV array provided. Returning null AnalysisResult.');
        return this._getNullResult();
      }

      // Подготовка входных данных для TA библиотек
      const taInput = this._prepareTAInput(ohlcv);

      // Расчет базового пакета (всегда)
      const basicPackage = this._calculateBasicPackage(ohlcv, taInput);

      // Расчет расширенного пакета (только по запросу)
      const extendedPackage = this._calculateExtendedPackage(taInput, requestedData);

      // Объединение результатов
      const result: AnalysisResult = {
        // Базовый пакет
        ema_50: basicPackage.ema_50 ?? null,
        ema_200: basicPackage.ema_200 ?? null,
        rsi: basicPackage.rsi ?? null,
        macd: basicPackage.macd ?? null,
        bollinger: basicPackage.bollinger ?? null,
        key_levels: basicPackage.key_levels ?? null,

        // Расширенный пакет
        adx: extendedPackage.adx ?? null,
        atr: extendedPackage.atr ?? null,
        obv: extendedPackage.obv ?? null,
        vwap: extendedPackage.vwap ?? null,
        stochastic: extendedPackage.stochastic ?? null,
      };

      return result;
    } catch (error) {
      this.logger.error('Fatal error in getAnalysis:', error);
      return this._getNullResult();
    }
  }

  private _getNullResult(): AnalysisResult {
    return {
      ema_50: null,
      ema_200: null,
      rsi: null,
      macd: { macd: null, signal: null, histogram: null },
      bollinger: { upper: null, middle: null, lower: null },
      key_levels: { period: 100, high: null, low: null },
      adx: null,
      atr: null,
      obv: null,
      vwap: null,
      stochastic: null,
    };
  }
}
