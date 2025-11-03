import { config } from 'dotenv';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '../src/services/ConfigService.js';
import { LoggingService } from '../src/services/LoggingService.js';
import { DatabaseService } from '../src/services/DatabaseService.js';
import { EventBusService } from '../src/services/EventBusService.js';
import { NotificationService } from '../src/services/NotificationService.js';
import { GlobalStateService } from '../src/services/GlobalStateService.js';
import { AccountStateService } from '../src/services/AccountStateService.js';
import { ExchangeRulesService } from '../src/services/ExchangeRulesService.js';
import { ValidatorService } from '../src/services/ValidatorService.js';
import { GuaranteedOrderExecutionService } from '../src/services/GuaranteedOrderExecutionService.js';
import { WorkerService } from '../src/services/WorkerService.js';
import { ProductionExchangeService } from '../src/services/ProductionExchangeService.js';
import { MockExchangeService } from '../src/services/MockExchangeService.js';
import type { LLMDecision, IExchangeService } from '../src/interfaces/IExchangeService.js';
import type { DecimalValue, MarketData } from '../src/interfaces/IValidatorTypes.js';
import Decimal from 'decimal.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DecimalConstructor = Decimal as any;

// Простой stub для NotificationService, чтобы избежать зависимостей
class NotificationServiceStub {
  sendTradingSummary(): void {
    // stub - ничего не делаем
  }
  sendAlert(): void {
    // stub - ничего не делаем
  }
}

config();

async function clearLogs(): Promise<void> {
  console.log('🧹 Очистка файлов логов...');

  const logsDir = path.join(process.cwd(), 'logs');

  try {
    // Проверяем существование директории logs
    if (!fs.existsSync(logsDir)) {
      console.log('   ⚠️  Директория logs не существует');
      return;
    }

    // Получаем список файлов в директории logs
    const logFiles = fs.readdirSync(logsDir).filter(
      (file) => file.endsWith('.log') && !file.includes('git'), // Исключаем .gitkeep если есть
    );

    if (logFiles.length === 0) {
      console.log('   ✅ Файлов логов для очистки нет');
      return;
    }

    console.log(`   🗂️  Найдено ${logFiles.length} файлов логов:`);
    logFiles.forEach((file) => console.log(`      - ${file}`));

    // Удаляем каждый файл лога
    for (const logFile of logFiles) {
      const filePath = path.join(logsDir, logFile);
      fs.unlinkSync(filePath);
      console.log(`      ✅ Удален: ${logFile}`);
    }

    console.log('   ✅ Все логи очищены\n');
  } catch (error) {
    console.error('   ❌ Ошибка при очистке логов:', error);
    throw error;
  }
}

