import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Decimal from 'decimal.js';
import { ConfigService } from './ConfigService.js';
import { DatabaseService } from './DatabaseService.js';
import { MarketDataService } from './MarketDataService.js';
import { TAEngineService } from './TAEngineService.js';
import { WatchlistOverviewService } from './WatchlistOverviewService.js';
import { AccountStateService } from './AccountStateService.js';
import { MacroContextService } from './MacroContextService.js';
import { LoggingService } from './LoggingService.js';
import type { IDecimalOHLCV } from '../interfaces/IExchangeService.js';
import type { AnalysisResult, DecimalValue } from '../interfaces/ITATypes.js';
import type winston from 'winston';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPT_DIR_V1 = join(__dirname, '..', 'prompts', 'v1');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DecimalConstructor = Decimal as any;

interface PromptCache {
  systemPrompt: string;
  userTemplate: string;
  outputSchema: string;
  finalQuestionTemplate: string;
}

interface LLMRequestPayload {
  system_prompt: string;
  user_prompt: string;
}

export class LLMRequestAssemblerService {
  private static instance: LLMRequestAssemblerService | undefined;
  private readonly logger: winston.Logger;
  private readonly configService: ConfigService;
  private readonly databaseService: DatabaseService;
  private readonly marketDataService: MarketDataService;
  private readonly taEngineService: TAEngineService;
  private readonly watchlistOverviewService: WatchlistOverviewService;
  private readonly accountStateService: AccountStateService;
  private readonly macroContextService: MacroContextService;

  private promptCache: PromptCache | null = null;

  private constructor(
    configService: ConfigService,
    databaseService: DatabaseService,
    marketDataService: MarketDataService,
    taEngineService: TAEngineService,
    watchlistOverviewService: WatchlistOverviewService,
    accountStateService: AccountStateService,
    macroContextService: MacroContextService,
  ) {
    this.configService = configService;
    this.databaseService = databaseService;
    this.marketDataService = marketDataService;
    this.taEngineService = taEngineService;
    this.watchlistOverviewService = watchlistOverviewService;
    this.accountStateService = accountStateService;
    this.macroContextService = macroContextService;
    this.logger = LoggingService.getInstance().getLogger('LLMRequestAssembler');
    this.logger.info('LLMRequestAssemblerService initialized.');
  }

  public static getInstance(
    configService: ConfigService,
    databaseService: DatabaseService,
    marketDataService: MarketDataService,
    taEngineService: TAEngineService,
    watchlistOverviewService: WatchlistOverviewService,
    accountStateService: AccountStateService,
    macroContextService: MacroContextService,
  ): LLMRequestAssemblerService {
    if (!LLMRequestAssemblerService.instance) {
      LLMRequestAssemblerService.instance = new LLMRequestAssemblerService(
        configService,
        databaseService,
        marketDataService,
        taEngineService,
        watchlistOverviewService,
        accountStateService,
        macroContextService,
      );
    }
    return LLMRequestAssemblerService.instance;
  }

