export class ValidationError extends Error {
  public readonly isHold: boolean;

  constructor(message: string, isHold: boolean = false) {
    super(message);
    this.name = 'ValidationError';
    this.isHold = isHold;
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}
