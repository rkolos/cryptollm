import TelegramBot from 'node-telegram-bot-api';
import { ConfigService } from './ConfigService.js';
import { LoggingService } from './LoggingService.js';
import { AccountStateService } from './AccountStateService.js';
import type { AccountState } from '../interfaces/IValidatorTypes.js';
import type winston from 'winston';

/**
 * NotificationService - Singleton для отправки PUSH-уведомлений через Telegram
 */
export class NotificationService {
  private static instance: NotificationService | undefined;
  private readonly logger: winston.Logger;
  private readonly configService: ConfigService;
  private accountStateService: AccountStateService | null = null;
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
      lines.push(`\n*Ордера \\(${state.open_orders.length}\\):*`);
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
   * Экранирование спецсимволов для Telegram MarkdownV2
   */
  private _escapeMarkdown(text: string): string {
    // Экранируем все спецсимволы: _ * [ ] ( ) ~ ` > # + - = | { } . !
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
  }
}
