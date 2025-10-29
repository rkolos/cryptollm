import { EventEmitter } from 'eventemitter3';
import { LoggingService } from './LoggingService.js';
import type winston from 'winston';

export interface TradeExecutedEvent {
  pair: string;
}

export class EventBusService extends EventEmitter {
  private static instance: EventBusService | undefined;
  private readonly logger: winston.Logger;

  private constructor() {
    super();
    this.logger = LoggingService.getInstance().getLogger('EventBus');
    this.logger.info('EventBusService initialized.');
  }

  public static getInstance(): EventBusService {
    if (!EventBusService.instance) {
      EventBusService.instance = new EventBusService();
    }
    return EventBusService.instance;
  }

  public emitTradeExecuted(pair: string): void {
    this.logger.debug(`Emitting trade_executed event for pair: ${pair}`);
    this.emit('trade_executed', { pair });
  }
}
