import winston from 'winston';
import fs from 'fs';
import path from 'path';
import { ConfigService } from './ConfigService.js';

export class LoggingService {
  private static instance: LoggingService | undefined;
  private readonly mainLogger: winston.Logger;

  private constructor(config: ConfigService) {
    const appMode = config.getAppMode();
    const logDir = 'logs';

    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const transports: winston.transport[] = [];

    if (appMode === 'dry_run') {
      const devConsoleFormat = winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.splat(),
        winston.format.errors({ stack: true }),
        winston.format.printf(({ timestamp, level, message, context, stack }) => {
          const contextStr = context ? `[${context}]` : '';
          const stackStr = stack ? `\n${stack}` : '';
          return `${timestamp} ${level}: ${contextStr} ${message}${stackStr}`;
        }),
      );

      transports.push(
        new winston.transports.Console({
          format: devConsoleFormat,
          level: 'debug',
        }),
      );
    } else {
      const jsonFormat = winston.format.combine(
        winston.format.timestamp(),
        winston.format.splat(),
        winston.format.errors({ stack: true }),
        winston.format.json(),
      );

      transports.push(
        new winston.transports.File({
          filename: path.join(logDir, 'error.log'),
          level: 'error',
          format: jsonFormat,
        }),
      );

      transports.push(
        new winston.transports.File({
          filename: path.join(logDir, 'combined.log'),
          format: jsonFormat,
        }),
      );

      const prodConsoleFormat = winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.splat(),
        winston.format.errors({ stack: true }),
        winston.format.printf(({ timestamp, level, message, context, stack }) => {
          const contextStr = context ? `[${context}]` : '';
          const stackStr = stack ? `\n${stack}` : '';
          return `${timestamp} ${level.toUpperCase()}: ${contextStr} ${message}${stackStr}`;
        }),
      );

      transports.push(
        new winston.transports.Console({
          format: prodConsoleFormat,
          level: 'info',
        }),
      );
    }

    this.mainLogger = winston.createLogger({
      level: appMode === 'dry_run' ? 'debug' : 'info',
      transports: transports,
    });
  }

  public static initialize(): void {
    const config = ConfigService.getInstance();
    LoggingService.instance = new LoggingService(config);
  }

  public static getInstance(): LoggingService {
    if (!LoggingService.instance) {
      throw new Error('LoggingService must be initialized before use (call initialize())');
    }
    return LoggingService.instance;
  }

  public getLogger(context: string): winston.Logger {
    return this.mainLogger.child({ context: context });
  }
}