  /**
   * Инициализация: загрузка промптов в кэш
   */
  public async initialize(): Promise<void> {
    this.logger.info('Loading prompts from disk...');
    try {
      const [systemPrompt, userTemplate, outputSchema, finalQuestionTemplate] = await Promise.all([
        readFile(join(PROMPT_DIR_V1, 'system.md'), 'utf-8'),
        readFile(join(PROMPT_DIR_V1, 'user_template.md'), 'utf-8'),
        readFile(join(PROMPT_DIR_V1, 'output_schema.md'), 'utf-8'),
        readFile(join(PROMPT_DIR_V1, 'final_question_template.md'), 'utf-8'),
      ]);

      this.promptCache = {
        systemPrompt,
        userTemplate,
        outputSchema,
        finalQuestionTemplate,
      };

      this.logger.info('Prompts loaded and cached successfully.');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`FATAL: Failed to load prompts: ${errorMessage}`);
      throw new Error(`Failed to load prompts: ${errorMessage}`);
    }
  }

  /**
   * Рекурсивно конвертирует все Decimal в number для JSON сериализации
   */
  private safeJsonStringify(obj: unknown): string {
    const replacer = (key: string, value: unknown): unknown => {
      if (value === null || value === undefined) {
        return value;
      }

      // Проверка на Decimal (Decimal имеет поля e, s, c)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const valueAny = value as any;
      if (valueAny && typeof valueAny.e === 'number' && typeof valueAny.toNumber === 'function') {
        return valueAny.toNumber();
      }

      return value;
    };

    return JSON.stringify(obj, replacer, 2);
  }

  /**
   * Извлекает индикаторы и таймфреймы из requested_data_json
   * Поддерживает несколько форматов:
   * - JSON массив: ["adx_4h", "atr_4h"]
   * - Строка с запятыми: "adx_4h,atr_4h"
   * - Массив (если PostgreSQL вернул как массив)
   */
  private parseRequestedData(requestedDataValue: string | string[] | null): {
    indicators: string[];
    timeframes: string[];
  } {
    if (!requestedDataValue) {
      return { indicators: [], timeframes: [] };
    }

    let requested: string[] = [];

    try {
      // Если это уже массив (PostgreSQL вернул JSONB как массив)
      if (Array.isArray(requestedDataValue)) {
        requested = requestedDataValue;
      } else if (typeof requestedDataValue === 'string') {
        // Если это строка, пытаемся парсить как JSON
        try {
          const parsed = JSON.parse(requestedDataValue);
          if (Array.isArray(parsed)) {
            requested = parsed;
          } else {
            // Если не массив, возможно это строка с запятыми
            requested = requestedDataValue
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
          }
        } catch {
          // Если парсинг JSON не удался, обрабатываем как строку с запятыми
          requested = requestedDataValue
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        }
      } else {
        return { indicators: [], timeframes: [] };
      }

      const indicators = new Set<string>();
      const timeframes = new Set<string>();

      for (const item of requested) {
        // Формат: "ADX_1h" -> индикатор "ADX", таймфрейм "1h"
        if (typeof item !== 'string') {
          continue;
        }
        const parts = item.split('_');
        if (parts.length >= 2 && parts[0]) {
          const indicator = parts[0].toLowerCase();
          const timeframe = parts.slice(1).join('_').toLowerCase();
          if (indicator && timeframe) {
            indicators.add(indicator);
            timeframes.add(timeframe);
          }
        }
      }

      return {
        indicators: Array.from(indicators),
        timeframes: Array.from(timeframes),
      };
    } catch (error) {
      this.logger.warn(`Failed to parse requested_data_json: ${error}`);
      return { indicators: [], timeframes: [] };
    }
  }

  /**
   * Валидация и нормализация таймфреймов для Binance API
   * Binance поддерживает: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d, 3d, 1w, 1M
   */
  private validateAndNormalizeTimeframes(timeframes: string[]): string[] {
    const validBinanceTimeframes = new Set([
      '1m',
      '3m',
      '5m',
      '15m',
      '30m',
      '1h',
      '2h',
      '4h',
      '6h',
      '8h',
      '12h',
      '1d',
      '3d',
      '1w',
      '1M',
    ]);

    const normalized: string[] = [];

    for (const tf of timeframes) {
      if (!tf || typeof tf !== 'string') {
        continue;
      }

      // Нормализация: приводим к нижнему регистру
      const normalizedTf = tf.toLowerCase().trim();

      // Проверяем, валиден ли таймфрейм для Binance
      if (validBinanceTimeframes.has(normalizedTf)) {
        normalized.push(normalizedTf);
      } else {
        this.logger.warn(
          `Invalid timeframe "${tf}" (normalized: "${normalizedTf}") - skipping. Valid timeframes: ${Array.from(validBinanceTimeframes).join(', ')}`,
        );
      }
    }

    return normalized;
  }

  private toNumber(decimalValue: DecimalValue | null | undefined): number | null {
    if (decimalValue === null || decimalValue === undefined) {
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const decimal = decimalValue as any;
    return decimal.toNumber();
  }

  /**
   * Основной метод сборки запроса к LLM
   */
  public async buildRequest(triggeredPair: string, reason: string): Promise<LLMRequestPayload> {
    if (!this.promptCache) {
      throw new Error('LLMRequestAssemblerService not initialized. Call initialize() first.');
    }

    this.logger.info(`Building LLM request for pair: ${triggeredPair}, reason: ${reason}`);

    // Шаг A: Получение "on-demand" данных из БД
    const triggerResult = await this.databaseService.query(
      'SELECT requested_data_json FROM LLM_Triggers WHERE pair = $1',
      [triggeredPair],
    );

    // Шаг A.1: Получение последних отклоненных решений для этой пары (для обратной связи модели)
    const isRetryRequest = reason.includes('ПОВТОРНЫЙ ЗАПРОС');
    if (isRetryRequest) {
      this.logger.info(`[${triggeredPair}] 🔄 ПОВТОРНЫЙ ЗАПРОС: Запрос информации об отклоненных решениях из БД...`);
    }
    const recentRejectionsResult = await this.databaseService.query(
      `SELECT 
        id, 
        timestamp, 
        trigger_reason,
        response_payload_json,
        validator_error_message,
        worker_error_message,
        decision_result
      FROM LLM_Decision_Log 
      WHERE triggered_pair = $1 
        AND decision_result IN ('rejected_by_validator', 'failed_by_worker')
        AND timestamp > NOW() - INTERVAL '24 hours'
      ORDER BY timestamp DESC 
      LIMIT 3`,
      [triggeredPair],
    );

    interface RejectionInfo {
      timestamp: Date;
      trigger_reason: string | null;
      decisions: Array<{
        action: string;
        pair: string;
        parameters: unknown;
        justification: string;
      }>;
      error_message: string;
      decision_result: string;
    }

    const recentRejections: RejectionInfo[] = [];
    for (const row of recentRejectionsResult.rows) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const responseJson = row.response_payload_json as any;
        let decisions: Array<{
          action: string;
          pair: string;
          parameters: unknown;
          justification: string;
        }> = [];

        if (responseJson && responseJson.decisions && Array.isArray(responseJson.decisions)) {
          decisions = responseJson.decisions.map((d: unknown) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const decision = d as any;
            return {
              action: decision.action || 'UNKNOWN',
              pair: decision.pair || triggeredPair,
              parameters: decision.parameters || {},
              justification: decision.justification || '',
            };
          });
        }

        const errorMessage = row.validator_error_message || row.worker_error_message || 'Причина отклонения не указана';

        recentRejections.push({
          timestamp: row.timestamp,
          trigger_reason: row.trigger_reason,
          decisions,
          error_message: errorMessage,
          decision_result: row.decision_result,
        });
      } catch (error) {
        this.logger.warn(`Failed to parse rejection info from LLM_Decision_Log: ${error}`);
      }
    }

    if (isRetryRequest) {
      if (recentRejections.length > 0) {
        this.logger.info(
          `[${triggeredPair}] 🔄 ПОВТОРНЫЙ ЗАПРОС: Найдено ${recentRejections.length} отклоненных решений. Информация будет включена в запрос к LLM.`,
        );
        for (const rejection of recentRejections) {
          this.logger.debug(
            `[${triggeredPair}] 🔄 ПОВТОРНЫЙ ЗАПРОС: Отклонено решение ${rejection.decisions.map((d) => d.action).join(', ')}. Причина: ${rejection.error_message}`,
          );
        }
      } else {
        this.logger.warn(
          `[${triggeredPair}] 🔄 ПОВТОРНЫЙ ЗАПРОС: Не найдено отклоненных решений в БД за последние 24 часа.`,
        );
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = triggerResult.rows.length > 0 ? triggerResult.rows[0] : null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requestedDataValue = row ? ((row as any).requested_data_json as string | string[] | null) : null;
    const requestedData = this.parseRequestedData(requestedDataValue);

    // Обязательные базовые таймфреймы: 1h, 4h
    const baseTimeframes = ['1h', '4h'];
    // Валидация и нормализация таймфреймов для Binance API
    const validTimeframes = this.validateAndNormalizeTimeframes([...baseTimeframes, ...requestedData.timeframes]);
    const uniqueTimeframes = Array.from(new Set(validTimeframes));

    this.logger.debug(`Required timeframes: ${uniqueTimeframes.join(', ')}`);
    this.logger.debug(`Requested indicators: ${requestedData.indicators.join(', ')}`);

    // Шаг B: Параллельный сбор рыночных данных
    const ohlcvPromises = uniqueTimeframes.map((tf) =>
      this.marketDataService.fetchOHLCV(triggeredPair, tf, undefined, 50),
    );

    const [ohlcvResults, detailedMarketData, watchlistOverview] = await Promise.all([
      Promise.all(ohlcvPromises),
      this.marketDataService.fetchDetailedMarketData(triggeredPair, '1h', 50, 50),
      this.watchlistOverviewService.fetchWatchlistOverview(triggeredPair),
    ]);

    // Построение карты OHLCV по таймфреймам
    const ohlcvMap: Record<string, IDecimalOHLCV[]> = {};
    for (let i = 0; i < uniqueTimeframes.length; i++) {
      const timeframe = uniqueTimeframes[i];
      if (timeframe) {
        ohlcvMap[timeframe] = ohlcvResults[i] || [];
      }
    }

    // Расчет технического анализа для каждого таймфрейма
    const technicalAnalysis: Record<string, AnalysisResult> = {};
    for (const timeframe of uniqueTimeframes) {
      const ohlcv = ohlcvMap[timeframe];
      if (ohlcv && ohlcv.length > 0) {
        technicalAnalysis[`analysis_${timeframe}`] = this.taEngineService.getAnalysis(ohlcv, requestedData.indicators);
      }
    }

    // Получение текущей цены
    const orderBook = detailedMarketData.orderBook;
    const currentPrice =
      orderBook?.best_bid && orderBook?.best_ask
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ((orderBook.best_bid as any).add(orderBook.best_ask as any).div(2) as DecimalValue)
        : null;

    let finalCurrentPrice: DecimalValue;
    if (!currentPrice) {
      // Fallback: получаем цену из последнего OHLCV
      const firstTimeframeOhlcv = ohlcvResults[0];
      // Проверка на существование и непустоту массива
      const lastCandle =
        firstTimeframeOhlcv && firstTimeframeOhlcv.length > 0
          ? firstTimeframeOhlcv[firstTimeframeOhlcv.length - 1]
          : null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      finalCurrentPrice = lastCandle?.close || (new DecimalConstructor(0) as DecimalValue);
    } else {
      finalCurrentPrice = currentPrice;
    }

    // Шаг C: Компоновка JSON-объекта (синхронное получение кэшированных данных)
    const accountState = this.accountStateService.getAccountState();
    const macroContext = this.macroContextService.getContext();

    const strategyContext = this.configService.getStrategyContext();
    const riskRules = this.configService.getRiskRules();
    const watchlist = this.configService.getWatchlist();

    // Формирование market_data
    const marketData = {
      pair: triggeredPair,
      current_price: this.toNumber(finalCurrentPrice),
      order_book: detailedMarketData.orderBook
        ? {
            best_bid: this.toNumber(detailedMarketData.orderBook.best_bid),
            best_ask: this.toNumber(detailedMarketData.orderBook.best_ask),
            spread: this.toNumber(detailedMarketData.orderBook.spread),
            aggregated_bid_volume_0_5_percent: this.toNumber(
              detailedMarketData.orderBook.aggregated_bid_volume_0_5_percent,
            ),
            aggregated_ask_volume_0_5_percent: this.toNumber(
              detailedMarketData.orderBook.aggregated_ask_volume_0_5_percent,
            ),
          }
        : null,
      recent_trades: detailedMarketData.recentTrades.map((trade) => ({
        timestamp: trade.timestamp,
        price: this.toNumber(trade.price),
        amount: this.toNumber(trade.amount),
        side: trade.side,
      })),
      watchlist_overview: watchlistOverview.map((item) => ({
        pair: item.pair,
        current_price: this.toNumber(item.current_price),
        rsi_1h: this.toNumber(item.rsi_1h),
      })),
    };

    // Формирование technical_analysis (конвертация Decimal в number)
    const technicalAnalysisSerialized: Record<string, unknown> = {};
    for (const [tf, analysis] of Object.entries(technicalAnalysis)) {
      technicalAnalysisSerialized[tf] = {
        ema_50: this.toNumber(analysis.ema_50),
        ema_200: this.toNumber(analysis.ema_200),
        rsi: this.toNumber(analysis.rsi),
        macd: analysis.macd
          ? {
              macd: this.toNumber(analysis.macd.macd),
              signal: this.toNumber(analysis.macd.signal),
              histogram: this.toNumber(analysis.macd.histogram),
            }
          : null,
        bollinger: analysis.bollinger
          ? {
              upper: this.toNumber(analysis.bollinger.upper),
              middle: this.toNumber(analysis.bollinger.middle),
              lower: this.toNumber(analysis.bollinger.lower),
            }
          : null,
        key_levels: analysis.key_levels
          ? {
              period: analysis.key_levels.period,
              high: this.toNumber(analysis.key_levels.high),
              low: this.toNumber(analysis.key_levels.low),
            }
          : null,
        adx: this.toNumber(analysis.adx),
        atr: this.toNumber(analysis.atr),
        obv: this.toNumber(analysis.obv),
        vwap: this.toNumber(analysis.vwap),
        stochastic: analysis.stochastic
          ? {
              k: this.toNumber(analysis.stochastic.k),
              d: this.toNumber(analysis.stochastic.d),
            }
          : null,
      };
    }

    // Формирование account_state (конвертация Decimal в number)
    // Вычисляем максимальный размер позиции на основе доступного баланса
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const availableBalanceDecimal = accountState.available_quote_balance as any;
    const maxPositionSizeUsdt = this.toNumber(availableBalanceDecimal);

    const accountStateSerialized = {
      total_portfolio_value_usdt: this.toNumber(accountState.total_portfolio_value_usdt),
      available_quote_balance: this.toNumber(accountState.available_quote_balance),
      max_position_size_usdt: maxPositionSizeUsdt, // КРИТИЧЕСКИ ВАЖНО: Максимальный размер позиции в USDT (НЕ ПРЕВЫШАЙ!)
      assets: accountState.assets.map((asset) => ({
        asset: asset.asset,
        total: this.toNumber(asset.total),
        available: this.toNumber(asset.available),
      })),
      open_positions: accountState.open_positions.map((pos) => ({
        pair: pos.pair,
        side: pos.side,
        amount: this.toNumber(pos.amount),
        average_entry_price: this.toNumber(pos.average_entry_price),
        stop_loss_price: this.toNumber(pos.stop_loss_price),
      })),
      open_orders: accountState.open_orders,
    };

    // Логируем критически важную информацию о балансе для отладки
    this.logger.debug(
      `[${triggeredPair}] Account state for LLM: available_balance=${accountStateSerialized.available_quote_balance}, max_position_size_usdt=${accountStateSerialized.max_position_size_usdt}`,
    );

    // Формирование strategy_context
    const strategyContextSerialized = {
      role: strategyContext.role,
      style: strategyContext.style,
      risk_rules: {
        default_risk_per_trade_percent: riskRules.defaultRiskPercent,
        max_allowed_risk_per_trade_percent: riskRules.maxAllowedRiskPercent,
        max_total_portfolio_risk_percent: riskRules.maxTotalPortfolioRiskPercent,
        desired_risk_reward_ratio: riskRules.desiredRiskRewardRatio,
      },
      macro_context:
        macroContext.fear_and_greed_index !== null
          ? {
              fear_and_greed_index: macroContext.fear_and_greed_index,
              fear_and_greed_text: macroContext.fear_and_greed_text || '',
            }
          : undefined,
      watchlist,
    };

    // Формирование финального JSON запроса
    const llmRequestData = {
      strategy_context: strategyContextSerialized,
      triggered_pair: triggeredPair,
      market_data: marketData,
      technical_analysis: technicalAnalysisSerialized,
      account_state: accountStateSerialized,
      question: '', // Будет заполнен в шаблоне
    };

    // Шаг D: Сборка финального промпта
    const userPrompt = this._buildUserPrompt(llmRequestData, triggeredPair, reason, macroContext, recentRejections);

    return {
      system_prompt: this.promptCache.systemPrompt,
      user_prompt: userPrompt,
    };
  }

  /**
   * Сборка user prompt из шаблона
   */
  private _buildUserPrompt(
    llmRequestData: unknown,
    triggeredPair: string,
    reason: string,
    macroContext: { fear_and_greed_index: number | null; fear_and_greed_text: string | null },
    recentRejections: Array<{
      timestamp: Date;
      trigger_reason: string | null;
      decisions: Array<{
        action: string;
        pair: string;
        parameters: unknown;
        justification: string;
      }>;
      error_message: string;
      decision_result: string;
    }>,
  ): string {
    if (!this.promptCache) {
      throw new Error('Prompt cache not initialized');
    }

    // Сначала заменяем OUTPUT_SCHEMA
    let userPrompt = this.promptCache.userTemplate.replace('{{OUTPUT_SCHEMA_MD}}', this.promptCache.outputSchema);

    // Заменяем остальные плейсхолдеры
    userPrompt = userPrompt.replace('{{TRIGGERED_PAIR}}', triggeredPair);

    // Формируем информацию об отклоненных решениях
    let rejectionInfoText = '';
    if (recentRejections.length > 0) {
      rejectionInfoText = '\n\n## ⚠️ ВАЖНО: История отклоненных решений\n\n';
      rejectionInfoText +=
        'Ниже приведены твои последние решения, которые были отклонены валидатором или не выполнены. ';
      rejectionInfoText += 'Изучи причины отклонения и скорректируй новое решение, чтобы избежать тех же ошибок.\n\n';

      for (const rejection of recentRejections) {
        const timestamp = new Date(rejection.timestamp).toLocaleString('ru-RU');
        rejectionInfoText += `**Отклонено:** ${timestamp}\n`;
        rejectionInfoText += `**Причина вызова:** ${rejection.trigger_reason || 'не указана'}\n`;
        rejectionInfoText += `**Статус:** ${rejection.decision_result}\n\n`;

        if (rejection.decisions.length > 0) {
          rejectionInfoText += '**Твои решения, которые были отклонены:**\n';
          for (const decision of rejection.decisions) {
            rejectionInfoText += `- **Действие:** ${decision.action} (${decision.pair})\n`;
            if (decision.justification) {
              rejectionInfoText += `  **Обоснование:** ${decision.justification}\n`;
            }
            // Показываем ключевые параметры
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const params = decision.parameters as any;
            if (params) {
              const paramParts: string[] = [];
              if (params.risk_percent) paramParts.push(`risk_percent: ${params.risk_percent}`);
              if (params.stop_loss_price) paramParts.push(`stop_loss_price: ${params.stop_loss_price}`);
              if (params.take_profit_price) paramParts.push(`take_profit_price: ${params.take_profit_price}`);
              if (params.amount_percent) paramParts.push(`amount_percent: ${params.amount_percent}`);
              if (paramParts.length > 0) {
                rejectionInfoText += `  **Параметры:** ${paramParts.join(', ')}\n`;
              }
            }
            rejectionInfoText += '\n';
          }
        }

        rejectionInfoText += `**Причина отклонения:** ${rejection.error_message}\n\n`;
        rejectionInfoText += '---\n\n';
      }

      rejectionInfoText += '**Помни:** При принятии нового решения учитывай причины предыдущих отклонений. ';
      rejectionInfoText +=
        'Если решение было отклонено из-за превышения баланса, уменьши `risk_percent` или увеличь дистанцию до стопа. ';
      rejectionInfoText +=
        'Если решение было отклонено из-за других причин (например, некорректные параметры), исправь эти параметры в новом решении.\n\n';
    }

    // Формируем FINAL_QUESTION из шаблона с подстановкой значений
    let finalQuestion = this.promptCache.finalQuestionTemplate
      .replace(/{{TRIGGERED_PAIR}}/g, triggeredPair)
      .replace(/{{TRIGGER_REASON}}/g, reason)
      .replace(/{{MACRO_TEXT}}/g, macroContext.fear_and_greed_text || 'N/A')
      .replace(/{{MACRO_VALUE}}/g, macroContext.fear_and_greed_index?.toString() || 'N/A');

    // Добавляем информацию об отклонениях перед финальным вопросом
    if (rejectionInfoText) {
      finalQuestion = rejectionInfoText + finalQuestion;
    }

    userPrompt = userPrompt.replace('{{FINAL_QUESTION}}', finalQuestion);

    // Сериализуем JSON данные
    const strategyContextJson = this.safeJsonStringify(llmRequestData);
    userPrompt = userPrompt.replace('{{STRATEGY_CONTEXT}}', strategyContextJson);

    // Формируем отдельные JSON строки для каждого раздела
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const llmRequestDataAny = llmRequestData as any;
    const marketDataJson = this.safeJsonStringify(llmRequestDataAny.market_data);
    const technicalAnalysisJson = this.safeJsonStringify(llmRequestDataAny.technical_analysis);
    const accountStateJson = this.safeJsonStringify(llmRequestDataAny.account_state);

    userPrompt = userPrompt.replace('{{MARKET_DATA_JSON}}', marketDataJson);
    userPrompt = userPrompt.replace('{{TECHNICAL_ANALYSIS_JSON}}', technicalAnalysisJson);
    userPrompt = userPrompt.replace('{{ACCOUNT_STATE_JSON}}', accountStateJson);

    return userPrompt;
  }
}
