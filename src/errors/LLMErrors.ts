export class LLMError extends Error {
  public readonly originalError: unknown;

  constructor(message: string, originalError: unknown = null) {
    super(message);
    this.name = this.constructor.name;
    this.originalError = originalError;
    Object.setPrototypeOf(this, LLMError.prototype);
  }
}

export class LLMNetworkError extends LLMError {
  constructor(message: string, originalError?: unknown) {
    super(message, originalError);
    this.name = 'LLMNetworkError';
    Object.setPrototypeOf(this, LLMNetworkError.prototype);
  }
}

export class LLMAuthError extends LLMError {
  constructor(message: string, originalError?: unknown) {
    super(message, originalError);
    this.name = 'LLMAuthError';
    Object.setPrototypeOf(this, LLMAuthError.prototype);
  }
}

export class LLMRequestError extends LLMError {
  constructor(message: string, originalError?: unknown) {
    super(message, originalError);
    this.name = 'LLMRequestError';
    Object.setPrototypeOf(this, LLMRequestError.prototype);
  }
}

export class LLMResponseFormatError extends LLMError {
  public readonly validationErrors: unknown;

  constructor(message: string, validationErrors: unknown = null, originalError: unknown = null) {
    super(message, originalError);
    this.name = 'LLMResponseFormatError';
    this.validationErrors = validationErrors;
    Object.setPrototypeOf(this, LLMResponseFormatError.prototype);
  }
}