async function clearDatabase(): Promise<void> {
  console.log('🗃️  Очистка базы данных...');

  // Создаем отдельное подключение к БД для очистки
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER || 'cryptollm',
    password: process.env.DB_PASSWORD || 'cryptollm',
    database: process.env.DB_NAME || 'cryptollm',
  });

  try {
    console.log('   🔄 Очищаем все таблицы...');

    // Очищаем все таблицы и сбрасываем счетчики SERIAL
    await pool.query(
      'TRUNCATE ActivePositions, ActiveOrders, TSL_State, TradeHistory, LLM_Triggers, LLM_Decision_Log RESTART IDENTITY CASCADE',
    );

    console.log('   ✅ Все таблицы очищены');
    console.log('   🔄 Счетчики ID сброшены');

    // Создаем начальные триггеры для всех пар из watchlist
    console.log('   🎯 Создание начальных триггеров...');
    const config = ConfigService.getInstance();
    const watchlist = config.getWatchlist();

    console.log(`   📋 Пары для инициализации: ${watchlist.join(', ')}`);

    for (let i = 0; i < watchlist.length; i++) {
      const pair = watchlist[i];
      // Создаем триггеры с задержкой 1 минута между парами
      // Первая пара сработает через 1 минуту, вторая через 2 минуты и т.д.
      const initialTimeout = Date.now() + (i + 1) * 60000; // (i + 1) минут от текущего времени

      const triggerConditions = [
        {
          type: 'timeout' as const,
          value: initialTimeout,
        },
      ];

      try {
        await pool.query(
          `INSERT INTO LLM_Triggers (pair, reason, trigger_conditions_json, requested_data_json, updated_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (pair) DO UPDATE SET
             reason = EXCLUDED.reason,
             trigger_conditions_json = EXCLUDED.trigger_conditions_json,
             requested_data_json = EXCLUDED.requested_data_json,
             updated_at = EXCLUDED.updated_at`,
          [pair, 'Initial trigger - first LLM call after reset', JSON.stringify(triggerConditions), null, new Date()],
        );

        const triggerTime = new Date(initialTimeout).toLocaleTimeString();
        console.log(`      ✅ ${pair}: триггер на ${triggerTime} (через ${i + 1} мин.)`);
      } catch (error) {
        console.error(`      ❌ Ошибка при создании триггера для ${pair}:`, error);
        throw error;
      }
    }

    console.log('   ✅ Начальные триггеры созданы\n');
  } catch (error) {
    console.error('   ❌ Ошибка при очистке базы данных:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

async function closeAllPositionsAndSellToUSDT() {
  console.log('🚀 Начинаем ПОЛНУЮ ПЕРЕЗАГРУЗКУ системы...\n');

  // === ШАГ 0: ОЧИСТКА ЛОГОВ И БАЗЫ ДАННЫХ ===
  console.log('📋 ШАГ 0: Очистка логов и базы данных...\n');

  try {
    // Очищаем логи до инициализации сервисов логирования
    await clearLogs();

    // Инициализируем ConfigService для доступа к настройкам
    ConfigService.load();

    // Очищаем базу данных
    await clearDatabase();

    console.log('✅ Очистка завершена!\n');
  } catch (error) {
    console.error('❌ Критическая ошибка при очистке:', error);
    process.exit(1);
  }

  // Инициализация сервисов после очистки
  LoggingService.initialize();
  const logger = LoggingService.getInstance().getLogger('CloseAll');

  // Определяем exchange service в зависимости от режима
  let exchangeService: IExchangeService;
  if (config.getAppMode() === 'production') {
    exchangeService = ProductionExchangeService.getInstance();
  } else {
    exchangeService = MockExchangeService.getInstance();
  }

  // Загружаем рынки для ExchangeRulesService
  await exchangeService.loadMarkets();

  // Инициализируем ExchangeRulesService
  await ExchangeRulesService.initialize(exchangeService, config);
  const exchangeRulesService = ExchangeRulesService.getInstance();

  // Инициализируем DatabaseService
  await DatabaseService.initialize();
  const databaseService = DatabaseService.getInstance();
  const eventBus = EventBusService.getInstance();
  // Используем stub вместо NotificationService для простоты
  const notificationServiceStub = new NotificationServiceStub();
  const globalStateService = GlobalStateService.getInstance();

  const accountStateService = AccountStateService.getInstance(config, exchangeService, databaseService, eventBus);

  const validatorService = ValidatorService.getInstance(config, accountStateService, exchangeRulesService);

  const executionService = GuaranteedOrderExecutionService.getInstance(exchangeService);

  const workerService = WorkerService.getInstance(
    validatorService,
    executionService,
    databaseService,
    eventBus,
    notificationServiceStub as any, // используем stub
    globalStateService,
    accountStateService,
    exchangeRulesService,
    config,
  );

  try {
    // Рынки уже загружены выше для ExchangeRulesService
    logger.info('Рынки загружены успешно');

    // Получаем актуальное состояние аккаунта
    await accountStateService.refreshNow();
    const accountState = accountStateService.getAccountState();

    const watchlist = config.getWatchlist();
    console.log(`📋 Отслеживаемые пары: ${watchlist.join(', ')}`);

    // === ШАГ 1: ЗАКРЫТИЕ ВСЕХ ПОЗИЦИЙ ===
    console.log('\n📊 ШАГ 1: Закрытие всех открытых позиций...\n');

    const openPositions = accountState.open_positions;
    if (openPositions.length === 0) {
      console.log('✅ Открытых позиций нет');
    } else {
      console.log(`📈 Найдено ${openPositions.length} открытых позиций:`);
      openPositions.forEach((pos) => {
        console.log(`   - ${pos.pair}: ${pos.side} ${pos.amount.toString()} @ ${pos.average_entry_price.toString()}`);
      });

      // Закрываем каждую позицию
      for (const position of openPositions) {
        try {
          console.log(`\n🔄 Закрываем позицию ${position.pair}...`);

          // Создаем decision для закрытия позиции
          const closeDecision: LLMDecision = {
            action: 'CLOSE_POSITION',
            pair: position.pair,
            parameters: {
              type: 'market',
              amount_percent: 100, // Закрываем всю позицию
            },
            justification: 'Закрытие позиции для отладки - перевод всех средств в USDT',
          };

          // Получаем market data для валидации (нужна текущая цена)
          const marketData: MarketData = {
            pair: position.pair,
            current_price: await getCurrentPrice(exchangeService, position.pair),
          };

          // Получаем strategy context
          const strategyContext = {
            role: 'Emergency Close All Positions',
            style: 'Conservative',
            risk_rules: {
              default_risk_per_trade_percent: 1,
              max_allowed_risk_per_trade_percent: 5,
              max_total_portfolio_risk_percent: 10,
              desired_risk_reward_ratio: 2,
            },
            watchlist: watchlist,
          };

          // Валидируем decision
          validatorService.validateDecision(
            closeDecision,
            accountState,
            strategyContext,
            marketData,
            exchangeRulesService.getRules(position.pair),
          );

          // Выполняем закрытие через WorkerService
          const llmDecisionLogId = `close-all-${position.pair}-${Date.now()}`;
          await workerService.execute(closeDecision, llmDecisionLogId, accountState, strategyContext, marketData);

          console.log(`✅ Позиция ${position.pair} успешно закрыта`);

          // Обновляем состояние аккаунта после каждого закрытия
          await accountStateService.refreshNow();
        } catch (error) {
          logger.error(`❌ Ошибка при закрытии позиции ${position.pair}:`, error);
          console.error(`❌ Ошибка при закрытии позиции ${position.pair}:`, error);
          // Продолжаем с другими позициями
        }
      }
    }

    // === ШАГ 2: ПРОДАЖА ВСЕХ ВАЛЮТ В USDT ===
    console.log('\n💰 ШАГ 2: Продажа всех валют в USDT...\n');

    // Обновляем состояние аккаунта после закрытия позиций
    await accountStateService.refreshNow();
    const updatedAccountState = accountStateService.getAccountState();

    console.log('📊 Текущие балансы:');
    const usdtBalance = updatedAccountState.available_quote_balance;
    console.log(`   - USDT: ${usdtBalance.toString()}`);

    updatedAccountState.assets.forEach((asset) => {
      console.log(`   - ${asset.asset}: ${asset.total.toString()}`);
    });

    // Продаем все валюты, кроме USDT
    const assetsToSell = updatedAccountState.assets.filter(
      (asset) => asset.asset !== 'USDT' && parseFloat(asset.total.toString()) > 0.00000001, // Минимальный порог
    );

    if (assetsToSell.length === 0) {
      console.log('✅ Нет валют для продажи (кроме USDT)');
    } else {
      console.log(`\n🔄 Продаем ${assetsToSell.length} валют в USDT:`);

      for (const asset of assetsToSell) {
        try {
          const pair = `${asset.asset}/USDT`;

          // Проверяем, что пара торгуется
          if (!watchlist.includes(pair)) {
            console.log(`⚠️  Пара ${pair} не в списке отслеживаемых, пропускаем`);
            continue;
          }

          console.log(`\n🔄 Продаем ${asset.total.toString()} ${asset.asset} в USDT...`);

          // Получаем текущую цену
          const currentPrice = await getCurrentPrice(exchangeService, pair);
          const amountToSell = new DecimalConstructor(asset.total.toString()) as DecimalValue;

          // Создаем ордер на продажу
          const sellOrder = await executionService.createOrderWithRetry(pair, 'market', 'sell', amountToSell);

          console.log(`✅ Продано ${asset.asset}: ${sellOrder.amount.toString()} @ ~${currentPrice.toString()} USDT`);

          // Обновляем состояние аккаунта
          await accountStateService.refreshNow();
        } catch (error) {
          logger.error(`❌ Ошибка при продаже ${asset.asset}:`, error);
          console.error(`❌ Ошибка при продаже ${asset.asset}:`, error);
          // Продолжаем с другими валютами
        }
      }
    }

    // === ШАГ 3: ФИНАЛЬНАЯ ПРОВЕРКА ===
    console.log('\n🔍 ШАГ 3: Финальная проверка...\n');

    await accountStateService.refreshNow();
    const finalAccountState = accountStateService.getAccountState();

    console.log('📊 Финальные балансы:');
    console.log(`   - USDT: ${finalAccountState.available_quote_balance.toString()}`);
    finalAccountState.assets.forEach((asset) => {
      console.log(`   - ${asset.asset}: ${asset.total.toString()}`);
    });

    console.log(`\n📈 Открытых позиций: ${finalAccountState.open_positions.length}`);
    console.log(`📋 Открытых ордеров: ${finalAccountState.open_orders.length}`);

    if (
      finalAccountState.open_positions.length === 0 &&
      finalAccountState.assets.filter((a) => a.asset !== 'USDT' && parseFloat(a.total.toString()) > 0.00000001)
        .length === 0
    ) {
      console.log('\n🎉 ПОЛНАЯ ПЕРЕЗАГРУЗКА ЗАВЕРШЕНА УСПЕШНО!');
      console.log('✅ Все позиции закрыты');
      console.log('✅ Все валюты проданы в USDT');
      console.log('✅ Логи и база данных очищены');
      console.log('✅ Созданы последовательные триггеры (каждый через +1 мин)');
      console.log('💡 Система готова к новому старту с чистого листа');
    } else {
      console.log('\n⚠️  ВНИМАНИЕ! Перезагрузка завершена частично');
      console.log('🔄 Возможно, требуется ручная проверка и доочистка');
    }
  } catch (error) {
    logger.error('❌ Критическая ошибка:', error);
    console.error('\n❌ Критическая ошибка:', error);
    process.exit(1);
  } finally {
    // Закрываем соединения
    await exchangeService.close();
    await databaseService.close();
  }
}

async function getCurrentPrice(exchangeService: IExchangeService, pair: string): Promise<DecimalValue> {
  try {
    const ticker = await exchangeService.fetchTicker(pair);
    return ticker.last;
  } catch (error) {
    console.warn(`Не удалось получить цену для ${pair}, используем 1:`, error);
    return new DecimalConstructor(1) as DecimalValue;
  }
}

closeAllPositionsAndSellToUSDT().catch((error) => {
  console.error('💥 Фатальная ошибка:', error);
  process.exit(1);
});
