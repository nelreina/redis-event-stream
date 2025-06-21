/**
 * @fileoverview Built-in middleware functions for event processing
 */

import type { Middleware, StreamMessage, Logger } from './types.ts';

/**
 * Create logging middleware
 */
export function createLoggingMiddleware(logger: Logger = console): Middleware {
  return async (message, next) => {
    const startTime = Date.now();
    
    logger.info(`Processing event: ${message.event}`, {
      streamId: message.streamId,
      aggregateId: message.aggregateId,
      timestamp: message.timestamp,
      metadata: message.metadata,
    });

    try {
      await next();
      
      const duration = Date.now() - startTime;
      logger.info(`Event processed successfully: ${message.event}`, {
        streamId: message.streamId,
        duration: `${duration}ms`,
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(`Event processing failed: ${message.event}`, {
        streamId: message.streamId,
        duration: `${duration}ms`,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}

/**
 * Create metrics middleware
 */
export function createMetricsMiddleware(
  onMetric: (metric: {
    event: string;
    duration: number;
    success: boolean;
    error?: Error;
  }) => void
): Middleware {
  return async (message, next) => {
    const startTime = Date.now();
    let success = true;
    let error: Error | undefined;

    try {
      await next();
    } catch (err) {
      success = false;
      error = err as Error;
      throw err;
    } finally {
      const duration = Date.now() - startTime;
      onMetric({
        event: message.event,
        duration,
        success,
        error,
      });
    }
  };
}

/**
 * Create retry middleware
 */
export function createRetryMiddleware(
  maxRetries = 3,
  retryDelayMs = 1000,
  shouldRetry?: (error: Error) => boolean
): Middleware {
  return async (message, next) => {
    let lastError: Error | undefined;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await next();
        return; // Success
      } catch (error) {
        lastError = error as Error;
        
        // Check if we should retry
        if (shouldRetry && !shouldRetry(lastError)) {
          throw lastError;
        }
        
        // Don't retry if this is the last attempt
        if (attempt === maxRetries) {
          throw lastError;
        }
        
        // Wait before retrying
        await new Promise(resolve => 
          setTimeout(resolve, retryDelayMs * Math.pow(2, attempt))
        );
      }
    }
    
    throw lastError;
  };
}

/**
 * Create timeout middleware
 */
export function createTimeoutMiddleware(timeoutMs: number): Middleware {
  return async (message, next) => {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Event processing timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    await Promise.race([next(), timeoutPromise]);
  };
}

/**
 * Create error handler middleware
 */
export function createErrorHandlerMiddleware(
  errorHandler: (error: Error, message: StreamMessage) => Promise<void>
): Middleware {
  return async (message, next) => {
    try {
      await next();
    } catch (error) {
      await errorHandler(error as Error, message);
      throw error; // Re-throw to maintain error flow
    }
  };
}

/**
 * Create correlation ID middleware
 */
export function createCorrelationMiddleware(): Middleware {
  return async (message, next) => {
    // Ensure correlation ID exists
    if (!message.metadata?.correlationId) {
      message.metadata = {
        ...message.metadata,
        correlationId: crypto.randomUUID(),
      };
    }
    
    await next();
  };
}

/**
 * Create validation middleware
 */
export function createValidationMiddleware<T>(
  validate: (payload: unknown) => T | Promise<T>
): Middleware<T> {
  return async (message, next) => {
    try {
      const validated = await validate(message.payload);
      // Replace payload with validated version
      (message as any).payload = validated;
      await next();
    } catch (error) {
      throw new Error(`Validation failed: ${error}`);
    }
  };
}

/**
 * Create circuit breaker middleware
 */
export function createCircuitBreakerMiddleware(
  threshold = 5,
  resetTimeMs = 60000
): Middleware {
  let failureCount = 0;
  let lastFailureTime = 0;
  let isOpen = false;

  return async (message, next) => {
    // Check if circuit should be reset
    if (isOpen && Date.now() - lastFailureTime > resetTimeMs) {
      isOpen = false;
      failureCount = 0;
    }

    // If circuit is open, fail fast
    if (isOpen) {
      throw new Error('Circuit breaker is open');
    }

    try {
      await next();
      // Reset failure count on success
      failureCount = 0;
    } catch (error) {
      failureCount++;
      lastFailureTime = Date.now();
      
      if (failureCount >= threshold) {
        isOpen = true;
      }
      
      throw error;
    }
  };
}

/**
 * Create deduplication middleware
 */
export function createDeduplicationMiddleware(
  cache: Map<string, number>,
  ttlMs = 60000
): Middleware {
  return async (message, next) => {
    const key = `${message.event}:${message.aggregateId}:${message.streamId}`;
    const now = Date.now();
    
    // Check if message was recently processed
    const lastProcessed = cache.get(key);
    if (lastProcessed && now - lastProcessed < ttlMs) {
      // Skip duplicate message
      await message.ack();
      return;
    }
    
    // Process message and update cache
    await next();
    cache.set(key, now);
    
    // Clean up old entries
    for (const [k, timestamp] of cache) {
      if (now - timestamp > ttlMs) {
        cache.delete(k);
      }
    }
  };
}

/**
 * Compose multiple middlewares into one
 */
export function composeMiddleware(...middlewares: Middleware[]): Middleware {
  return async (message, next) => {
    const chain = middlewares.reduceRight(
      (nextFn, middleware) => async () => middleware(message, nextFn),
      next
    );
    await chain();
  };
}