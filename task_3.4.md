# Техническое Задание (ТЗ): 3.4 Production-Клиент LLM (ProductionLLMService)

**Эпик:** 3. 🔌 Core-Сервисы и Клиенты (Core Services & Clients) **Задача:** 3.4 Production-Клиент LLM (ProductionLLMService) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать "боевую" реализацию (`ProductionLLMService`) интерфейса `ILLMService`. Этот сервис будет выполнять реальные HTTP-запросы к API LLM, обрабатывать ошибки сети, применять политику повторных запросов (retry) и, самое главное, **строго валидировать** структуру JSON-ответа от LLM.

## 2\. Зависимости Задачи

- **`axios`:** (Установлен в 1.2) Для выполнения HTTP-запросов.
- **`zod`:** (Установлен в 1.3) Для парсинга и валидации ответа LLM.
- **`ConfigService` (1.3):** Для получения `LLM_API_URL`, `LLM_API_KEY` и `LLM_MODEL_NAME`.
- **`LoggingService` (1.4):** Для логирования запросов, ошибок и `warn`\-ов при retry.
- **`ILLMService` / `ILLMTypes` (3.3):** Реализуемый интерфейс и типы данных.

## 3\. Описание и Нюансы Реализации

### 3.1. Файл 1: `src/errors/LLMErrors.ts` (Кастомные Ошибки LLM)

Разработчик должен создать новый файл для кастомных ошибок, которые `WatcherOrchestrator` сможет перехватывать.

    // src/errors/LLMErrors.ts

    // Базовый класс
    export class LLMError extends Error {
      public readonly originalError: any;
      constructor(message: string, originalError: any = null) {
        super(message);
        this.name = this.constructor.name;
        this.originalError = originalError;
      }
    }

    // Ошибка сети, таймаут или API не отвечает
    export class LLMNetworkError extends LLMError {}

    // Ошибка 401/403 (Неверный API Key) - Фатально
    export class LLMAuthError extends LLMError {}

    // Ошибка 400 (Bad Request) - (Вероятно, наша ошибка в запросе)
    export class LLMRequestError extends LLMError {}

    // Ошибка: API ответил, но ответ - невалидный JSON
    // или не соответствует Zod-схеме LLMResponse
    export class LLMResponseFormatError extends LLMError {
      public readonly validationErrors: any;
      constructor(message: string, validationErrors: any = null, originalError: any = null) {
        super(message, originalError);
        this.validationErrors = validationErrors;
      }
    }

### 3.2. Файл 2: `src/interfaces/ILLMTypes.zod.ts` (Zod-схема валидации)

Разработчик должен создать `zod`\-схему, строго соответствующую интерфейсу `LLMResponse` из Задачи 3.3. Это **критически важный** файл.

    // src/interfaces/ILLMTypes.zod.ts
    import { z } from 'zod';

    // Helper для преобразования null в undefined для optional полей
    const nullToUndefined = <T extends z.ZodTypeAny>(schema: T) => {
      return z.preprocess((val) => (val === null ? undefined : val), schema);
    };

    // Схема для LLMDecision (параметры)
    const parametersSchema = z
      .object({
        type: z.enum(['market', 'limit']).optional(),
        price: nullToUndefined(z.number().optional()), // null преобразуется в undefined
        risk_percent: z.number().optional().nullable(),
        stop_loss_price: z.number().optional().nullable(),
        take_profit_price: z.number().optional().nullable(),
        trailing_stop_config: z
          .object({
            type: z.literal('percentage'),
            distance: z.number(),
          })
          .nullable()
          .optional(),
        amount_percent: nullToUndefined(z.number().optional()),
        order_id: z.string().nullable().optional(),
        new_stop_loss_price: nullToUndefined(z.number().optional()),
        new_take_profit_price: nullToUndefined(z.number().optional()),
        new_trailing_stop_config: z
          .object({
            type: z.literal('percentage'),
            distance: z.number(),
          })
          .nullable()
          .optional(),
      })
      .passthrough(); // passthrough() позволяет LLM добавлять доп. поля, не ломая валидацию

    // Схема для LLMDecision (одно решение)
    const decisionSchema = z.object({
      action: z.enum(['OPEN_LONG', 'OPEN_SHORT', 'CLOSE_POSITION', 'MODIFY_POSITION', 'CANCEL_ORDERS', 'HOLD']),
      pair: z.string(),
      parameters: parametersSchema,
      justification: z.string(),
    });

    // Схема для LLMTriggerCondition
    const triggerSchema = z.object({
      type: z.enum(['price', 'indicator', 'timeout']),
      condition: z.string(),
      value: z.number(), // Обязательное поле - не может быть null
      name: nullToUndefined(z.string().optional()),
      timeframe: nullToUndefined(z.string().optional()),
    });

    // (Критично) Итоговая схема ответа LLM
    export const llmResponseSchema = z.object({
      decisions: z.array(decisionSchema),
      update_triggers_for_pair: z.string(),
      next_call_triggers: z.object({
        reason: z.string(),
        trigger_conditions: z.array(triggerSchema),
      }),
      request_additional_data: z.array(z.string()).nullable(),
    });

    // Тип, выведенный из Zod (для гарантии синхронизации)
    export type LLMResponseZod = z.infer<typeof llmResponseSchema>;

