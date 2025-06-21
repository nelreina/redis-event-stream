/**
 * @fileoverview Type definitions for Redis Event Stream library
 */

/** Redis stream group information */
export interface RedisGroupInfo {
  name: string;
  consumers: number;
  pending: number;
  'last-delivered-id': string;
  'entries-read'?: number;
  'lag'?: number;
}

/** Redis stream consumer information */
export interface RedisConsumerInfo {
  name: string;
  pending: number;
  idle: number;
  'inactive'?: number;
}

/** Redis stream message data */
export interface RedisStreamMessage {
  id: string;
  message: Record<string, string>;
}

/** Redis stream read response */
export interface RedisStreamResponse {
  name: string;
  messages: RedisStreamMessage[];
}

/** Redis client interface for stream operations */
export interface RedisClient {
  isOpen: boolean;
  connect(): Promise<void>;
  duplicate(): RedisClient;
  xAdd(key: string, id: string, fields: Record<string, string>): Promise<string>;
  xTrim(key: string, strategy: string, threshold: number): Promise<number>;
  xGroupCreate(key: string, group: string, id: string, options?: { MKSTREAM?: boolean }): Promise<string>;
  xInfoGroups(key: string): Promise<RedisGroupInfo[]>;
  xGroupCreateConsumer(key: string, group: string, consumer: string): Promise<number>;
  xInfoConsumers(key: string, group: string): Promise<RedisConsumerInfo[]>;
  xReadGroup(group: string, consumer: string, streams: { key: string; id: string }, options?: { BLOCK?: number; COUNT?: number }): Promise<RedisStreamResponse[] | null>;
  xAck(key: string, group: string, ...ids: string[]): Promise<number>;
  ping(): Promise<string>;
  quit(): Promise<void>;
}

/** Logger interface for output */
export interface Logger {
  info(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
  warn?(message: unknown, ...args: unknown[]): void;
  debug?(message: unknown, ...args: unknown[]): void;
}

/** Configuration options for RedisEventStream */
export interface StreamOptions {
  logger?: Logger;
  blockMs?: number;
  autoAck?: boolean;
  startID?: string;
  consumer?: string;
  timeZone?: string;
  maxLength?: number;
  initLog?: boolean;
  maxRetries?: number;
  retryDelayMs?: number;
  deadLetterStream?: string;
  enableMetrics?: boolean;
  connectionPoolSize?: number;
  prefetchCount?: number;
}

/** Event metadata for tracking and debugging */
export interface EventMetadata {
  correlationId?: string;
  causationId?: string;
  userId?: string;
  version?: number;
  source?: string;
  [key: string]: unknown;
}

/** Base event structure with generic payload type */
export interface Event<T = unknown> {
  event: string;
  aggregateId: string;
  timestamp: string;
  payload: T;
  serviceName: string;
  mimeType?: string;
  metadata?: EventMetadata;
}

/** Message structure received from Redis stream with generic payload */
export interface StreamMessage<T = unknown> extends Event<T> {
  streamId: string;
  ack: () => Promise<number>;
  nack: () => Promise<void>;
  retryCount?: number;
}

/** Event handler function type with generic payload */
export type EventHandler<T = unknown> = (message: StreamMessage<T>) => Promise<void>;

/** Middleware function type */
export type Middleware<T = unknown> = (
  message: StreamMessage<T>,
  next: () => Promise<void>
) => Promise<void>;

/** Event schema for validation */
export interface EventSchema<T = unknown> {
  event: string;
  version: number;
  validate: (payload: unknown) => T;
  upgrade?: (payload: unknown, fromVersion: number) => T;
}

/** Metrics interface for monitoring */
export interface StreamMetrics {
  messagesPublished: number;
  messagesConsumed: number;
  messagesAcknowledged: number;
  messagesFailed: number;
  consumerLag: number;
  processingTimeMs: number[];
}

/** Health check status */
export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: {
    redis: boolean;
    consumer: boolean;
    lag: number;
  };
  timestamp: string;
}

/** Batch publish options */
export interface BatchPublishOptions {
  maxBatchSize?: number;
  flushIntervalMs?: number;
  onError?: (error: Error, events: Event[]) => void;
}

/** Consumer options for advanced configuration */
export interface ConsumerOptions extends StreamOptions {
  concurrency?: number;
  processingTimeout?: number;
  errorHandler?: (error: Error, message: StreamMessage) => Promise<void>;
}

/** Stream ID brand type for type safety */
export type StreamId = string & { readonly __brand: unique symbol };

/** Aggregate ID brand type for type safety */
export type AggregateId = string & { readonly __brand: unique symbol };

/** Result type for error handling */
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

/** Event type discriminated union helper */
export type EventType<T extends { event: string }> = T['event'];

/** Extract payload type from event */
export type EventPayload<T extends Event> = T['payload'];