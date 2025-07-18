/**
 * @fileoverview Redis Event Stream library for event-driven applications using Redis Streams.
 * Provides publish/subscribe capabilities with consumer groups and reliable message processing.
 */

/** Redis stream group information */
interface RedisGroupInfo {
  name: string;
  consumers: number;
  pending: number;
  'last-delivered-id': string;
  'entries-read'?: number;
  'lag'?: number;
}

/** Redis stream consumer information */
interface RedisConsumerInfo {
  name: string;
  pending: number;
  idle: number;
  'inactive'?: number;
}

/** Redis stream message data */
interface RedisStreamMessage {
  id: string;
  message: Record<string, string>;
}

/** Redis stream read response */
interface RedisStreamResponse {
  name: string;
  messages: RedisStreamMessage[];
}

/** Redis client interface for stream operations */
interface RedisClient {
  isOpen: boolean;
  connect(): Promise<void>;
  duplicate(): RedisClient;
  xAdd(key: string, id: string, fields: Record<string, string>): Promise<string>;
  xTrim(key: string, strategy: string, threshold: number): Promise<number>;
  xGroupCreate(key: string, group: string, id: string, options?: { MKSTREAM?: boolean }): Promise<string>;
  xInfoGroups(key: string): Promise<RedisGroupInfo[]>;
  xGroupCreateConsumer(key: string, group: string, consumer: string): Promise<number>;
  xInfoConsumers(key: string, group: string): Promise<RedisConsumerInfo[]>;
  xReadGroup(group: string, consumer: string, streams: { key: string; id: string } | Array<{ key: string; id: string }>, options?: { BLOCK?: number; COUNT?: number }): Promise<RedisStreamResponse[] | null>;
  xAck(key: string, group: string, ...ids: string[]): Promise<number>;
}

/** Logger interface for output */
interface Logger {
  info(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
  log?(message: unknown, ...args: unknown[]): void;
}

/** Configuration options for RedisEventStream */
interface StreamOptions {
  logger?: Logger;
  blockMs?: number;
  autoAck?: boolean;
  startID?: string;
  consumer?: string;
  timeZone?: string;
  maxLength?: number;
  initLog?: boolean;
}

/** Event data structure for published events */
interface EventData {
  event: string;
  aggregateId: string;
  timestamp: string;
  payload: string;
  serviceName: string;
  mimeType?: string;
  headers: Record<string, string>;
}

/** Message structure received from Redis stream */
interface StreamMessage {
  streamId: string;
  event: string;
  aggregateId: string;
  timestamp: string;
  serviceName: string;
  mimeType?: string;
  payload: unknown;
  headers: Record<string, string>;
  ack: () => Promise<number>;
}

/** Event handler function type */
type EventHandler = (message: StreamMessage) => Promise<void>;

/**
 * Redis Event Stream client for publishing and subscribing to events using Redis Streams.
 * Supports consumer groups, automatic acknowledgments, and configurable stream management.
 * 
 * @example
 * ```javascript
 * const redis = new Redis();
 * const eventStream = new RedisEventStream(redis, "orders", "order-processor");
 * 
 * // Publisher
 * await eventStream.publish("order.created", "order123", {
 *   id: "order123",
 *   amount: 100,
 *   currency: "USD"
 * });
 * 
 * // Subscriber
 * const ordersStream = await eventStream.createStream();
 * await ordersStream.subscribe(async ({ event, payload, ack }) => {
 *   console.log(`Received ${event}:`, payload);
 *   await ack();
 * }, ["order.created", "order.updated"]);
 * ```
 */
class RedisEventStream {
  private client: RedisClient;
  private logger: Logger;
  private streamKeyNames: string[];
  private groupName: string;
  private options: StreamOptions;
  private defaultOptions: Required<StreamOptions>;

  /**
   * Creates a new RedisEventStream instance.
   * 
   * @param client - Redis client instance (ioredis or similar)
   * @param streamKeyName - Name of the Redis stream key or array of stream keys
   * @param groupName - Name of the consumer group
   * @param options - Configuration options
   */
  constructor(client: RedisClient, streamKeyName: string | string[], groupName: string, options: StreamOptions = {}) {
    this.client = client;
    this.logger = options.logger || console;
    this.streamKeyNames = Array.isArray(streamKeyName) ? streamKeyName : [streamKeyName];
    this.groupName = groupName;
    this.options = options;
    this.defaultOptions = {
      logger: console,
      blockMs: 30000,
      autoAck: false,
      startID: "$",
      consumer: "consumer-1",
      timeZone: "America/Curacao",
      maxLength: 10000,
      initLog: true,
    };
    if (this.options.initLog) {
      console.log("RedisEventStream -> this.options", this.options);
    }
  }