### 3.3. Файл 3: `src/services/ProductionLLMService.ts` (Реализация)

#### 3.3.1. (Архитектурное Уточнение) Модель и Формат Запроса

По настоянию Архитектора, для обеспечения высокого качества анализа (`justification`) и следования сложным инструкциям (Chain-of-Thought), **мы будем использовать специализированную модель с продвинутыми возможностями reasoning (например, "DeepSeek Reasoning Model" или аналог)**.

Разработчик должен:

1.  Получить `LLM_MODEL_NAME` (e.g., `deepseek-coder`) из `ConfigService` (это будет реализовано в Задаче 1.3).
2.  При формировании `payload` для `httpClient.post`, добавить поле `model: this.modelName` в тело запроса.
3.  Путь (`/v1/chat/completions`) остается стандартным для OpenAI-совместимых API.

    // src/services/ProductionLLMService.ts import axios, { AxiosInstance, AxiosError } from 'axios'; import type winston from 'winston'; import { ILLMService } from '../interfaces/ILLMService'; import { LLMRequest, LLMResponse } from '../interfaces/ILLMTypes'; import { llmResponseSchema } from '../interfaces/ILLMTypes.zod'; import { ConfigService } from './ConfigService'; import { LoggingService } from './LoggingService'; import { LLMError, LLMNetworkError, LLMAuthError, LLMRequestError, LLMResponseFormatError } from '../errors/LLMErrors';

    // (Критично) Константы для Retry const MAX_RETRIES = 5; const INITIAL_BACKOFF_MS = 1000; // 1 секунда const REQUEST_TIMEOUT_MS = 30000; // 30 секунд

    export class ProductionLLMService implements ILLMService { private readonly logger: winston.Logger; private readonly httpClient: AxiosInstance; private readonly modelName: string; // (НОВОЕ) Имя модели

    constructor() { this.logger = LoggingService.getInstance().getLogger('ProdLLMService'); // Предполагается, что ConfigService уже настроен (Задача 1.3) // Для демонстрации, мы создаем временный инстанс // В реальном приложении, возможно, лучше использовать Singleton const config = (typeof ConfigService !== 'undefined') ? ConfigService.getInstance() : { getLLMConfig: () => ({ apiUrl: 'https://www.google.com/search?q=http://example.com/api', apiKey: 'mock-key', modelName: 'deepseek-v2' }) };

        // (ОБНОВЛЕНО) Получаем имя модели из ConfigService
        const { apiUrl, apiKey, modelName } = config.getLLMConfig();

        if (!apiUrl || !apiKey || !modelName) { // (ОБНОВЛЕНО)
          this.logger.error('FATAL: LLM_API_URL, LLM_API_KEY, or LLM_MODEL_NAME is not set. ProductionLLMService cannot start.');
          throw new Error('LLM_API_URL, LLM_API_KEY, or LLM_MODEL_NAME is missing.');
        }

        this.modelName = modelName; // (НОВОЕ)

        // 1. (Нюанс) Инициализация `axios`
        this.httpClient = axios.create({
          baseURL: apiUrl,
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: REQUEST_TIMEOUT_MS,
        });

        this.logger.info(`ProductionLLMService is active. Using real LLM API. Model: [${this.modelName}]`); // (ОБНОВЛЕНО)

    }

    /\*\*
    - (A) Публичный метод интерфейса \*/ public async ask(payload: LLMRequest): Promise<LLMResponse> {       // Измеряем время выполнения запроса
      const startTime = Date.now();
      this.logger.info(
        `🚀 [${payload.triggered_pair}] Отправка запроса к LLM (модель: ${this.modelName}, URL: ${this.httpClient.defaults.baseURL})...`,
      );

      // Логируем размер payload и "безопасные" части запроса
      const payloadSize = JSON.stringify(payload).length;
      this.logger.debug('ProductionLLMService Request Payload:', {
        pair: payload.triggered_pair,
        question: payload.question,
        context: payload.strategy_context?.macro_context,
        payloadSize,
      });

      try {
      // 3. (Критично) Вызов с логикой Retry
      const responseData = await this.executeRequestWithRetry(payload);

      // 4. (Критично) Валидация Zod
      // (Нюанс) API может вернуть JSON-объект в `choices[0].message.content`
      // или в корне. Zod-валидация должна работать с _финальным_ JSON-объектом
      // (Этот код предполагает, что `executeRequestWithRetry` вернул _ожидаемый_ JSON)

      let dataToValidate = responseData;

      // (Критично) Проверка на стандартный OpenAI-совместимый ответ,
      // где JSON-ответ может быть _строкой_ в .content
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const responseDataTyped = responseData as any;
      if (responseDataTyped.choices && responseDataTyped.choices[0]?.message?.content) {
        try {
          const content = responseDataTyped.choices[0].message.content;
          // Удаляем потенциальные маркдаун-блоки (```json или ```)
          const jsonString = content.replace(/```json\s*|```\s*/g, '').trim();
          dataToValidate = JSON.parse(jsonString);
        } catch (jsonParseError) {
          this.logger.error('Failed to parse JSON from choices.message.content', {
            content: responseDataTyped.choices[0].message.content,
          });
          throw new LLMResponseFormatError('LLM response content was not valid JSON.', jsonParseError, responseData);
        }
      }

      const parseResult = llmResponseSchema.safeParse(dataToValidate);

      if (!parseResult.success) {
        // Форматируем ошибки для лучшей читаемости
        const formattedErrors = parseResult.error.issues.map((issue) => {
          const base = {
            path: issue.path.join('.'),
            message: issue.message,
            code: issue.code,
          };
          // Добавляем информацию о типе для ошибок invalid_type
          if (issue.code === 'invalid_type') {
            const invalidTypeIssue = issue as { received?: unknown; expected?: string };
            return {
              ...base,
              received: typeof invalidTypeIssue.received,
              expected: invalidTypeIssue.expected,
            };
          }
          return base;
        });

        // Ограничиваем размер rawData для логирования (первые 1000 символов)
        const rawDataString = JSON.stringify(dataToValidate, null, 2);
        const truncatedRawData =
          rawDataString.length > 1000
            ? rawDataString.substring(0, 1000) + `\n... (truncated, total length: ${rawDataString.length})`
            : rawDataString;

        this.logger.error('LLM Response validation FAILED.', {
          errors: formattedErrors,
          errorCount: parseResult.error.issues.length,
          rawDataPreview: truncatedRawData,
        });

        // Логируем каждую ошибку отдельно для лучшей читаемости с фактическими значениями
        parseResult.error.issues.forEach((issue, index) => {
          const errorInfo: Record<string, unknown> = {
            path: issue.path.join('.') || 'root',
            message: issue.message,
            code: issue.code,
          };
          if (issue.code === 'invalid_type') {
            // Добавляем фактическое значение для диагностики
            // ...
          }
          this.logger.error(`Validation error ${index + 1}/${parseResult.error.issues.length}:`, errorInfo);
        });

        throw new LLMResponseFormatError('LLM response format is invalid.', parseResult.error.issues, dataToValidate);
      }

      const validationDuration = Date.now() - startTime;
      this.logger.info(
        `✅ [${payload.triggered_pair}] LLM ответ валидирован успешно. Время выполнения: ${validationDuration}ms. Решений: ${parseResult.data.decisions.length}`,
      );

      // 5. (Критично) Возвращаем только провалидированные данные
      return parseResult.data as LLMResponse; // (Тип LLMResponseZod == LLMResponse)

      } catch (e: any) {
      if (e instanceof LLMError) throw e; // (Пробрасываем наши ошибки)

      this.logger.error('Unhandled error during LLM "ask"', { error: e.message });
      throw new LLMError(e.message, e);
      }

    }

    /\*\*
    - (B) (Критично) Реализация Exponential Backoff \*/ private async executeRequestWithRetry(payload: LLMRequest): Promise<any> {

      // Формируем тело запроса в стандартном формате OpenAI-совместимого API
      const requestBody = {
        messages: [
          {
            role: 'user',
            content: JSON.stringify(payload), // LLMRequest сериализуется в JSON строку
          },
        ],
        model: this.modelName, // Имя модели из конфигурации
        response_format: { type: 'json_object' }, // Запрос JSON-ответа от API
      };

      const requestStartTime = Date.now();
      const payloadSize = JSON.stringify(payload).length;
      this.logger.info(
        `📤 [${payload.triggered_pair}] HTTP запрос к LLM API: модель=${this.modelName}, размер payload=${payloadSize} символов`,
      );

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const attemptStartTime = Date.now();
        try {
          if (attempt === 0) {
            this.logger.info(`📡 [${payload.triggered_pair}] Отправка POST /v1/chat/completions к LLM API...`);
          } else {
            this.logger.info(
              `📡 [${payload.triggered_pair}] Повторная попытка ${attempt + 1}/${MAX_RETRIES}: отправка POST /v1/chat/completions...`,
            );
          }

          // Путь /v1/chat/completions является стандартным для OpenAI-совместимых API
          const response = await this.httpClient.post('/v1/chat/completions', requestBody);
          const attemptDuration = Date.now() - attemptStartTime;
          const totalDuration = Date.now() - requestStartTime;

          if (attempt > 0) {
            this.logger.info(
              `✅ [${payload.triggered_pair}] LLM запрос успешен после ${attempt + 1} попытки(ок). Время этой попытки: ${attemptDuration}ms, общее время: ${totalDuration}ms`,
            );
          } else {
            this.logger.info(
              `✅ [${payload.triggered_pair}] LLM запрос успешен с первой попытки. Время выполнения: ${attemptDuration}ms`,
            );
          }

          return response.data; // Вернется полный ответ, `ask` его распарсит
        } catch (error) {
          if (!isAxiosError(error)) {
            throw error;
          }

          const axiosError = error as AxiosError;

          // 6. (Критично) Обработка ошибок Axios
          if (axiosError.response) {
            // Запрос был сделан, сервер ответил (4xx, 5xx)
            const status = axiosError.response.status;

            // (A) Ошибки 429 (Rate Limit) и 5xx (Server Error) -> Retry
            if (status === 429 || status >= 500) {
              // Exponential Backoff с джиттером
              const delay = (2 ** attempt) * INITIAL_BACKOFF_MS + (Math.random() * 1000);
              this.logger.warn(`LLM API returned ${status}. Retrying (attempt ${attempt + 1}/${MAX_RETRIES}) in ${delay.toFixed(0)}ms...`);
              await new Promise(resolve => setTimeout(resolve, delay));
              continue; // (Переход к следующей итерации цикла)
            }

            // (B) Ошибки 401/403 (Auth) -> Фатально, не лечится
            if (status === 401 || status === 403) {
              this.logger.error(`LLM API Auth Error (Status ${status}). Check LLM_API_KEY.`, { data: axiosError.response.data });
              throw new LLMAuthError(`LLM Auth Error (Status ${status})`, axiosError);
            }

            // (C) Ошибка 400 (Bad Request) -> Фатально, (наша вина)
            if (status === 400) {
              this.logger.error(`LLM API Bad Request (Status 400). Check payload structure.`, { data: axiosError.response.data });
              throw new LLMRequestError(`LLM Bad Request (Status 400)`, axiosError);
            }

          } else if (axiosError.code === 'ECONNABORTED' || axiosError.request) {
            // (D) Ошибка сети или Таймаут
            const delay = 2 ** attempt * INITIAL_BACKOFF_MS + Math.random() * 1000;
            this.logger.warn(
              `LLM Network Error or Timeout (Code: ${axiosError.code}). Retrying (attempt ${attempt + 1}/${MAX_RETRIES})...`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }

          // (E) Неизвестная ошибка
          throw error;

      }
      }

      // 7. (Критично) Если вышли из цикла
      const totalDuration = Date.now() - requestStartTime;
      this.logger.error(
        `❌ [${payload.triggered_pair}] LLM запрос провалился после ${MAX_RETRIES} попыток. Общее время: ${totalDuration}ms`,
      );
      throw new LLMNetworkError(`LLM request failed after ${MAX_RETRIES} attempts.`);

    } }
