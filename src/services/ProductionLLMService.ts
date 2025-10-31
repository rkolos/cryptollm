import axios, { AxiosInstance, AxiosError, isAxiosError } from 'axios';
import type winston from 'winston';
import { ConfigService } from './ConfigService.js';
import { LoggingService } from './LoggingService.js';
import type { ILLMService } from '../interfaces/ILLMService.js';
import type { LLMRequest, LLMResponse } from '../interfaces/ILLMTypes.js';
import { llmResponseSchema } from '../interfaces/ILLMTypes.zod.js';
import {
  LLMError,
  LLMNetworkError,
  LLMAuthError,
  LLMRequestError,
  LLMResponseFormatError,
} from '../errors/LLMErrors.js';

const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 1000;
const REQUEST_TIMEOUT_MS = 30000;

export class ProductionLLMService implements ILLMService {
  private readonly logger: winston.Logger;
  private readonly httpClient: AxiosInstance;
  private readonly modelName: string;

  constructor() {
    this.logger = LoggingService.getInstance().getLogger('ProdLLM');
    const config = ConfigService.getInstance();
    const llmConfig = config.getLlmConfig();

    if (!llmConfig.apiUrl || !llmConfig.apiKey || !llmConfig.modelName) {
      this.logger.error(
        'FATAL: LLM_API_URL, LLM_API_KEY, or LLM_MODEL_NAME is not set. ProductionLLMService cannot start.',
      );
      throw new Error('LLM_API_URL, LLM_API_KEY, or LLM_MODEL_NAME is missing.');
    }

    this.modelName = llmConfig.modelName;

    this.httpClient = axios.create({
      baseURL: llmConfig.apiUrl,
      headers: {
        Authorization: `Bearer ${llmConfig.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: REQUEST_TIMEOUT_MS,
    });

    this.logger.info(`ProductionLLMService is active. Using real LLM API. Model: [${this.modelName}]`);
  }

  public async ask(payload: LLMRequest): Promise<LLMResponse> {
    this.logger.info(`Sending request to LLM for [${payload.triggered_pair}]...`);

    this.logger.debug('ProductionLLMService Request Payload:', {
      pair: payload.triggered_pair,
      question: payload.question,
      context: payload.strategy_context?.macro_context,
    });

    try {
      const responseData = await this.executeRequestWithRetry(payload);

      let dataToValidate: unknown = responseData;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const responseDataTyped = responseData as any;

      if (responseDataTyped.choices && responseDataTyped.choices[0]?.message?.content) {
        try {
          const content = responseDataTyped.choices[0].message.content;
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
          // Добавляем информацию о типе только для ошибок invalid_type
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

        // Логируем каждую ошибку отдельно для лучшей читаемости
        parseResult.error.issues.forEach((issue, index) => {
          const errorInfo: Record<string, unknown> = {
            path: issue.path.join('.') || 'root',
            message: issue.message,
            code: issue.code,
          };
          if (issue.code === 'invalid_type') {
            const invalidTypeIssue = issue as { received?: unknown; expected?: string };
            errorInfo.received = typeof invalidTypeIssue.received;
            errorInfo.expected = invalidTypeIssue.expected;
            // Добавляем фактическое значение для лучшей диагностики
            if (issue.path.length > 0) {
              try {
                let currentValue: unknown = dataToValidate;
                for (const key of issue.path) {
                  const keyStr = String(key);
                  if (
                    currentValue &&
                    typeof currentValue === 'object' &&
                    currentValue !== null &&
                    (keyStr in currentValue || (typeof key === 'number' && Array.isArray(currentValue)))
                  ) {
                    if (Array.isArray(currentValue) && typeof key === 'number') {
                      currentValue = currentValue[key];
                    } else {
                      currentValue = (currentValue as Record<string, unknown>)[keyStr];
                    }
                  } else {
                    currentValue = undefined;
                    break;
                  }
                }
                errorInfo.actualValue = currentValue;
              } catch {
                // Игнорируем ошибки при доступе к значению
              }
            }
          }
          this.logger.error(`Validation error ${index + 1}/${parseResult.error.issues.length}:`, errorInfo);
        });

        throw new LLMResponseFormatError('LLM response format is invalid.', parseResult.error.issues, dataToValidate);
      }

      this.logger.info(`Received and validated LLM response for [${payload.triggered_pair}].`);

      return parseResult.data as LLMResponse;
    } catch (error) {
      if (error instanceof LLMError) {
        throw error;
      }

      this.logger.error('Unhandled error during LLM "ask"', { error: String(error) });
      throw new LLMError(String(error), error);
    }
  }

  private async executeRequestWithRetry(payload: LLMRequest): Promise<unknown> {
    const requestBody = {
      messages: [
        {
          role: 'user',
          content: JSON.stringify(payload),
        },
      ],
      model: this.modelName,
      response_format: { type: 'json_object' },
    };

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await this.httpClient.post('/v1/chat/completions', requestBody);
        return response.data;
      } catch (error) {
        if (!isAxiosError(error)) {
          throw error;
        }

        const axiosError = error as AxiosError;

        if (axiosError.response) {
          const status = axiosError.response.status;

          if (status === 429 || status >= 500) {
            const delay = 2 ** attempt * INITIAL_BACKOFF_MS + Math.random() * 1000;
            this.logger.warn(
              `LLM API returned ${status}. Retrying (attempt ${attempt + 1}/${MAX_RETRIES}) in ${delay.toFixed(0)}ms...`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }

          if (status === 401 || status === 403) {
            this.logger.error(`LLM API Auth Error (Status ${status}). Check LLM_API_KEY.`, {
              data: axiosError.response.data,
            });
            throw new LLMAuthError(`LLM Auth Error (Status ${status})`, axiosError);
          }

          if (status === 400) {
            this.logger.error(`LLM API Bad Request (Status 400). Check payload structure.`, {
              data: axiosError.response.data,
            });
            throw new LLMRequestError(`LLM Bad Request (Status 400)`, axiosError);
          }
        } else if (axiosError.code === 'ECONNABORTED' || axiosError.request) {
          const delay = 2 ** attempt * INITIAL_BACKOFF_MS + Math.random() * 1000;
          this.logger.warn(
            `LLM Network Error or Timeout (Code: ${axiosError.code}). Retrying (attempt ${attempt + 1}/${MAX_RETRIES})...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        throw error;
      }
    }

    this.logger.error(`LLM request failed after ${MAX_RETRIES} attempts.`);
    throw new LLMNetworkError(`LLM request failed after ${MAX_RETRIES} attempts.`);
  }
}
