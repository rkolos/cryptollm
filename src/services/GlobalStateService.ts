import { LoggingService } from './LoggingService.js';
import type winston from 'winston';

export class GlobalStateService {
  private static instance: GlobalStateService | undefined;

  private isPaused: boolean = false;
  private isShuttingDown: boolean = false;
  private readonly logger: winston.Logger;

  private constructor() {
    this.logger = LoggingService.getInstance().getLogger('GlobalState');
    this.logger.info('GlobalStateService initialized.');
  }

  public static getInstance(): GlobalStateService {
    if (!GlobalStateService.instance) {
      GlobalStateService.instance = new GlobalStateService();
    }
    return GlobalStateService.instance;
  }

  public pause(): void {
    this.isPaused = true;
    this.logger.warn('Application state set to PAUSED. New triggers will be ignored.');
  }

  public resume(): void {
    this.isPaused = false;
    this.logger.info('Application state set to RESUMED.');
  }

  public getIsPaused(): boolean {
    return this.isPaused;
  }

  public startShutdown(): void {
    this.isShuttingDown = true;
    this.logger.warn('Application SHUTDOWN initiated. All cycles will stop.');
  }

  public getIsShuttingDown(): boolean {
    return this.isShuttingDown;
  }

  public isRunning(): boolean {
    return !this.isPaused && !this.isShuttingDown;
  }
}