  /**
   * Creates a stream handler for consuming messages from the Redis stream(s).
   * Sets up consumer group and consumer if they don't exist.
   * 
   * @param streamKeys - Optional specific stream keys to consume from (defaults to all configured streams)
   * @returns Stream handler instance or null if creation failed
   */
  async createStream(streamKeys?: string | string[]): Promise<StreamHandler | null> {
    const streamOptions: Required<StreamOptions> = { ...this.defaultOptions, ...this.options };
    const { startID, consumer } = streamOptions;

    // Determine which streams to use
    const keysToUse = streamKeys 
      ? (Array.isArray(streamKeys) ? streamKeys : [streamKeys])
      : this.streamKeyNames;

    // Create groups and consumers for all streams
    for (const streamKey of keysToUse) {
      const groupOK = await this._createGroup(streamKey, startID);
      if (!groupOK) return null;

      const consumerOK = await this._createConsumer(streamKey, consumer);
      if (!consumerOK) return null;
    }

    // Create dedicated connection for stream
    const streamClient = this.client.duplicate();
    await streamClient.connect();

    return new StreamHandler(
      streamClient,
      keysToUse,
      this.groupName,
      streamOptions,
      this.logger,
    );
  }

  /**
   * Publishes an event to the Redis stream.
   * 
   * @param event - Event type/name
   * @param aggregateId - Unique identifier for the aggregate/entity
   * @param data - Event payload data (will be JSON stringified)
   * @param headers - Optional headers as key-value pairs
   * @param streamKey - Optional specific stream key to publish to (defaults to first configured stream)
   * @returns Redis stream message ID
   */
  async publish(event: string, aggregateId: string, data: unknown, headers: Record<string, string>, streamKey?: string): Promise<string> {
    const streamOptions: Required<StreamOptions> = { ...this.defaultOptions, ...this.options };
    const { timeZone, maxLength } = streamOptions;
    if (!this.client.isOpen) {
      await this.client.connect();
    }

    // Use specified stream key or default to first configured stream
    const targetStreamKey = streamKey || this.streamKeyNames[0];

    const eventData: EventData = {
      event,
      aggregateId,
      timestamp: this._getLocalTimestamp(timeZone),
      payload: JSON.stringify(data),
      serviceName: this.groupName,
      headers,
    };

    const resp = await this.client.xAdd(
      targetStreamKey,
      "*",
      {
        event: eventData.event,
        aggregateId: eventData.aggregateId,
        timestamp: eventData.timestamp,
        payload: eventData.payload,
        serviceName: eventData.serviceName,
        ...(eventData.mimeType && { mimeType: eventData.mimeType }),
        headers: JSON.stringify(eventData.headers),
      },
    );
    await this.client.xTrim(targetStreamKey, "MAXLEN", maxLength);
    return resp;
  }

  /**
   * Creates a consumer group for the stream if it doesn't exist.
   * 
   * @private
   * @param streamKey - Stream key to create group for
   * @param startID - Starting message ID for the group
   * @returns True if group was created or already exists
   */
  private async _createGroup(streamKey: string, startID: string): Promise<boolean> {
    try {
      await this.client.xGroupCreate(
        streamKey,
        this.groupName,
        startID,
        {
          MKSTREAM: true,
        },
      );
      this.logger.info(
        `${this.groupName} created for key: ${streamKey}!`,
      );
      const info = await this.client.xInfoGroups(streamKey);
      this.logger.info(this._formatGroupInfo(info));
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes("already exists")) {
        const info = await this.client.xInfoGroups(streamKey);
        this.logger.info(this._formatGroupInfo(info));
        return true;
      } else {
        this.logger.error(error instanceof Error ? error.message : String(error));
        return false;
      }
    }
  }

