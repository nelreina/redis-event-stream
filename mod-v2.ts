/**
 * @fileoverview Redis Event Stream library v2 with improved API
 */

import type {
  RedisClient,
  Logger,
  StreamOptions,
  Event,
  StreamMessage,
  EventHandler,
  Middleware,
  EventSchema,
  StreamMetrics,
  HealthStatus,
  BatchPublishOptions,
  ConsumerOptions,
  Result,
  EventMetadata,
} from './types.ts';

import {
  ConnectionError,
  ConsumerGroupError,
  PublishError,
  ProcessingError,
  AcknowledgmentError,
  ConfigurationError,
  TimeoutError,
  MaxRetriesExceededError,
  isRetryableError,
} from './errors.ts';

import { EventSchemaRegistry } from './schema-registry.ts';
import { MetricsCollector } from './metrics.ts';
import { ConnectionPool } from './connection-pool.ts';

/**
 * Builder class for configuring Redis Event Stream instances
 */
export class RedisEventStreamBuilder {
  private options: Partial<StreamOptions> = {};
  private schemas = new Map<string, EventSchema>();
  private middlewares: Middleware[] = [];

  constructor(
    private client: RedisClient,
    private streamKey: string,
    private consumerGroup: string
  ) {}

  /** Set logger instance */
  withLogger(logger: Logger): this {
    this.options.logger = logger;
    return this;
  }

  /** Set block timeout for stream reads */
  withBlockTimeout(ms: number): this {
    this.options.blockMs = ms;
    return this;
  }

  /** Enable automatic acknowledgment */
  withAutoAck(enabled = true): this {
    this.options.autoAck = enabled;
    return this;
  }

  /** Set starting message ID */
  withStartId(id: string): this {
    this.options.startID = id;
    return this;
  }

  /** Set consumer name */
  withConsumer(name: string): this {
    this.options.consumer = name;
    return this;
  }

  /** Set timezone for timestamps */
  withTimeZone(tz: string): this {
    this.options.timeZone = tz;
    return this;
  }

  /** Set maximum stream length */
  withMaxLength(length: number): this {
    this.options.maxLength = length;
    return this;
  }

  /** Set retry configuration */
  withRetries(maxRetries: number, delayMs: number): this {
    this.options.maxRetries = maxRetries;
    this.options.retryDelayMs = delayMs;
    return this;
  }

  /** Set dead letter stream */
  withDeadLetterStream(streamKey: string): this {
    this.options.deadLetterStream = streamKey;
    return this;
  }

  /** Enable metrics collection */
  withMetrics(enabled = true): this {
    this.options.enableMetrics = enabled;
    return this;
  }

  /** Set connection pool size */
  withConnectionPool(size: number): this {
    this.options.connectionPoolSize = size;
    return this;
  }

  /** Add event schema for validation */
  withSchema<T>(schema: EventSchema<T>): this {
    this.schemas.set(schema.event, schema);
    return this;
  }

  /** Add middleware */
  withMiddleware(middleware: Middleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  /** Build the RedisEventStream instance */
  build(): RedisEventStream {
    return new RedisEventStream(
      this.client,
      this.streamKey,
      this.consumerGroup,
      this.options,
      this.schemas,
      this.middlewares
    );
  }
}

/**
 * Main Redis Event Stream class with improved API
 */
export class RedisEventStream {
  private logger: Logger;
  private schemaRegistry: EventSchemaRegistry;
  private metrics?: MetricsCollector;
  private connectionPool?: ConnectionPool;
  private readonly defaultOptions: Required<StreamOptions>;

