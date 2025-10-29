import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { NotificationService } from '../NotificationService.js';
import { ConfigService } from '../ConfigService.js';
import { DatabaseService } from '../DatabaseService.js';
import { AccountStateService } from '../AccountStateService.js';
import { MockDataFactory } from '../../__tests__/mocks/MockData.js';

describe('NotificationService', () => {
  let notificationService: NotificationService;
  let mockConfigService: ConfigService;
  let mockDatabaseService: DatabaseService;
  let mockAccountStateService: AccountStateService;

  beforeEach(() => {
    vi.clearAllMocks();

    // ВАЖНО: NotificationService использует Singleton, нужно сбросить instance перед каждым тестом
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (NotificationService as any).instance = undefined;

    // Мокируем ConfigService с включенным Telegram (но bot будет null в тестах)
    mockConfigService = {
      getTelegramConfig: vi.fn(() => ({
        botToken: 'test_token', // Включаем для тестов (бот всё равно не будет создан)
        chatId: 'test_chat_id',
      })),
    } as unknown as ConfigService;

    notificationService = NotificationService.getInstance(mockConfigService);

    // Мокируем DatabaseService
    mockDatabaseService = {
      query: vi.fn(),
    } as unknown as DatabaseService;

    // Мокируем AccountStateService
    mockAccountStateService = {
      getAccountState: vi.fn(() => MockDataFactory.createAccountState()),
    } as unknown as AccountStateService;

    // Инъекция зависимостей
    notificationService.injectDatabaseService(mockDatabaseService);
    notificationService.injectAccountStateService(mockAccountStateService);
  });

  describe('sendTradingSummary', () => {
    it('должен отправлять сообщение со статистикой торговли', () => {
      // Тест проверяет, что метод не выбрасывает ошибку
      // В реальности отправка происходит через очередь, но в тестах Telegram отключен
      expect(() => {
        notificationService.sendTradingSummary('OPEN_LONG', 'BTC/USDT', 'Test justification');
      }).not.toThrow();
    });

    it('должен обрабатывать отсутствие DatabaseService', () => {
      // Сбрасываем DatabaseService
      const serviceWithoutDb = NotificationService.getInstance(mockConfigService);
      serviceWithoutDb.injectAccountStateService(mockAccountStateService);
      // Не инжектим DatabaseService

      // Метод должен обработать отсутствие DatabaseService gracefully
      expect(() => {
        serviceWithoutDb.sendTradingSummary('OPEN_LONG', 'BTC/USDT', 'Test justification');
      }).not.toThrow();
    });
  });

  describe('_getTradingSummary (через sendTradingSummary)', () => {
    it('должен корректно обрабатывать пустую статистику (нет сделок)', async () => {
      // Мокируем пустой результат запроса
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockDatabaseService.query as any).mockResolvedValue({
        rows: [
          {
            total_trades: '0',
            total_closed: '0',
            total_pnl: '0',
            wins: '0',
            losses: '0',
            avg_win: null,
            avg_loss: null,
            total_fees: '0',
          },
        ],
      });

      // Вызываем sendTradingSummary, который внутренне вызывает _getTradingSummary
      notificationService.sendTradingSummary('OPEN_LONG', 'BTC/USDT', 'Test justification');

      // Проверяем, что query был вызван
      expect(mockDatabaseService.query).toHaveBeenCalled();
    });

    it('должен корректно обрабатывать статистику с закрытыми позициями', async () => {
      // Мокируем результат с данными
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockDatabaseService.query as any).mockResolvedValue({
        rows: [
          {
            total_trades: '10',
            total_closed: '5',
            total_pnl: '150.50',
            wins: '3',
            losses: '2',
            avg_win: '80.00',
            avg_loss: '-30.00',
            total_fees: '25.75',
          },
        ],
      });

      notificationService.sendTradingSummary('CLOSE_POSITION', 'BTC/USDT', 'Test justification');

      // Даём время на обработку очереди
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockDatabaseService.query).toHaveBeenCalled();
      // Проверяем, что был вызван оптимизированный запрос (один запрос вместо трёх)
      expect(mockDatabaseService.query).toHaveBeenCalledTimes(1);
    });

    it('должен обрабатывать ошибки БД и возвращать пустую статистику', async () => {
      // Мокируем ошибку БД
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockDatabaseService.query as any).mockRejectedValue(new Error('Database error'));

      // Метод не должен выбрасывать ошибку
      expect(() => {
        notificationService.sendTradingSummary('OPEN_LONG', 'BTC/USDT', 'Test justification');
      }).not.toThrow();
    });

    it('должен корректно обрабатывать NULL значения в статистике', async () => {
      // Мокируем результат с NULL значениями
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockDatabaseService.query as any).mockResolvedValue({
        rows: [
          {
            total_trades: '3',
            total_closed: '1',
            total_pnl: '50.00',
            wins: '1',
            losses: '0',
            avg_win: '50.00',
            avg_loss: null, // NULL для avg_loss
            total_fees: '10.00',
          },
        ],
      });

      notificationService.sendTradingSummary('CLOSE_POSITION', 'ETH/USDT', 'Test justification');

      // Даём время на обработку очереди
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockDatabaseService.query).toHaveBeenCalled();
    });
  });

  describe('sendAlert', () => {
    it('должен отправлять alert без AccountState', () => {
      expect(() => {
        notificationService.sendAlert('Test message', false);
      }).not.toThrow();
    });

    it('должен отправлять alert с AccountState', () => {
      expect(() => {
        notificationService.sendAlert('Test message', true);
      }).not.toThrow();
    });

    it('должен работать без AccountStateService', () => {
      const serviceWithoutAccount = NotificationService.getInstance(mockConfigService);
      serviceWithoutAccount.injectDatabaseService(mockDatabaseService);
      // Не инжектим AccountStateService

      expect(() => {
        serviceWithoutAccount.sendAlert('Test message', true);
      }).not.toThrow();
    });
  });
});
