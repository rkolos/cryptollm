import TelegramBot from 'node-telegram-bot-api';
import { ConfigService } from './ConfigService.js';
import { LoggingService } from './LoggingService.js';
import { AccountStateService } from './AccountStateService.js';
import { DatabaseService } from './DatabaseService.js';
import { ExchangeRulesService } from './ExchangeRulesService.js';
import Decimal from 'decimal.js';
import type { AccountState } from '../interfaces/IValidatorTypes.js';
import type winston from 'winston';
import type { DecimalValue } from '../interfaces/IValidatorTypes.js';
import type { IExchangeService } from '../interfaces/IExchangeService.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DecimalConstructor = Decimal as any;

/**
 * NotificationService - Singleton для отправки PUSH-уведомлений через Telegram
 */
export class NotificationService {
  private static instance: NotificationService | undefined;
  private readonly logger: winston.Logger;
  private readonly configService: ConfigService;
  private accountStateService: AccountStateService | null = null;
  private databaseService: DatabaseService | null = null;
  private exchangeService: IExchangeService | null = null;
  private exchangeRulesService: ExchangeRulesService | null = null;
  private bot: TelegramBot | null = null;
  private chatId: string | null = null;
  private isEnabled: boolean = false;
  private readonly messageQueue: Array<() => Promise<void>> = [];
  private isProcessingQueue: boolean = false;
  private lastMessageTime: number = 0;
  private readonly minDelayBetweenMessages: number = 2000; // Минимум 2 секунды между сообщениями

  private constructor(configService: ConfigService) {
    this.configService = configService;
    this.logger = LoggingService.getInstance().getLogger('Notification');
    this.logger.info('NotificationService initialized.');

    const telegramConfig = configService.getTelegramConfig();
    const token = telegramConfig.botToken;
    const chatId = telegramConfig.chatId;

    if (token && chatId) {
      this.isEnabled = true;
      this.chatId = chatId;
      try {
        this.bot = new TelegramBot(token, { polling: false });
        this.logger.info('Telegram bot initialized. Notifications enabled.');
        // Запускаем обработчик очереди
        this.processQueue().catch((error) => {
          this.logger.error('Error in processQueue:', error);
        });
      } catch (error) {
        this.logger.error('Failed to initialize Telegram bot:', error);
        this.isEnabled = false;
      }
    } else {
      this.isEnabled = false;
      this.logger.warn('Сервис уведомлений отключен: TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID не установлены.');
    }
  }

  public static getInstance(configService: ConfigService): NotificationService {
    if (!NotificationService.instance) {
      NotificationService.instance = new NotificationService(configService);
    }
    return NotificationService.instance;
  }

  /**
   * Инъекция AccountStateService (разрыв циклической зависимости)
   */
  public injectAccountStateService(accountStateService: AccountStateService): void {
    this.accountStateService = accountStateService;
    this.logger.debug('AccountStateService injected.');
  }

  /**
   * Инъекция DatabaseService (для получения торговой статистики)
   */
  public injectDatabaseService(databaseService: DatabaseService): void {
    this.databaseService = databaseService;
    this.logger.debug('DatabaseService injected.');
  }

  /**
   * Инъекция ExchangeService (для получения текущих цен)
   */
  public injectExchangeService(exchangeService: IExchangeService): void {
    this.exchangeService = exchangeService;
    this.logger.debug('ExchangeService injected.');
  }

  /**
   * Инъекция ExchangeRulesService (для получения комиссий биржи)
   */
  public injectExchangeRulesService(exchangeRulesService: ExchangeRulesService): void {
    this.exchangeRulesService = exchangeRulesService;
    this.logger.debug('ExchangeRulesService injected.');
  }