  constructor(
    private client: RedisClient,
    private streamKey: string,
    private consumerGroup: string,
    private options: Partial<StreamOptions> = {},
    schemas: Map<string, EventSchema> = new Map(),
    private middlewares: Middleware[] = []
  ) {
    this.defaultOptions = {
      logger: console,
      blockMs: 30000,
      autoAck: false,
      startID: '$',
      consumer: 'consumer-1',
      timeZone: 'UTC',
      maxLength: 10000,
      initLog: false,
      maxRetries: 3,
      retryDelayMs: 1000,
      deadLetterStream: `${streamKey}:dlq`,
      enableMetrics: false,
      connectionPoolSize: 1,
      prefetchCount: 1,
    };

    const finalOptions = { ...this.defaultOptions, ...options };
    this.logger = finalOptions.logger;
    this.schemaRegistry = new EventSchemaRegistry(schemas);

    if (finalOptions.enableMetrics) {
      this.metrics = new MetricsCollector();
    }

    if (finalOptions.connectionPoolSize > 1) {
      this.connectionPool = new ConnectionPool(client, finalOptions.connectionPoolSize);
    }
  }

  /**
   * Create a builder for configuring a new instance
   */
  static builder(client: RedisClient, streamKey: string, consumerGroup: string): RedisEventStreamBuilder {
    return new RedisEventStreamBuilder(client, streamKey, consumerGroup);
  }

  /**
   * Publish a single event with type safety
   */
  async publish<T>(
    event: string,
    aggregateId: string,
    payload: T,
    metadata?: EventMetadata
  ): Promise<Result<string>> {
    try {
      const client = await this.getClient();
      
      // Validate schema if registered
      if (this.schemaRegistry.hasSchema(event)) {
        const validationResult = this.schemaRegistry.validate(event, payload);
        if (!validationResult.ok) {
          return { ok: false, error: validationResult.error };
        }
      }

      const eventData: Event<T> = {
        event,
        aggregateId,
        timestamp: this.getTimestamp(),
        payload,
        serviceName: this.consumerGroup,
        metadata: {
          ...metadata,
          version: this.schemaRegistry.getVersion(event),
        },
      };

      const messageId = await client.xAdd(
        this.streamKey,
        '*',
        this.serializeEvent(eventData)
      );

      // Trim stream
      await client.xTrim('MAXLEN', this.getOption('maxLength'));

      this.metrics?.recordPublish(event);
      
      return { ok: true, value: messageId };
    } catch (error) {
      const publishError = new PublishError(
        `Failed to publish event: ${error}`,
        event,
        aggregateId,
        error as Error
      );
      return { ok: false, error: publishError };
    }
  }

  /**
   * Publish multiple events in batch
   */
  async publishBatch<T>(
    events: Array<{
      event: string;
      aggregateId: string;
      payload: T;
      metadata?: EventMetadata;
    }>,
    options?: BatchPublishOptions
  ): Promise<Result<string[]>> {
    const client = await this.getClient();
    const messageIds: string[] = [];
    const errors: Error[] = [];

    try {
      // Process in batches
      const batchSize = options?.maxBatchSize || 100;
      for (let i = 0; i < events.length; i += batchSize) {
        const batch = events.slice(i, i + batchSize);
        
        await Promise.all(
          batch.map(async (event) => {
            const result = await this.publish(
              event.event,
              event.aggregateId,
              event.payload,
              event.metadata
            );
            
            if (result.ok) {
              messageIds.push(result.value);
            } else {
              errors.push(result.error);
              options?.onError?.(result.error, [event as any]);
            }
          })
        );
      }

      if (errors.length > 0) {
        return { ok: false, error: new Error(`Batch publish partially failed: ${errors.length} errors`) };
      }

      return { ok: true, value: messageIds };
    } catch (error) {
      return { ok: false, error: error as Error };
    }
  }

  /**
   * Create a consumer for processing events
   */
  async createConsumer<T = unknown>(
    eventHandler: EventHandler<T>,
    options?: ConsumerOptions
  ): Promise<Result<StreamConsumer<T>>> {
    try {
      const finalOptions = { ...this.defaultOptions, ...this.options, ...options };
      
      // Initialize consumer group
      const groupResult = await this.initializeConsumerGroup();
      if (!groupResult.ok) {
        return { ok: false, error: groupResult.error };
      }

      // Create consumer
      const consumer = new StreamConsumer<T>(
        this.client,
        this.streamKey,
        this.consumerGroup,
        eventHandler,
        finalOptions,
        this.middlewares,
        this.schemaRegistry,
        this.metrics
      );

      return { ok: true, value: consumer };
    } catch (error) {
      return { ok: false, error: error as Error };
    }
  }

