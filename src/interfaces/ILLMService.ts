import type { LLMRequest, LLMResponse } from './ILLMTypes.js';

export interface ILLMService {
  ask(payload: LLMRequest): Promise<LLMResponse>;
}
