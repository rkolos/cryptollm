# Техническое Задание (ТЗ): 4.4 Сборщик Макро-Контекста (MacroContextService)

**Эпик:** 4. 📊 "Наблюдатель" (Watcher) - Сбор Данных и Технический Анализ **Задача:** 4.4 Сборщик Макро-Контекста **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать `MacroContextService` (Singleton), который отвечает за загрузку и кэширование внешних макроэкономических данных, а именно "Индекса Страха и Жадности" (Fear & Greed Index), как описано в `about.md` (Категория 4).

## 2\. Зависимости Задачи

- **`axios` (1.2):** (Зависимость) Для выполнения HTTP-запросов к внешнему API.
- **`LoggingService` (1.4):** (Зависимость) Для логирования.

## 3\. Описание и Нюансы Реализации

### 3.1. Новые Типы Интерфейсов (`src/interfaces/types.ts`)

Определяем структуру для "Макро-Контекста" (Категория 4).

    // src/interfaces/types.ts (Дополнения)

    // ... (другие типы)

    /**
     * Структура Макро-Контекста (Категория 4)
     */
    export interface MacroContext {
        fear_and_greed_index: number | null;
        fear_and_greed_text: string | null;
    }

### 3.2. Создание `src/services/MacroContextService.ts`

Этот сервис будет выполнять HTTP-запросы и управлять кэшем.

    // src/services/MacroContextService.ts (Новый Файл)

    import axios from 'axios';
    import { MacroContext } from '../interfaces';
    import { LoggingService } from './LoggingService';

    // (URL API из about.md, раздел Г)
    const FEAR_AND_GREED_API_URL = '[https://api.alternative.me/fng/?limit=1](https://api.alternative.me/fng/?limit=1)';

    // (Кэш на 1 час, как в about.md, раздел В)
    const CACHE_TTL_MS = 3_600_000; // 1 час

    export class MacroContextService {
        private static instance: MacroContextService;
        private logger: LoggingService;

        // (In-memory кэш)
        private contextCache: MacroContext = {
            fear_and_greed_index: null,
            fear_and_greed_text: null
        };
        private lastFetchTime: number = 0;
        private fetchPromise: Promise<void> | null = null;

        private constructor() {
            this.logger = LoggingService.getInstance();
            this.logger.registerContext("MacroContextService");
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
                // (Не используем await, чтобы не блокировать SlowCycle)
                this.forceRefresh().catch(e => {
                    this.logger.warn(`Фоновое обновление 'Fear & Greed' не удалось: ${e.message}`);
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
            // (Предотвращение "гонки", если 2 потока одновременно вызовут forceRefresh)
            if (this.fetchPromise) {
                this.logger.debug("Запрос 'Fear & Greed' уже выполняется, ожидаем...");
                return this.fetchPromise;
            }

            this.fetchPromise = (async () => {
                try {
                    this.logger.debug("Выполняю запрос к api.alternative.me...");

                    const response = await axios.get(FEAR_AND_GREED_API_URL, {
                        timeout: 5000 // (Таймаут 5 сек)
                    });

                    if (response.data && response.data.data && response.data.data.length > 0) {
                        const data = response.data.data[0];
                        const newIndex = parseInt(data.value, 10);
                        const newText = data.value_classification;

                        if (!isNaN(newIndex) && newText) {
                            this.contextCache = {
                                fear_and_greed_index: newIndex,
                                fear_and_greed_text: newText
                            };
                            this.lastFetchTime = Date.now();
                            this.logger.info(`Макро-контекст обновлен: ${newText} (${newIndex})`);
                        } else {
                            throw new Error("API вернул невалидные данные.");
                        }
                    } else {
                        throw new Error("API вернул пустой или некорректный ответ.");
                    }

                } catch (error: any) {
                    this.logger.error(`Ошибка при загрузке 'Fear & Greed Index': ${error.message}`);
                    // (Важно: не "валим" приложение, просто оставляем старый кэш)
                } finally {
                    this.fetchPromise = null; // (Снимаем блокировку)
                }
            })();

            return this.fetchPromise;
        }
    }

## 4\. Критерии Приемки (Acceptance Criteria)

1.  **\[Interface\]** `src/interfaces/types.ts` дополнен интерфейсом `MacroContext` (с полями `fear_and_greed_index` (number|null) и `fear_and_greed_text` (string|null)).
2.  **\[Service\]** Создан `MacroContextService.ts` (Singleton) с `getInstance()`.
3.  **\[Service\]** `MacroContextService` имеет `private contextCache` и `private lastFetchTime`.
4.  **\[Logic\]** `forceRefresh()` корректно вызывает API (`api.alternative.me`) с помощью `axios` и устанавливает таймаут.
5.  **\[Logic\]** `forceRefresh()` корректно парсит ответ и обновляет `contextCache` и `lastFetchTime` в случае успеха.
6.  **\[Robustness (Критично)\]** `forceRefresh()` **не бросает (throw)** ошибку в случае сбоя API (e.g., таймаут, 500), а **логирует** ее и оставляет старый кэш.
7.  **\[Robustness\]** `forceRefresh()` реализует механизм блокировки `fetchPromise`, чтобы предотвратить "гонку запросов".
8.  **\[Logic\]** `getContext()` является **синхронным** методом и немедленно возвращает `contextCache`.
9.  **\[Logic\]** `refreshCacheIfStale()` корректно проверяет `lastFetchTime > CACHE_TTL_MS` (1 час) и вызывает `forceRefresh` (без `await`).
10. **\[Logic\]** `initialize()` существует и вызывает `await forceRefresh()` для заполнения кэша при старте.