  /**
   * Get health status of the stream
   */
  async getHealth(): Promise<HealthStatus> {
    try {
      const client = await this.getClient();
      
      // Check Redis connection
      const redisOk = await client.ping() === 'PONG';
      
      // Check consumer group
      const groups = await client.xInfoGroups(this.streamKey);
      const group = groups.find(g => g.name === this.consumerGroup);
      const consumerOk = !!group;
      const lag = group?.lag || 0;

      const status = redisOk && consumerOk && lag < 1000 
        ? 'healthy' 
        : lag > 10000 
        ? 'unhealthy' 
        : 'degraded';

      return {
        status,
        checks: {
          redis: redisOk,
          consumer: consumerOk,
          lag,
        },
        timestamp: this.getTimestamp(),
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        checks: {
          redis: false,
          consumer: false,
          lag: -1,
        },
        timestamp: this.getTimestamp(),
      };
    }
  }

  /**
   * Get stream metrics
   */
  getMetrics(): StreamMetrics | undefined {
    return this.metrics?.getMetrics();
  }

  /**
   * Initialize consumer group and consumer
   */
  private async initializeConsumerGroup(): Promise<Result<void>> {
    try {
      const client = await this.getClient();
      
      // Create group
      try {
        await client.xGroupCreate(
          this.streamKey,
          this.consumerGroup,
          this.getOption('startID'),
          { MKSTREAM: true }
        );
        this.logger.info(`Consumer group ${this.consumerGroup} created`);
      } catch (error: any) {
        if (!error.message?.includes('already exists')) {
          throw new ConsumerGroupError(
            'Failed to create consumer group',
            this.consumerGroup,
            error
          );
        }
      }

      // Create consumer
      const consumerName = this.getOption('consumer');
      await client.xGroupCreateConsumer(
        this.streamKey,
        this.consumerGroup,
        consumerName
      );

      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: error as Error };
    }
  }

  /**
   * Get client from pool or use direct client
   */
  private async getClient(): Promise<RedisClient> {
    if (this.connectionPool) {
      const result = await this.connectionPool.getConnection();
      if (!result.ok) throw result.error;
      return result.value;
    }

    if (!this.client.isOpen) {
      await this.client.connect();
    }

    return this.client;
  }

  /**
   * Get option value
   */
  private getOption<K extends keyof StreamOptions>(key: K): Required<StreamOptions>[K] {
    return (this.options[key] ?? this.defaultOptions[key]) as Required<StreamOptions>[K];
  }

  /**
   * Get timestamp in configured timezone
   */
  private getTimestamp(): string {
    return new Date().toISOString();
  }

  /**
   * Serialize event to Redis hash format
   */
  private serializeEvent<T>(event: Event<T>): Record<string, string> {
    return {
      event: event.event,
      aggregateId: event.aggregateId,
      timestamp: event.timestamp,
      payload: JSON.stringify(event.payload),
      serviceName: event.serviceName,
      ...(event.metadata && { metadata: JSON.stringify(event.metadata) }),
      ...(event.mimeType && { mimeType: event.mimeType }),
    };
  }
}

/**
 * Stream consumer for processing events
 */
export class StreamConsumer<T = unknown> {
  private running = false;
  private abortController?: AbortController;

  constructor(
    private client: RedisClient,
    private streamKey: string,
    private consumerGroup: string,
    private eventHandler: EventHandler<T>,
    private options: Required<ConsumerOptions>,
    private middlewares: Middleware[],
    private schemaRegistry: EventSchemaRegistry,
    private metrics?: MetricsCollector
  ) {}

