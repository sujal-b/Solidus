/** Typed error hierarchy for solidus */

export class SolidusError extends Error {
  public readonly code: string;
  public readonly isOperational: boolean;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = "SolidusError";
    this.code = code;
    this.isOperational = true;
    if (cause instanceof Error) this.cause = cause;
  }
}

export class ValidationError extends SolidusError {
  constructor(message: string, cause?: unknown) {
    super("VALIDATION_ERROR", message, cause);
    this.name = "ValidationError";
  }
}

export class HistoryError extends SolidusError {
  constructor(message: string, cause?: unknown) {
    super("HISTORY_ERROR", message, cause);
    this.name = "HistoryError";
  }
}

export class LockError extends SolidusError {
  constructor(message: string, cause?: unknown) {
    super("LOCK_ERROR", message, cause);
    this.name = "LockError";
  }
}

export class ConfigError extends SolidusError {
  constructor(message: string, cause?: unknown) {
    super("CONFIG_ERROR", message, cause);
    this.name = "ConfigError";
  }
}

export class IoError extends SolidusError {
  constructor(public override readonly code: string, message: string, cause?: unknown) {
    super(code, message, cause);
    this.name = "IoError";
  }
}
