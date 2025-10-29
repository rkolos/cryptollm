import { LoggingService } from './LoggingService.js';
import { DatabaseService } from './DatabaseService.js';
import type { LLMDecision } from '../interfaces/ILLMTypes.js';
import type winston from 'winston';

/**
 * WorkerService - минимальная stub-реализация для задачи 8.1
 * Полная реализация будет в задаче 7.1-7.5
 */
export class WorkerService {
  private static instance: WorkerService | undefined;
  private readonly logger: winston.Logger;
  private readonly databaseService: DatabaseService;

  private constructor(databaseService: DatabaseService) {
    this.databaseService = databaseService;
    this.logger = LoggingService.getInstance().getLogger('Worker');
    this.logger.info('WorkerService initialized (stub implementation).');
  }

  public static getInstance(databaseService: DatabaseService): WorkerService {
    if (!WorkerService.instance) {
      WorkerService.instance = new WorkerService(databaseService);
    }
    return WorkerService.instance;
  }

  /**
   * Выполнение решения LLM (stub-реализация)
   * Полная реализация будет в задаче 7.1-7.5
   */
  public async execute(decision: LLMDecision, llm_decision_log_id: string): Promise<void> {
    this.logger.info(`[${decision.pair}] WorkerService.execute() called: ${decision.action} (stub)`);

    try {
      // Обновляем статус в LLM_Decision_Log
      await this.databaseService.query(
        `UPDATE LLM_Decision_Log 
         SET decision_result = $1, worker_error_message = $2
         WHERE id = $3`,
        ['executed', null, llm_decision_log_id],
      );

      this.logger.debug(`[${decision.pair}] LLM_Decision_Log updated: ${llm_decision_log_id}`);
    } catch (error) {
      this.logger.error(`[${decision.pair}] Error updating LLM_Decision_Log:`, error);

      // Пытаемся обновить с ошибкой
      try {
        await this.databaseService.query(
          `UPDATE LLM_Decision_Log 
           SET decision_result = $1, worker_error_message = $2
           WHERE id = $3`,
          ['error', String(error), llm_decision_log_id],
        );
      } catch (updateError) {
        this.logger.error(`[${decision.pair}] Failed to update error status:`, updateError);
      }

      throw error;
    }
  }
}