  /**
   * Start consuming events
   */
  async start(eventFilter?: string[]): Promise<void> {
    if (this.running) {
      throw new Error('Consumer is already running');
    }

    this.running = true;
    this.abortController = new AbortController();

    while (this.running && !this.abortController.signal.aborted) {
      try {
        await this.processMessages(eventFilter);
      } catch (error) {
        if (!isRetryableError(error as Error)) {
          throw error;
        }
        this.options.logger.error('Stream processing error:', error);
        await this.delay(this.options.retryDelayMs);
      }
    }
  }

  /**
   * Stop consuming events
   */
  async stop(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
    await this.client.quit();
  }

  /**
   * Process messages from the stream
   */
  private async processMessages(eventFilter?: string[]): Promise<void> {
    const messages = await this.client.xReadGroup(
      this.consumerGroup,
      this.options.consumer,
      { key: this.streamKey, id: '>' },
      { BLOCK: this.options.blockMs, COUNT: this.options.prefetchCount }
    );

    if (!messages) return;

    for (const stream of messages) {
      for (const message of stream.messages) {
        await this.processMessage(message, eventFilter);
      }
    }
  }

  /**
   * Process a single message
   */
  private async processMessage(
    message: RedisStreamMessage,
    eventFilter?: string[]
  ): Promise<void> {
    const startTime = Date.now();

    try {
      const streamMessage = this.parseMessage<T>(message);

      // Apply event filter
      if (eventFilter && !eventFilter.includes(streamMessage.event)) {
        await streamMessage.ack();
        return;
      }

      // Apply middlewares
      await this.applyMiddlewares(streamMessage, async () => {
        await this.eventHandler(streamMessage);
      });

      // Record metrics
      this.metrics?.recordConsume(streamMessage.event, Date.now() - startTime);

      // Auto-acknowledge if enabled
      if (this.options.autoAck) {
        await streamMessage.ack();
      }
    } catch (error) {
      await this.handleProcessingError(message, error as Error);
    }
  }

  /**
   * Parse Redis message to typed StreamMessage
   */
  private parseMessage<T>(message: RedisStreamMessage): StreamMessage<T> {
    const { id, message: data } = message;
    
    let payload: T;
    let metadata: EventMetadata | undefined;

    try {
      payload = JSON.parse(data.payload);
      if (data.metadata) {
        metadata = JSON.parse(data.metadata);
      }
    } catch (error) {
      throw new ProcessingError(
        'Failed to parse message payload',
        id,
        0,
        error as Error
      );
    }

    return {
      streamId: id,
      event: data.event,
      aggregateId: data.aggregateId,
      timestamp: data.timestamp,
      serviceName: data.serviceName,
      mimeType: data.mimeType,
      payload,
      metadata,
      ack: async () => {
        const result = await this.client.xAck(this.streamKey, this.consumerGroup, id);
        this.metrics?.recordAck(data.event);
        return result;
      },
      nack: async () => {
        // Move to pending list for retry
        this.metrics?.recordNack(data.event);
      },
    };
  }

  /**
   * Apply middleware chain
   */
  private async applyMiddlewares(
    message: StreamMessage<T>,
    handler: () => Promise<void>
  ): Promise<void> {
    const chain = [...this.middlewares].reverse().reduce(
      (next, middleware) => async () => middleware(message, next),
      handler
    );

    await chain();
  }

  /**
   * Handle processing errors with retry logic
   */
  private async handleProcessingError(
    message: RedisStreamMessage,
    error: Error
  ): Promise<void> {
    this.options.logger.error('Message processing failed:', error);
    this.metrics?.recordError(message.message.event);

    // Implement retry logic here if needed
    // For now, just log the error
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Re-export types and utilities
export * from './types.ts';
export * from './errors.ts';
export { EventSchemaRegistry } from './schema-registry.ts';
export { createLoggingMiddleware, createMetricsMiddleware } from './middleware.ts';