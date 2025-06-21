/**
 * @fileoverview Custom error types for Redis Event Stream library
 */

/** Base error class for all Redis Event Stream errors */
export class RedisEventStreamError extends Error {
  constructor(message: string, public readonly code: string, public readonly cause?: Error) {
    super(message);
    this.name = 'RedisEventStreamError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/** Error thrown when Redis connection fails */
export class ConnectionError extends RedisEventStreamError {
  constructor(message: string, cause?: Error) {
    super(message, 'CONNECTION_ERROR', cause);
    this.name = 'ConnectionError';
  }
}

/** Error thrown when consumer group operations fail */
export class ConsumerGroupError extends RedisEventStreamError {
  constructor(message: string, public readonly groupName: string, cause?: Error) {
    super(message, 'CONSUMER_GROUP_ERROR', cause);
    this.name = 'ConsumerGroupError';
  }
}

/** Error thrown when message publishing fails */
export class PublishError extends RedisEventStreamError {
  constructor(
    message: string,
    public readonly event: string,
    public readonly aggregateId: string,
    cause?: Error
  ) {
    super(message, 'PUBLISH_ERROR', cause);
    this.name = 'PublishError';
  }
}

/** Error thrown when message processing fails */
export class ProcessingError extends RedisEventStreamError {
  constructor(
    message: string,
    public readonly streamId: string,
    public readonly retryCount: number,
    cause?: Error
  ) {
    super(message, 'PROCESSING_ERROR', cause);
    this.name = 'ProcessingError';
  }
}

/** Error thrown when message acknowledgment fails */
export class AcknowledgmentError extends RedisEventStreamError {
  constructor(message: string, public readonly messageId: string, cause?: Error) {
    super(message, 'ACKNOWLEDGMENT_ERROR', cause);
    this.name = 'AcknowledgmentError';
  }
}

/** Error thrown when event validation fails */
export class ValidationError extends RedisEventStreamError {
  constructor(
    message: string,
    public readonly event: string,
    public readonly errors: string[],
    cause?: Error
  ) {
    super(message, 'VALIDATION_ERROR', cause);
    this.name = 'ValidationError';
  }
}

/** Error thrown when stream configuration is invalid */
export class ConfigurationError extends RedisEventStreamError {
  constructor(message: string, public readonly field: string, cause?: Error) {
    super(message, 'CONFIGURATION_ERROR', cause);
    this.name = 'ConfigurationError';
  }
}

/** Error thrown when consumer timeout occurs */
export class TimeoutError extends RedisEventStreamError {
  constructor(message: string, public readonly timeoutMs: number, cause?: Error) {
    super(message, 'TIMEOUT_ERROR', cause);
    this.name = 'TimeoutError';
  }
}

/** Error thrown when maximum retries exceeded */
export class MaxRetriesExceededError extends RedisEventStreamError {
  constructor(
    message: string,
    public readonly maxRetries: number,
    public readonly streamId: string,
    cause?: Error
  ) {
    super(message, 'MAX_RETRIES_EXCEEDED', cause);
    this.name = 'MaxRetriesExceededError';
  }
}

/** Error thrown when schema version mismatch occurs */
export class SchemaVersionError extends RedisEventStreamError {
  constructor(
    message: string,
    public readonly event: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
    cause?: Error
  ) {
    super(message, 'SCHEMA_VERSION_ERROR', cause);
    this.name = 'SchemaVersionError';
  }
}

/** Helper function to determine if error is retryable */
export function isRetryableError(error: Error): boolean {
  if (error instanceof RedisEventStreamError) {
    return ![
      'VALIDATION_ERROR',
      'CONFIGURATION_ERROR',
      'SCHEMA_VERSION_ERROR'
    ].includes(error.code);
  }
  return false;
}

/** Helper function to create error with context */
export function createErrorWithContext(
  error: Error,
  context: Record<string, unknown>
): RedisEventStreamError {
  const message = `${error.message} - Context: ${JSON.stringify(context)}`;
  if (error instanceof RedisEventStreamError) {
    return new RedisEventStreamError(message, error.code, error);
  }
  return new RedisEventStreamError(message, 'UNKNOWN_ERROR', error);
}