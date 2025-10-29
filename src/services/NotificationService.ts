import TelegramBot from 'node-telegram-bot-api';
import { ConfigService } from './ConfigService.js';
import { LoggingService } from './LoggingService.js';
import { AccountStateService } from './AccountStateService.js';
import { DatabaseService } from './DatabaseService.js';
import Decimal from 'decimal.js';
import type { AccountState } from '../interfaces/IValidatorTypes.js';
import type winston from 'winston';
import type { DecimalValue } from '../interfaces/IValidatorTypes.js';

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
  private bot: TelegramBot | null = null;
  private chatId: string | null = null;
  private isEnabled: boolean = false;
  private readonly messageQueue: Array<() => Promise<void>> = [];
  private isProcessingQueue: boolean = false;

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
   * Отправка уведомления (синхронный метод, добавляет задачу в очередь)
   */
  public sendAlert(message: string, includeAccountState: boolean = false): void {
    if (!this.isEnabled) {
      return;
    }

    // Создаем асинхронную задачу для отправки
    const task = async (): Promise<void> => {
      try {
        let fullMessage = this._escapeMarkdown(message);

        if (includeAccountState && this.accountStateService) {
          const accountState = this.accountStateService.getAccountState();
          const accountStateText = this._formatAccountState(accountState);
          fullMessage = `${fullMessage}\n\n${accountStateText}`;
        }

        if (this.bot && this.chatId) {
          await this.bot.sendMessage(this.chatId, fullMessage, {
            parse_mode: 'MarkdownV2',
          });
          this.logger.debug('Notification sent successfully.');
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

        // Пауза для избежания Rate Limit (~1100ms между сообщениями)
        if (this.messageQueue.length > 0) {
          await new Promise((resolve) => setTimeout(resolve, 1100));
        }
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  /**
   * Форматирование состояния портфеля для Telegram (MarkdownV2)
   */
  private _formatAccountState(state: AccountState): string {
    const lines: string[] = [];

    // Заголовок
    lines.push('*📊 Состояние портфеля:*');

    // Общая стоимость
    const totalValue = this._escapeMarkdown(state.total_portfolio_value_usdt.toString());
    lines.push(`*Total Value:* \`${totalValue}\` USDT`);

    // Доступный баланс
    const availableBalance = this._escapeMarkdown(state.available_quote_balance.toString());
    lines.push(`*Available:* \`${availableBalance}\` USDT`);

    // Открытые позиции
    if (state.open_positions.length > 0) {
      lines.push(`\n*Позиции \\(${state.open_positions.length}\\):*`);
      for (const position of state.open_positions) {
        const pair = this._escapeMarkdown(position.pair);
        const side = this._escapeMarkdown(position.side);
        const amount = this._escapeMarkdown(position.amount.toString());
        const entryPrice = this._escapeMarkdown(position.average_entry_price.toString());
        lines.push(`  • ${pair} \\(${side}\\): \`${amount}\` @ \`${entryPrice}\``);
      }
    }

    // Открытые ордера
    if (state.open_orders.length > 0) {
      lines.push(`\n*Ордера (${state.open_orders.length}):*`);
      for (const order of state.open_orders) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const orderTyped = order as any;
        const pair = this._escapeMarkdown(orderTyped.pair || '');
        const type = this._escapeMarkdown(orderTyped.type || '');
        lines.push(`  • ${pair}: \`${type}\``);
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
        const justificationEscaped = this._escapeMarkdown(justification);

        let message = `*✅ СДЕЛКА ИСПОЛНЕНА:*\n`;
        message += `*Действие:* ${actionEscaped}\n`;
        message += `*Пара:* ${pairEscaped}\n\n`;
        message += `*🤖 Обоснование LLM:*\n${justificationEscaped}\n\n`;
        message += summaryText;

        if (this.bot && this.chatId) {
          await this.bot.sendMessage(this.chatId, message, {
            parse_mode: 'MarkdownV2',
          });
          this.logger.debug('Trading summary sent successfully.');
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
      // Получаем все закрытые позиции (сделки со realized_pnl_usd)
      const closedPositionsResult = await this.databaseService.query(
        `SELECT 
          COUNT(*) as total_closed,
          COALESCE(SUM(realized_pnl_usd), 0) as total_pnl,
          COALESCE(SUM(CASE WHEN realized_pnl_usd > 0 THEN 1 ELSE 0 END), 0) as wins,
          COALESCE(SUM(CASE WHEN realized_pnl_usd < 0 THEN 1 ELSE 0 END), 0) as losses,
          COALESCE(AVG(CASE WHEN realized_pnl_usd > 0 THEN realized_pnl_usd END), 0) as avg_win,
          COALESCE(AVG(CASE WHEN realized_pnl_usd < 0 THEN realized_pnl_usd END), 0) as avg_loss
        FROM TradeHistory 
        WHERE realized_pnl_usd IS NOT NULL`,
      );

      // Получаем общее количество сделок
      const totalTradesResult = await this.databaseService.query(
        `SELECT COUNT(*) as total FROM TradeHistory`,
      );

      // Получаем общие комиссии
      const totalFeesResult = await this.databaseService.query(
        `SELECT COALESCE(SUM(fee_cost), 0) as total_fees FROM TradeHistory`,
      );

      const closedPositionsRow = closedPositionsResult.rows[0];
      const totalTrades = parseInt(totalTradesResult.rows[0].total || '0', 10);
      const closedPositions = parseInt(closedPositionsRow.total_closed || '0', 10);
      const wins = parseInt(closedPositionsRow.wins || '0', 10);
      const losses = parseInt(closedPositionsRow.losses || '0', 10);
      const totalRealizedPnl = new DecimalConstructor(closedPositionsRow.total_pnl || '0') as DecimalValue;
      const totalFees = new DecimalConstructor(totalFeesResult.rows[0].total_fees || '0') as DecimalValue;
      const avgWin = closedPositions > 0 && wins > 0
        ? (new DecimalConstructor(closedPositionsRow.avg_win || '0') as DecimalValue)
        : (new DecimalConstructor('0') as DecimalValue);
      const avgLoss = closedPositions > 0 && losses > 0
        ? (new DecimalConstructor(closedPositionsRow.avg_loss || '0') as DecimalValue)
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
   * Экранирование спецсимволов для Telegram MarkdownV2
   */
  private _escapeMarkdown(text: string): string {
    // Экранируем все спецсимволы: _ * [ ] ( ) ~ ` > # + - = | { } . !
    // eslint-disable-next-line no-useless-escape
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
  }
}
