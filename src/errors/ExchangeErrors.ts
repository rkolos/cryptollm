export class ExchangeError extends Error {
  constructor(
    message: string,
    public readonly originalError?: unknown,
  ) {
    super(message);
    this.name = 'ExchangeError';
    Object.setPrototypeOf(this, ExchangeError.prototype);
  }
}

export class ExchangeNetworkError extends ExchangeError {
  constructor(message: string, originalError?: unknown) {
    super(message, originalError);
    this.name = 'ExchangeNetworkError';
    Object.setPrototypeOf(this, ExchangeNetworkError.prototype);
  }
}

export class ExchangeApiError extends ExchangeError {
  constructor(message: string, originalError?: unknown) {
    super(message, originalError);
    this.name = 'ExchangeApiError';
    Object.setPrototypeOf(this, ExchangeApiError.prototype);
  }
}

export class ExchangeRateLimitError extends ExchangeError {
  constructor(message: string, originalError?: unknown) {
    super(message, originalError);
    this.name = 'ExchangeRateLimitError';
    Object.setPrototypeOf(this, ExchangeRateLimitError.prototype);
  }
}

export class InsufficientFundsError extends ExchangeError {
  constructor(
    message: string,
    public readonly required?: string,
    originalError?: unknown,
  ) {
    super(message, originalError);
    this.name = 'InsufficientFundsError';
    Object.setPrototypeOf(this, InsufficientFundsError.prototype);
  }
}

export class OrderNotFoundError extends ExchangeError {
  constructor(
    message: string,
    public readonly orderId?: string,
    originalError?: unknown,
  ) {
    super(message, originalError);
    this.name = 'OrderNotFoundError';
    Object.setPrototypeOf(this, OrderNotFoundError.prototype);
  }
}
