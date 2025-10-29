import axios from 'axios';
import { LoggingService } from './LoggingService.js';
import type { MacroContext } from '../interfaces/ILLMTypes.js';
import type winston from 'winston';

// URL API из about.md, раздел Г
const FEAR_AND_GREED_API_URL = 'https://api.alternative.me/fng/?limit=1';

// Кэш на 1 час, как в about.md, раздел В
const CACHE_TTL_MS = 3_600_000; // 1 час

export class MacroContextService {
  private static instance: MacroContextService | undefined;
  private readonly logger: winston.Logger;

  // In-memory кэш
  private contextCache: MacroContext = {
    fear_and_greed_index: null,
    fear_and_greed_text: null,
  };
  private lastFetchTime: number = 0;
  private fetchPromise: Promise<void> | null = null;

  private constructor() {
    this.logger = LoggingService.getInstance().getLogger('MacroContext');
    this.logger.info('MacroContextService initialized.');
  }

  public static getInstance(): MacroContextService {
    if (!MacroContextService.instance) {
      MacroContextService.instance = new MacroContextService();
    }
    return MacroContextService.instance;
  }

  /**
   * (Вызывается 1 раз при старте - см. Задачу 8.1)
   * Выполняет первую загрузку данных.
   */
  public async initialize(): Promise<void> {
    this.logger.info("Инициализация: первая загрузка 'Fear & Greed Index'...");
    await this.forceRefresh();
  }

  /**
   * (Вызывается "Медленным Циклом" - Задача 5.2)
   * Обновляет кэш, если он устарел (старше 1 часа).
   * Не бросает ошибок, чтобы не остановить цикл.
   */
  public async refreshCacheIfStale(): Promise<void> {
    if (Date.now() - this.lastFetchTime > CACHE_TTL_MS) {
      this.logger.debug("Кэш 'Fear & Greed' устарел, обновляю...");
      // Не используем await, чтобы не блокировать SlowCycle
      this.forceRefresh().catch((e) => {
        this.logger.warn(`Фоновое обновление 'Fear & Greed' не удалось: ${(e as Error).message}`);
      });
    }
  }

  /**
   * (Синхронный) Возвращает ПОСЛЕДНИЕ УСПЕШНЫЕ данные из кэша.
   * (Вызывается LLMRequestAssemblerService - Задача 4.6)
   */
  public getContext(): MacroContext {
    return this.contextCache;
  }

  /**
   * Принудительно выполняет запрос к API и обновляет кэш.
   * Реализует блокировку "одного запроса" (Race condition)
   */
  public async forceRefresh(): Promise<void> {
    // Предотвращение "гонки", если 2 потока одновременно вызовут forceRefresh
    if (this.fetchPromise) {
      this.logger.debug("Запрос 'Fear & Greed' уже выполняется, ожидаем...");
      return this.fetchPromise;
    }

    this.fetchPromise = (async () => {
      try {
        this.logger.debug('Выполняю запрос к api.alternative.me...');

        const response = await axios.get(FEAR_AND_GREED_API_URL, {
          timeout: 5000, // Таймаут 5 сек
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const responseData = response.data as any;

        if (responseData && responseData.data && Array.isArray(responseData.data) && responseData.data.length > 0) {
          const data = responseData.data[0];
          const newIndex = parseInt(String(data.value), 10);
          const newText = String(data.value_classification || '');

          if (!isNaN(newIndex) && newText) {
            this.contextCache = {
              fear_and_greed_index: newIndex,
              fear_and_greed_text: newText,
            };
            this.lastFetchTime = Date.now();
            this.logger.info(`Макро-контекст обновлен: ${newText} (${newIndex})`);
          } else {
            throw new Error('API вернул невалидные данные.');
          }
        } else {
          throw new Error('API вернул пустой или некорректный ответ.');
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error(`Ошибка при загрузке 'Fear & Greed Index': ${errorMessage}`);
        // Важно: не "валим" приложение, просто оставляем старый кэш
      } finally {
        this.fetchPromise = null; // Снимаем блокировку
      }
    })();

    return this.fetchPromise;
  }
}
