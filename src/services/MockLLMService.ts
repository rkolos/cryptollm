import { LoggingService } from './LoggingService.js';
import type { ILLMService } from '../interfaces/ILLMService.js';
import type { LLMRequest, LLMResponse, LLMDecision } from '../interfaces/ILLMTypes.js';
import type winston from 'winston';

const MOCK_LLM_RESPONSE: LLMResponse = {
  decisions: [
    {
      action: 'OPEN_LONG',
      pair: 'BTC/USDT',
      parameters: {
        type: 'limit',
        price: 30050.0,
        risk_percent: 0.5,
        stop_loss_price: 29800.0,
        take_profit_price: 31000.0,
        trailing_stop_config: null,
      },
      justification:
        "ТА показывает хороший вход, но рынок в 'Extreme Fear' (25), поэтому я захожу с УМЕНЬШЕННЫМ риском (0.5% вместо 1.5%) и с близкой целью (TP).",
    },
  ],
  update_triggers_for_pair: 'BTC/USDT',
  next_call_triggers: {
    reason: 'Отслеживаем новый Limit-ордер по BTC и следим за перепроданностью на 1H.',
    trigger_conditions: [
      { type: 'price', condition: 'below', value: 30050 },
      { type: 'indicator', name: 'rsi', timeframe: '1h', condition: 'below', value: 30 },
      { type: 'timeout', condition: 'minutes_passed', value: 120 },
    ],
  },
  request_additional_data: null,
};

export class MockLLMService implements ILLMService {
  private readonly logger: winston.Logger;

  constructor() {
    this.logger = LoggingService.getInstance().getLogger('MockLLM');
    this.logger.warn('MockLLMService initialized. Using mock responses for LLM calls.');
  }

  public async ask(payload: LLMRequest): Promise<LLMResponse> {
    this.logger.info(`Mock LLM request received for pair: ${payload.triggered_pair}`);

    await new Promise((resolve) => setTimeout(resolve, 350));

    const responseCopy = JSON.parse(JSON.stringify(MOCK_LLM_RESPONSE)) as LLMResponse;

    responseCopy.update_triggers_for_pair = payload.triggered_pair;

    if (responseCopy.decisions.length > 0) {
      responseCopy.decisions = responseCopy.decisions.map((decision: LLMDecision) => ({
        ...decision,
        pair: payload.triggered_pair,
      }));
    }

    this.logger.info(`Mock LLM response sent for pair: ${payload.triggered_pair}`);

    return responseCopy;
  }
}