  /**
   * Creates a consumer within the consumer group.
   * 
   * @private
   * @param streamKey - Stream key to create consumer for
   * @param consumer - Consumer name
   * @returns True if consumer was created successfully
   */
  private async _createConsumer(streamKey: string, consumer: string): Promise<boolean> {
    try {
      await this.client.xGroupCreateConsumer(
        streamKey,
        this.groupName,
        consumer,
      );
      const info = await this.client.xInfoConsumers(
        streamKey,
        this.groupName,
      );
      this.logger.info(this._formatConsumerInfo(info));
      return true;
    } catch (error) {
      this.logger.error(
        "LOG:  ~ file: redis-stream.js ~ line 9 ~ error",
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  /**
   * Formats consumer info to show only name and pending messages.
   * 
   * @private
   * @param consumers - Array of consumer information
   * @returns Formatted string for logging
   */
  private _formatConsumerInfo(consumers: RedisConsumerInfo[]): string {
    if (!consumers || consumers.length === 0) {
      return "No consumers found";
    }
    
    const header = "Consumer Info:";
    const formattedConsumers = consumers
      .map(consumer => `  - ${consumer.name}: ${consumer.pending} pending`)
      .join("\n");
    
    return `${header}\n${formattedConsumers}`;
  }

  /**
   * Formats group info to show only name and pending messages.
   * 
   * @private
   * @param groups - Array of group information
   * @returns Formatted string for logging
   */
  private _formatGroupInfo(groups: RedisGroupInfo[]): string {
    if (!groups || groups.length === 0) {
      return "No groups found";
    }
    
    const header = "Group Info:";
    const formattedGroups = groups
      .map(group => `  - ${group.name}: ${group.pending} pending`)
      .join("\n");
    
    return `${header}\n${formattedGroups}`;
  }

  /**
   * Generates a localized timestamp string for the specified timezone.
   * 
   * @private
   * @param timeZone - Target timezone for the timestamp
   * @returns Formatted timestamp string
   */
  private _getLocalTimestamp(timeZone: string): string {
    const options: Intl.DateTimeFormatOptions = {
      timeZone: timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      hour12: false,
    };

    const date = new Date();
    const timestamp = date
      .toLocaleString("sv-SE", options)
      .replace(" ", "T")
      .replace(",", "")
      .replace(/(\d{2}:\d{2}:\d{2})/, "$1.");
    return timestamp;
  }
}

/**
 * Handles stream consumption and message processing for Redis Event Streams.
 * Manages message acknowledgment and event filtering for multiple streams.
 */
class StreamHandler {
  private client: RedisClient;
  private streamKeys: string[];
  private groupName: string;
  private options: Required<StreamOptions>;
  private logger: Logger;

  /**
   * Creates a new StreamHandler instance.
   * 
   * @param client - Dedicated Redis client for streaming
   * @param streamKeys - Array of Redis stream key names
   * @param groupName - Consumer group name
   * @param options - Stream configuration options
   * @param logger - Logger instance
   */
  constructor(client: RedisClient, streamKeys: string[], groupName: string, options: Required<StreamOptions>, logger: Logger) {
    this.client = client;
    this.streamKeys = streamKeys;
    this.groupName = groupName;
    this.options = options;
    this.logger = logger;
  }

  /**
   * Acknowledges a message as processed.
   * 
   * @param streamKey - Stream key the message belongs to
   * @param messageId - Redis stream message ID to acknowledge
   * @returns Number of messages acknowledged
   */
  async ack(streamKey: string, messageId: string): Promise<number> {
    return await this.client.xAck(
      streamKey,
      this.groupName,
      messageId,
    );
  }

  /**
   * Subscribes to events from multiple Redis streams with optional event filtering.
   * Continuously processes messages until an error occurs or the process is terminated.
   * 
   * @param eventHandler - Async function to handle received events
   * @param filterEvents - Array of event types to process, or null for all events
   * @throws Throws error if stream processing fails
   * 
   * @example
   * ```javascript
   * await streamHandler.subscribe(async ({ event, payload, ack }) => {
   *   console.log(`Processing ${event}:`, payload);
   *   await ack(); // Acknowledge message processing
   * }, ["order.created", "order.updated"]);
   * ```
   */
  async subscribe(eventHandler: EventHandler, filterEvents: string[] | null = null): Promise<void> {
    const { blockMs, consumer } = this.options;

    try {
      while (true) {
        // Build streams array for xReadGroup with multiple streams
        const streams = this.streamKeys.map(key => ({ key, id: ">" }));
        
        const messages = await this.client.xReadGroup(
          this.groupName,
          consumer,
          streams,
          { BLOCK: blockMs, COUNT: 1 },
        );

        if (!messages) continue;

        // Process messages from all streams
        for (const streamResponse of messages) {
          const streamKey = streamResponse.name;
          
          for (const streamData of streamResponse.messages) {
            const { id, message } = streamData;

            // Parse message payload
            let payload: unknown = message.payload;
            try {
              payload = JSON.parse(payload as string);
            } catch (_) {
              // Payload is not JSON
            }

            // Parse headers
            let headers: Record<string, string> = {};
            if (message.headers) {
              try {
                headers = JSON.parse(message.headers as string);
              } catch (_) {
                // Headers are not JSON, use empty object
              }
            }

            // Check if we should process this event
            if (!filterEvents || filterEvents.includes(message.event)) {
              const streamMessage: StreamMessage = {
                streamId: id,
                event: message.event,
                aggregateId: message.aggregateId,
                timestamp: message.timestamp,
                serviceName: message.serviceName,
                mimeType: message.mimeType,
                payload,
                headers,
                ack: () => this.ack(streamKey, id),
              };
              await eventHandler(streamMessage);
            } else {
              await this.ack(streamKey, id);
            }
          }
        }
      }
    } catch (error) {
      this.logger.error("Stream processing error:", error);
      throw error;
    }
  }
}

export default RedisEventStream;