  /**
   * Ограничение длины текста с добавлением индикатора обрезки
   */
  private _truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }
    // Обрезаем с учетом места для индикатора
    const truncated = text.substring(0, maxLength - 20);
    // Находим последний пробел для красивого обрезания
    const lastSpace = truncated.lastIndexOf(' ');
    const cutPoint = lastSpace > maxLength * 0.8 ? lastSpace : truncated.length;
    // НЕ экранируем здесь - экранирование будет выполнено позже в _escapeMarkdown
    return `${text.substring(0, cutPoint)}...\n(сообщение обрезано)`;
  }

  /**
   * Разбиение длинного сообщения на части для отправки в Telegram
   * Telegram лимит: 4096 символов
   */
  private _splitMessage(message: string, maxLength: number = 4000): string[] {
    if (message.length <= maxLength) {
      return [message];
    }

    const parts: string[] = [];
    let currentPart = '';
    const lines = message.split('\n');

    for (const line of lines) {
      // Если одна строка слишком длинная, разбиваем её
      if (line.length > maxLength) {
        // Сохраняем текущую часть, если она не пустая
        if (currentPart) {
          parts.push(currentPart.trim());
          currentPart = '';
        }
        // Разбиваем длинную строку на части
        const words = line.split(' ');
        for (const word of words) {
          if ((currentPart + word).length > maxLength - 50) {
            if (currentPart) {
              parts.push(currentPart.trim());
              currentPart = '';
            }
          }
          currentPart += (currentPart ? ' ' : '') + word;
        }
        currentPart += '\n';
      } else {
        // Проверяем, поместится ли строка в текущую часть
        if ((currentPart + line).length > maxLength) {
          parts.push(currentPart.trim());
          currentPart = line + '\n';
        } else {
          currentPart += line + '\n';
        }
      }
    }

    // Добавляем последнюю часть
    if (currentPart.trim()) {
      parts.push(currentPart.trim());
    }

    return parts;
  }

  /**
   * Отправка уведомления (синхронный метод, добавляет задачу в очередь)
   */
  public sendAlert(message: string, includeAccountState: boolean = false): void {
    if (!this.isEnabled) {
      return;
    }

    // Создаем асинхронную задачу для отправки
    const task = async (): Promise<void> => {
      try {
        // Ограничиваем длину обоснования LLM, если оно присутствует
        let processedMessage = message;
        if (message.includes('🤖 Обоснование LLM:')) {
          const parts = message.split('🤖 Обоснование LLM:');
          if (parts.length === 2 && parts[1]) {
            const header = parts[0] + '🤖 Обоснование LLM:';
            const justification = parts[1];
            // Ограничиваем обоснование до 2000 символов
            const truncatedJustification = this._truncateText(justification, 2000);
            processedMessage = header + truncatedJustification;
          }
        }

        let fullMessage = this._escapeMarkdown(processedMessage);
        let useHtmlMode = false;

        if (includeAccountState && this.accountStateService) {
          const accountState = this.accountStateService.getAccountState();
          const accountStateText = await this._formatAccountState(accountState);
          fullMessage = `${fullMessage}\n\n${accountStateText}`;
          useHtmlMode = true; // Используем HTML для сообщений с AccountState
        }

        // Разбиваем сообщение на части, если оно слишком длинное
        const messageParts = this._splitMessage(fullMessage);

        if (this.bot && this.chatId) {
          for (let i = 0; i < messageParts.length; i++) {
            const part = messageParts[i];
            // Экранируем partNumber отдельно для безопасности
            const partNumber =
              messageParts.length > 1
                ? ` ${useHtmlMode ? this._escapeHtml(`(часть ${i + 1}/${messageParts.length})`) : this._escapeMarkdown(`(часть ${i + 1}/${messageParts.length})`)}`
                : '';
            await this._sendMessageWithRetry(this.chatId, part + partNumber, {
              parse_mode: useHtmlMode ? 'HTML' : 'MarkdownV2',
            });
            // Небольшая задержка между частями
            if (i < messageParts.length - 1) {
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
          }
          this.logger.debug(`Notification sent successfully (${messageParts.length} part(s)).`);
        }
      } catch (error) {
        this.logger.error('Error sending notification:', error);
        // Не бросаем ошибку, чтобы не "убить" очередь
      }
    };

    // Добавляем задачу в очередь
    this.messageQueue.push(task);

    // Запускаем обработчик очереди (если он не запущен)
    this.processQueue().catch((error) => {
      this.logger.error('Error starting processQueue:', error);
    });
  }

  /**
   * Извлечение времени ожидания из ошибки Telegram API (429 Too Many Requests)
   */
  private _extractRetryAfter(error: unknown): number {
    // Пытаемся извлечь retry_after из различных мест структуры ошибки
    if (error && typeof error === 'object') {
      // Вариант 1: response.body.parameters.retry_after
      if ('response' in error) {
        const response = (error as { response?: { body?: { parameters?: { retry_after?: number } } } }).response;
        if (response?.body?.parameters?.retry_after) {
          return response.body.parameters.retry_after * 1000; // Конвертируем секунды в миллисекунды
        }
      }

      // Вариант 2: response.parameters.retry_after
      if ('response' in error) {
        const response = (error as { response?: { parameters?: { retry_after?: number } } }).response;
        if (response?.parameters?.retry_after) {
          return response.parameters.retry_after * 1000;
        }
      }

      // Вариант 3: Извлекаем из текста сообщения "retry after X"
      if ('message' in error && typeof (error as { message?: string }).message === 'string') {
        const message = (error as { message: string }).message;
        const match = message.match(/retry after (\d+)/i);
        if (match && match[1]) {
          const seconds = parseInt(match[1], 10);
          if (!isNaN(seconds)) {
            return seconds * 1000;
          }
        }
      }
    }
    // Если не удалось извлечь время, используем стандартную задержку
    return this.minDelayBetweenMessages * 2; // 4 секунды по умолчанию
  }

  /**
   * Отправка сообщения с обработкой ошибок rate limiting
   */
  private async _sendMessageWithRetry(
    chatId: string,
    text: string,
    options: { parse_mode?: 'MarkdownV2' | 'HTML' | 'Markdown' },
  ): Promise<void> {
    const maxRetries = 3;
    let retryCount = 0;

    while (retryCount < maxRetries) {
      try {
        // Убеждаемся, что прошло достаточно времени с последнего сообщения
        const timeSinceLastMessage = Date.now() - this.lastMessageTime;
        if (timeSinceLastMessage < this.minDelayBetweenMessages) {
          const waitTime = this.minDelayBetweenMessages - timeSinceLastMessage;
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }

        await this.bot!.sendMessage(chatId, text, options);
        this.lastMessageTime = Date.now();
        return; // Успешно отправлено
      } catch (error) {
        // Проверяем, является ли это ошибкой rate limiting
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          (error as { code?: string }).code === 'ETELEGRAM' &&
          'response' in error
        ) {
          const response = (error as { response?: { statusCode?: number } }).response;
          if (response?.statusCode === 429) {
            const retryAfter = this._extractRetryAfter(error);
            this.logger.warn(
              `Telegram rate limit hit. Waiting ${retryAfter / 1000} seconds before retry (attempt ${retryCount + 1}/${maxRetries})`,
            );
            await new Promise((resolve) => setTimeout(resolve, retryAfter));
            retryCount++;
            continue;
          }
        }

        // Для других ошибок пробрасываем исключение
        throw error;
      }
    }

    // Если все попытки исчерпаны, логируем ошибку
    this.logger.error('Failed to send message after all retries due to rate limiting');
  }

  /**
   * Обработка очереди сообщений (отправка по одному с задержкой)
   */
  private async processQueue(): Promise<void> {
    // Предотвращаем параллельный запуск
    if (this.isProcessingQueue) {
      return;
    }

    this.isProcessingQueue = true;

    try {
      while (this.messageQueue.length > 0) {
        const task = this.messageQueue.shift();
        if (!task) {
          continue;
        }

        try {
          await task();
        } catch (error) {
          this.logger.error('Error processing queue task:', error);
          // Продолжаем обработку других задач
        }

        // Пауза для избежания Rate Limit (минимум 2 секунды между сообщениями)
        if (this.messageQueue.length > 0) {
          const timeSinceLastMessage = Date.now() - this.lastMessageTime;
          if (timeSinceLastMessage < this.minDelayBetweenMessages) {
            const waitTime = this.minDelayBetweenMessages - timeSinceLastMessage;
            await new Promise((resolve) => setTimeout(resolve, waitTime));
          }
        }
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  /**
   * Форматирование состояния портфеля для Telegram (HTML для поддержки цветов)
   */
  private async _formatAccountState(state: AccountState): Promise<string> {
    const lines: string[] = [];

    // Заголовок
    lines.push('<b>📊 Состояние портфеля:</b>');

    // Общая стоимость
    const totalValue = this._escapeHtml(state.total_portfolio_value_usdt.toString());
    lines.push(`<b>Total Value:</b> <code>${totalValue}</code> USDT`);

    // Доступный баланс
    const availableBalance = this._escapeHtml(state.available_quote_balance.toString());
    lines.push(`<b>Available:</b> <code>${availableBalance}</code> USDT`);

    // Балансы только отслеживаемых валют из watchlist
    const watchlist = this.configService.getWatchlist();
    // Извлекаем базовые валюты из пар (например, BTC из BTC/USDT)
    const trackedCurrencies = new Set<string>();
    for (const pair of watchlist) {
      const baseCurrency = pair.split('/')[0];
      if (baseCurrency) {
        trackedCurrencies.add(baseCurrency);
      }
    }

    // Фильтруем assets, оставляя только отслеживаемые валюты
    const trackedAssets = state.assets.filter((asset) => trackedCurrencies.has(asset.asset));

    if (trackedAssets.length > 0) {
      lines.push(`\n<b>Валюты на счете (отслеживаемые):</b>`);
      for (const asset of trackedAssets) {
        const assetName = this._escapeHtml(asset.asset);
        const total = this._escapeHtml(asset.total.toString());
        const available = this._escapeHtml(asset.available.toString());
        lines.push(`  • ${assetName}: <code>${total}</code> (доступно: <code>${available}</code>)`);
      }
    } else {
      lines.push(`\n<b>Валюты на счете:</b> нет отслеживаемых валют`);
    }

    // Открытые позиции
    if (state.open_positions.length > 0) {
      lines.push(`\n<b>Позиции (${state.open_positions.length}):</b>`);

      // Получаем данные о комиссиях из БД параллельно
      const positionsWithFees = await Promise.all(
        state.open_positions.map(async (position) => {
          let entryFeeCost = new DecimalConstructor(0);
          if (this.databaseService) {
            try {
              const feeResult = await this.databaseService.query(
                'SELECT total_fee_cost FROM ActivePositions WHERE pair = $1',
                [position.pair],
              );
              if (feeResult.rows && feeResult.rows.length > 0) {
                entryFeeCost = new DecimalConstructor(feeResult.rows[0].total_fee_cost || '0');
              }
            } catch (error) {
              this.logger.warn(`Не удалось получить комиссию для позиции ${position.pair}:`, error);
            }
          }
          return { position, entryFeeCost };
        }),
      );

      // Получаем текущие цены и рассчитываем PnL для каждой позиции
      for (const { position, entryFeeCost } of positionsWithFees) {
        const pair = this._escapeHtml(position.pair);
        const side = this._escapeHtml(position.side);
        const amount = this._escapeHtml(position.amount.toString());
        const entryPrice = this._escapeHtml(position.average_entry_price.toString());

        let pnlText = '';

        if (this.exchangeService && this.exchangeRulesService) {
          try {
            // Получаем текущую цену
            const ticker = await this.exchangeService.fetchTicker(position.pair);
            const currentPrice = ticker.last;

            // Получаем комиссию биржи
            const rules = this.exchangeRulesService.getRules(position.pair);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const takerFee = rules.takerFee as any;

            // Рассчитываем комиссию при закрытии
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const amountDecimal = position.amount as any;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const currentPriceDecimal = currentPrice as any;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const entryPriceDecimal = position.average_entry_price as any;

            // Стоимость позиции при закрытии
            const closeValue = amountDecimal.mul(currentPriceDecimal);
            // Комиссия при закрытии
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const closeFee = closeValue.mul(takerFee) as any;

            // Пропорциональная часть комиссии при входе
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const entryFeeCostDecimal = entryFeeCost as any;

            // Рассчитываем unrealized PnL
            let unrealizedPnl: DecimalValue;
            if (position.side === 'long') {
              // Для LONG: PnL = (current_price - entry_price) * amount - entry_fee - close_fee
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const priceDiff = currentPriceDecimal.minus(entryPriceDecimal);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const grossPnl = priceDiff.mul(amountDecimal);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const totalFees = entryFeeCostDecimal.plus(closeFee);
              unrealizedPnl = grossPnl.minus(totalFees) as DecimalValue;
            } else {
              // Для SHORT: PnL = (entry_price - current_price) * amount - entry_fee - close_fee
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const priceDiff = entryPriceDecimal.minus(currentPriceDecimal);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const grossPnl = priceDiff.mul(amountDecimal);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const totalFees = entryFeeCostDecimal.plus(closeFee);
              unrealizedPnl = grossPnl.minus(totalFees) as DecimalValue;
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const pnlDecimal = unrealizedPnl as any;
            const pnlValue = pnlDecimal.toFixed(2);

            // Определяем цвет и форматирование (Telegram HTML не поддерживает inline стили)
            // Используем эмодзи и жирный текст для визуального различия
            if (pnlDecimal.gte(0)) {
              pnlText = ` <b>✅ +${this._escapeHtml(pnlValue)} USDT</b>`;
            } else {
              pnlText = ` <b>❌ ${this._escapeHtml(pnlValue)} USDT</b>`;
            }
          } catch (error) {
            this.logger.warn(`Не удалось рассчитать PnL для позиции ${position.pair}:`, error);
            pnlText = ' (PnL недоступен)';
          }
        }

        lines.push(`  • ${pair} (${side}): <code>${amount}</code> @ <code>${entryPrice}</code>${pnlText}`);
      }
    }

    // Открытые ордера
    if (state.open_orders.length > 0) {
      lines.push(`\n<b>Ордера (${state.open_orders.length}):</b>`);
      for (const order of state.open_orders) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const orderTyped = order as any;
        const pair = this._escapeHtml(orderTyped.pair || '');
        const type = this._escapeHtml(orderTyped.type || '');
        lines.push(`  • ${pair}: <code>${type}</code>`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Отправка сводной информации о торговле после сделки
   */
  public sendTradingSummary(action: string, pair: string, justification: string): void {
    if (!this.isEnabled) {
      return;
    }

    const task = async (): Promise<void> => {
      try {
        // Получаем статистику из БД
        const summary = await this._getTradingSummary();
        const summaryText = this._formatTradingSummary(summary);

        // Формируем сообщение с обоснованием LLM
        const actionEscaped = this._escapeMarkdown(action);
        const pairEscaped = this._escapeMarkdown(pair);
        // Ограничиваем длину обоснования до 2000 символов
        const truncatedJustification = this._truncateText(justification, 2000);
        const justificationEscaped = this._escapeMarkdown(truncatedJustification);

        let message = `*✅ СДЕЛКА ИСПОЛНЕНА:*\n`;
        message += `*Действие:* ${actionEscaped}\n`;
        message += `*Пара:* ${pairEscaped}\n\n`;
        message += `*🤖 Обоснование LLM:*\n${justificationEscaped}\n\n`;
        message += summaryText;

        // Разбиваем сообщение на части, если оно слишком длинное
        const messageParts = this._splitMessage(message);

        if (this.bot && this.chatId) {
          for (let i = 0; i < messageParts.length; i++) {
            const part = messageParts[i];
            // Экранируем partNumber отдельно для безопасности
            const partNumber =
              messageParts.length > 1 ? ` ${this._escapeMarkdown(`(часть ${i + 1}/${messageParts.length})`)}` : '';
            await this._sendMessageWithRetry(this.chatId, part + partNumber, {
              parse_mode: 'MarkdownV2',
            });
            // Небольшая задержка между частями
            if (i < messageParts.length - 1) {
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
          }
          this.logger.debug(`Trading summary sent successfully (${messageParts.length} part(s)).`);
        }
      } catch (error) {
        this.logger.error('Error sending trading summary:', error);
        // Не бросаем ошибку, чтобы не "убить" очередь
      }
    };

    this.messageQueue.push(task);
    this.processQueue().catch((error) => {
      this.logger.error('Error starting processQueue:', error);
    });
  }

  /**
   * Получение торговой статистики из БД
   */
  private async _getTradingSummary(): Promise<{
    totalTrades: number;
    closedPositions: number;
    totalRealizedPnl: DecimalValue;
    totalFees: DecimalValue;
    winRate: number;
    avgWin: DecimalValue;
    avgLoss: DecimalValue;
  }> {
    if (!this.databaseService) {
      throw new Error('DatabaseService not injected');
    }

    try {
      // Оптимизированный запрос: объединяем все 3 запроса в один для улучшения производительности
      const summaryResult = await this.databaseService.query(
        `SELECT 
          COUNT(*) as total_trades,
          COUNT(CASE WHEN realized_pnl_usd IS NOT NULL THEN 1 END) as total_closed,
          COALESCE(SUM(CASE WHEN realized_pnl_usd IS NOT NULL THEN realized_pnl_usd ELSE 0 END), 0) as total_pnl,
          COALESCE(SUM(CASE WHEN realized_pnl_usd > 0 THEN 1 ELSE 0 END), 0) as wins,
          COALESCE(SUM(CASE WHEN realized_pnl_usd < 0 THEN 1 ELSE 0 END), 0) as losses,
          COALESCE(AVG(CASE WHEN realized_pnl_usd > 0 THEN realized_pnl_usd END), 0) as avg_win,
          COALESCE(AVG(CASE WHEN realized_pnl_usd < 0 THEN realized_pnl_usd END), 0) as avg_loss,
          COALESCE(SUM(CASE WHEN realized_pnl_usd IS NOT NULL THEN fee_cost ELSE 0 END), 0) as total_fees
        FROM TradeHistory`,
      );

      if (!summaryResult.rows || summaryResult.rows.length === 0) {
        this.logger.warn('Empty result from trading summary query. Returning zero statistics.');
        return {
          totalTrades: 0,
          closedPositions: 0,
          totalRealizedPnl: new DecimalConstructor('0') as DecimalValue,
          totalFees: new DecimalConstructor('0') as DecimalValue,
          winRate: 0,
          avgWin: new DecimalConstructor('0') as DecimalValue,
          avgLoss: new DecimalConstructor('0') as DecimalValue,
        };
      }

      const summaryRow = summaryResult.rows[0];
      const totalTrades = parseInt(summaryRow.total_trades || '0', 10);
      const closedPositions = parseInt(summaryRow.total_closed || '0', 10);
      const wins = parseInt(summaryRow.wins || '0', 10);
      const losses = parseInt(summaryRow.losses || '0', 10);
      const totalRealizedPnl = new DecimalConstructor(summaryRow.total_pnl || '0') as DecimalValue;
      const totalFees = new DecimalConstructor(summaryRow.total_fees || '0') as DecimalValue;
      const avgWin =
        closedPositions > 0 && wins > 0
          ? (new DecimalConstructor(summaryRow.avg_win || '0') as DecimalValue)
          : (new DecimalConstructor('0') as DecimalValue);
      const avgLoss =
        closedPositions > 0 && losses > 0
          ? (new DecimalConstructor(summaryRow.avg_loss || '0') as DecimalValue)
          : (new DecimalConstructor('0') as DecimalValue);
      const winRate = closedPositions > 0 ? (wins / closedPositions) * 100 : 0;

      return {
        totalTrades,
        closedPositions,
        totalRealizedPnl,
        totalFees,
        winRate,
        avgWin,
        avgLoss,
      };
    } catch (error) {
      this.logger.error('Error getting trading summary:', error);
      // Возвращаем пустую статистику при ошибке
      return {
        totalTrades: 0,
        closedPositions: 0,
        totalRealizedPnl: new DecimalConstructor('0') as DecimalValue,
        totalFees: new DecimalConstructor('0') as DecimalValue,
        winRate: 0,
        avgWin: new DecimalConstructor('0') as DecimalValue,
        avgLoss: new DecimalConstructor('0') as DecimalValue,
      };
    }
  }

  /**
   * Форматирование торговой статистики для Telegram (MarkdownV2)
   */
  private _formatTradingSummary(summary: {
    totalTrades: number;
    closedPositions: number;
    totalRealizedPnl: DecimalValue;
    totalFees: DecimalValue;
    winRate: number;
    avgWin: DecimalValue;
    avgLoss: DecimalValue;
  }): string {
    const lines: string[] = [];

    lines.push('*📈 Сводка торговли:*\n');

    // Общая статистика
    const totalTradesEscaped = this._escapeMarkdown(summary.totalTrades.toString());
    const closedPositionsEscaped = this._escapeMarkdown(summary.closedPositions.toString());
    lines.push(`*Всего сделок:* ${totalTradesEscaped}`);
    lines.push(`*Закрытых позиций:* ${closedPositionsEscaped}`);

    // PnL
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const totalPnlDecimal = summary.totalRealizedPnl as any;
    const totalPnlValue = totalPnlDecimal.toFixed(2);
    const totalPnlEscaped = this._escapeMarkdown(totalPnlValue);
    const pnlSign = totalPnlDecimal.gte(0) ? '✅' : '❌';
    lines.push(`*Общий P\\&L:* ${pnlSign} \`${totalPnlEscaped}\` USDT`);

    // Комиссии
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const totalFeesDecimal = summary.totalFees as any;
    const totalFeesEscaped = this._escapeMarkdown(totalFeesDecimal.toFixed(2));
    lines.push(`*Общие комиссии:* \`${totalFeesEscaped}\` USDT`);

    // Win Rate
    if (summary.closedPositions > 0) {
      const winRateEscaped = this._escapeMarkdown(summary.winRate.toFixed(2));
      lines.push(`*Win Rate:* \`${winRateEscaped}\`%`);

      // Средний профит/убыток
      if (summary.avgWin.gt(0)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const avgWinDecimal = summary.avgWin as any;
        const avgWinEscaped = this._escapeMarkdown(avgWinDecimal.toFixed(2));
        lines.push(`*Средний профит:* \`${avgWinEscaped}\` USDT`);
      }
      if (summary.avgLoss.lt(0)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const avgLossDecimal = summary.avgLoss as any;
        const avgLossEscaped = this._escapeMarkdown(avgLossDecimal.abs().toFixed(2));
        lines.push(`*Средний убыток:* \`${avgLossEscaped}\` USDT`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Отправка уведомления об установке/обновлении триггеров
   */
  public sendTriggersUpdate(
    pair: string,
    reason: string,
    triggerConditions: Array<{
      type: string;
      condition: string;
      value: number;
      name?: string;
      timeframe?: string;
    }>,
    requestedData: string[] | null,
    updatedAt: Date,
  ): void {
    if (!this.isEnabled) {
      return;
    }

    const task = async (): Promise<void> => {
      try {
        const message = this._formatTriggersUpdate(pair, reason, triggerConditions, requestedData, updatedAt);

        // Разбиваем сообщение на части, если оно слишком длинное
        const messageParts = this._splitMessage(message);

        if (this.bot && this.chatId) {
          for (let i = 0; i < messageParts.length; i++) {
            const part = messageParts[i];
            // Экранируем partNumber отдельно для безопасности
            const partNumber =
              messageParts.length > 1 ? ` ${this._escapeMarkdown(`(часть ${i + 1}/${messageParts.length})`)}` : '';
            await this._sendMessageWithRetry(this.chatId, part + partNumber, {
              parse_mode: 'MarkdownV2',
            });
            // Небольшая задержка между частями
            if (i < messageParts.length - 1) {
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
          }
          this.logger.debug(`Triggers update notification sent successfully (${messageParts.length} part(s)).`);
        }
      } catch (error) {
        this.logger.error('Error sending triggers update notification:', error);
      }
    };

    this.messageQueue.push(task);
    this.processQueue();
  }

  /**
   * Форматирование уведомления о триггерах для Telegram (MarkdownV2)
   */
  private _formatTriggersUpdate(
    pair: string,
    reason: string,
    triggerConditions: Array<{
      type: string;
      condition: string;
      value: number;
      name?: string;
      timeframe?: string;
    }>,
    requestedData: string[] | null,
    updatedAt: Date,
  ): string {
    const lines: string[] = [];

    // Заголовок
    lines.push(`*🔔 ТРИГГЕРЫ ОБНОВЛЕНЫ:*`);
    lines.push('');

    // Пара
    const pairEscaped = this._escapeMarkdown(pair);
    lines.push(`*Пара:* ${pairEscaped}`);

    // Причина
    const reasonEscaped = this._escapeMarkdown(reason);
    lines.push(`*Причина:* ${reasonEscaped}`);

    // Время обновления
    const updatedAtStr = updatedAt.toLocaleString('ru-RU');
    const updatedAtEscaped = this._escapeMarkdown(updatedAtStr);
    lines.push(`*Обновлено:* ${updatedAtEscaped}`);
    lines.push('');

    // Условия триггеров
    lines.push(`*Условия триггеров \\(${triggerConditions.length}\\):*`);
    for (let i = 0; i < triggerConditions.length; i++) {
      const condition = triggerConditions[i];
      if (!condition) {
        continue;
      }

      const type = this._escapeMarkdown(condition.type);
      const conditionStr = condition.condition ? this._escapeMarkdown(condition.condition) : '';

      let displayValue = condition.value.toString();
      if (condition.type === 'timeout' && condition.condition === 'minutes_passed') {
        // Для timeout триггеров показываем минуты и время до срабатывания
        const updatedAtTime = updatedAt.getTime();
        const minutesPassed = Math.floor((Date.now() - updatedAtTime) / 60000);
        const requiredMinutes = condition.value;
        const remainingMinutes = requiredMinutes - minutesPassed;
        if (remainingMinutes <= 0) {
          displayValue = `${condition.value} минут (ПРОСРОЧЕН на ${Math.abs(remainingMinutes)} мин)`;
        } else {
          displayValue = `${condition.value} минут (осталось ${remainingMinutes} мин до срабатывания)`;
        }
      } else if (condition.type === 'price') {
        // Для price триггеров показываем цену
        displayValue = condition.value.toString();
      } else if (condition.type === 'indicator') {
        // Для indicator триггеров показываем значение индикатора
        displayValue = condition.value.toString();
      }

      const valueEscaped = this._escapeMarkdown(displayValue);
      lines.push(`  ${i + 1}\\. *Тип:* ${type}`);

      if (conditionStr) {
        lines.push(`     *Условие:* ${conditionStr}`);
      }

      if (condition.name) {
        const nameEscaped = this._escapeMarkdown(condition.name);
        lines.push(`     *Индикатор:* ${nameEscaped}`);
      }

      if (condition.timeframe) {
        const timeframeEscaped = this._escapeMarkdown(condition.timeframe);
        lines.push(`     *Таймфрейм:* ${timeframeEscaped}`);
      }

      lines.push(`     *Значение:* \`${valueEscaped}\``);
      lines.push('');
    }

    // Запрошенные данные
    if (requestedData && requestedData.length > 0) {
      const requestedDataEscaped = requestedData.map((item) => this._escapeMarkdown(item)).join(', ');
      lines.push(`*Запрошенные данные:* ${requestedDataEscaped}`);
    }

    return lines.join('\n');
  }

  /**
   * Экранирование спецсимволов для Telegram MarkdownV2
   */
  private _escapeMarkdown(text: string): string {
    // Экранируем все спецсимволы: _ * [ ] ( ) ~ ` > # + - = | { } . !
    // eslint-disable-next-line no-useless-escape
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
  }

  /**
   * Экранирование спецсимволов для Telegram HTML
   */
  private _escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
