/**
 * @fileoverview Redis Event Stream library for event-driven applications using Redis Streams.
 * Provides publish/subscribe capabilities with consumer groups and reliable message processing.
 */

/** Redis stream group information */
interface RedisGroupInfo {
  name: string;
  consumers: number;
  pending: number;
  "last-delivered-id": string;
  "entries-read"?: number;
  "lag"?: number;
}

/** Redis stream consumer information */
interface RedisConsumerInfo {
  name: string;
  pending: number;
  idle: number;
  "inactive"?: number;
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
  xAdd(
    key: string,
    id: string,
    fields: Record<string, string>,
  ): Promise<string>;
  xTrim(key: string, strategy: string, threshold: number): Promise<number>;
  xGroupCreate(
    key: string,
    group: string,
    id: string,
    options?: { MKSTREAM?: boolean },
  ): Promise<string>;
  xInfoGroups(key: string): Promise<RedisGroupInfo[]>;
  xGroupCreateConsumer(
    key: string,
    group: string,
    consumer: string,
  ): Promise<number>;
  xInfoConsumers(key: string, group: string): Promise<RedisConsumerInfo[]>;
  xReadGroup(
    group: string,
    consumer: string,
    streams: { key: string; id: string } | Array<{ key: string; id: string }>,
    options?: { BLOCK?: number; COUNT?: number },
  ): Promise<RedisStreamResponse[] | null>;
  xAck(key: string, group: string, ...ids: string[]): Promise<number>;
  /** Raw command (node-redis `sendCommand`), used for CLIENT ID/UNBLOCK, XAUTOCLAIM, XPENDING, history reads */
  sendCommand(args: string[]): Promise<unknown>;
  quit?(): Promise<unknown>;
  close?(): Promise<unknown>;
  disconnect?(): Promise<unknown>;
}

/** Logger interface for output */
interface Logger {
  info(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
  warn?(message: unknown, ...args: unknown[]): void;
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
  /** Stream key the entry was read from (new in 0.11.0) */
  streamKey: string;
  /** Delivery count from the PEL; set for entries re-delivered by the PEL drain or XAUTOCLAIM (new in 0.11.0) */
  deliveries?: number;
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

/** PEL drain options (new in 0.11.0) */
interface DrainOptions {
  /** Drain the consumer's own PEL before reading new entries (default true) */
  enabled?: boolean;
  /** Entries delivered more often than this are parked instead of handled (default 5) */
  maxDeliveries?: number;
  /** Stream parked entries are copied to (default `ynohub:parked:<group>`) */
  parkedStream?: string;
  /** XREADGROUP COUNT per drain step (default 50) */
  batch?: number;
}

/** XAUTOCLAIM options (new in 0.11.0) */
interface AutoClaimOptions {
  /** Claim idle entries of other consumers at start and periodically (default true) */
  enabled?: boolean;
  /** Minimum idle time of an entry before it is claimed (default 60000) */
  minIdleMs?: number;
  /** Interval of the periodic claim pass on the main connection (default 60000) */
  everyMs?: number;
  /** XAUTOCLAIM COUNT (default 100) */
  count?: number;
}

/** Per-call options of `StreamHandler.subscribe()` (new in 0.11.0) */
interface SubscribeOptions {
  /** Event filter; same as the legacy second argument */
  events?: string[] | null;
  /** Consumer name for this subscription (default: the constructor `consumer` option) */
  consumer?: string;
  /** Group creation id used with MKSTREAM when the group does not exist (default: constructor `startID`, "$") */
  startId?: string;
  /** XREADGROUP BLOCK in ms (default: constructor `blockMs`, 30000) */
  blockMs?: number;
  /** PEL drain; `false` disables it */
  drain?: DrainOptions | false;
  /** Periodic XAUTOCLAIM; `false` disables it */
  autoClaim?: AutoClaimOptions | false;
}

/** Default size cap of the parked stream */
const PARKED_MAXLEN = 10000;

/** True when a Redis error is BUSYGROUP (group already exists) */
function isBusyGroup(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes("BUSYGROUP") || msg.includes("already exists");
}

/** Converts a flat RESP field list into an object; null for a deleted (trimmed) entry */
function fieldsToRecord(fields: unknown): Record<string, string> | null {
  if (!Array.isArray(fields)) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    out[String(fields[i])] = String(fields[i + 1]);
  }
  return out;
}

/** Raw stream entry as returned by XREADGROUP/XAUTOCLAIM via sendCommand */
interface RawEntry {
  id: string;
  message: Record<string, string> | null;
}

function parseRawEntries(raw: unknown): RawEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: RawEntry[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 1) continue;
    out.push({ id: String(item[0]), message: fieldsToRecord(item[1]) });
  }
  return out;
}

/** Health status for stream monitoring */
interface StreamHealthStatus {
  isAlive: boolean; // Redis connection is active
  isReading: boolean; // Consumer loop is running
  lastActivity: Date | null; // Last message processed time
  pendingMessages: number; // Messages waiting to be processed
  consumerLag: number; // How far behind the consumer is
  messagesProcessed: number; // Total messages processed
  lastError: Error | null; // Last error encountered
  status: "healthy" | "degraded" | "unhealthy";
}

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
  constructor(
    client: RedisClient,
    streamKeyName: string | string[],
    groupName: string,
    options: StreamOptions = {},
  ) {
    this.client = client;
    this.logger = options.logger || console;
    this.streamKeyNames = Array.isArray(streamKeyName)
      ? streamKeyName
      : [streamKeyName];
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
   * The consumer itself is registered by `subscribe()` (0.11.0), with the name
   * passed there, so no stray default consumer name is created in the group.
   *
   * @param streamKeys - Optional specific stream keys to consume from (defaults to all configured streams)
   * @param opts - `startId`: group creation id when the group does not exist (default: constructor `startID`)
   * @returns Stream handler instance or null if creation failed
   */
  async createStream(
    streamKeys?: string | string[],
    opts: { startId?: string } = {},
  ): Promise<StreamHandler | null> {
    const streamOptions: Required<StreamOptions> = {
      ...this.defaultOptions,
      ...this.options,
    };
    const startID = opts.startId ?? streamOptions.startID;

    // Determine which streams to use
    const keysToUse = streamKeys
      ? (Array.isArray(streamKeys) ? streamKeys : [streamKeys])
      : this.streamKeyNames;

    // Create groups and consumers for all streams
    for (const streamKey of keysToUse) {
      const groupOK = await this._createGroup(streamKey, startID);
      if (!groupOK) return null;
    }

    // Create dedicated connection for stream
    const streamClient = this.client.duplicate();
    await streamClient.connect();

    return new StreamHandler(
      streamClient,
      keysToUse,
      this.groupName,
      { ...streamOptions, startID },
      this.logger,
      this.client,
    );
  }

  /**
   * Creates the consumer group at `startId` (MKSTREAM) when it does not exist.
   * An existing group (BUSYGROUP) is left untouched.
   *
   * @param streamKey - Stream key
   * @param startId - Group creation id (default: constructor `startID`, "$")
   */
  async ensureGroup(streamKey: string, startId?: string): Promise<void> {
    if (!this.client.isOpen) await this.client.connect();
    const id = startId ?? this.options.startID ?? this.defaultOptions.startID;
    try {
      await this.client.xGroupCreate(streamKey, this.groupName, id, {
        MKSTREAM: true,
      });
    } catch (error) {
      if (!isBusyGroup(error)) throw error;
    }
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
  async publish(
    event: string,
    aggregateId: string,
    data: unknown,
    headers: Record<string, string>,
    streamKey?: string,
  ): Promise<string> {
    const streamOptions: Required<StreamOptions> = {
      ...this.defaultOptions,
      ...this.options,
    };
    const { timeZone, maxLength } = streamOptions;
    if (!this.client.isOpen) {
      await this.client.connect();
    }

    // Use specified stream key or default to first configured stream
    const targetStreamKey = streamKey || this.streamKeyNames[0];

    // Check payload is an json object, try to parse it if it's a string do not stringify it
    // Add to payload to stream as is if it's not a json object
    let payload: string | unknown = data;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch (_error) {
        payload = data;
      }
    }

    const eventData: EventData = {
      event,
      aggregateId,
      timestamp: this._getLocalTimestamp(timeZone),
      payload: typeof payload === "object"
        ? JSON.stringify(payload)
        : payload as string,
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
  private async _createGroup(
    streamKey: string,
    startID: string,
  ): Promise<boolean> {
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
      this.logger.info(this._formatGroupInfoWithStream(info, streamKey));
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes("already exists")) {
        const info = await this.client.xInfoGroups(streamKey);
        this.logger.info(this._formatGroupInfoWithStream(info, streamKey));
        return true;
      } else {
        this.logger.error(
          error instanceof Error ? error.message : String(error),
        );
        return false;
      }
    }
  }

  /**
   * Formats consumer info to show only name and pending messages.
   *
   * @private
   * @param consumers - Array of consumer information
   * @returns Formatted string for logging
   */
  /**
   * Formats consumer info to show only name and pending messages, and logs the count of consumers on the given stream key.
   *
   * @private
   * @param consumers - Array of consumer information
   * @param streamKey - Stream key associated with the consumers
   * @returns Formatted string for logging
   */
  private _formatConsumerInfoWithStream(
    consumers: RedisConsumerInfo[],
    streamKey: string,
  ): string {
    const count = consumers ? consumers.length : 0;
    return `${count} consumers on ${streamKey}`;
  }

  /**
   * Formats group info to show only name and pending messages.
   *
   * @private
   * @param groups - Array of group information
   * @returns Formatted string for logging
   */
  private _formatGroupInfoWithStream(
    groups: RedisGroupInfo[],
    streamKey: string,
  ): string {
    const count = groups ? groups.length : 0;
    return `${count} groups on ${streamKey}`;
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

  /**
   * Gets comprehensive health status for the stream and optional handler.
   *
   * @param streamHandler - Optional StreamHandler instance to include handler-specific health info
   * @returns Complete health status information
   */
  async getStreamHealth(
    streamHandler?: StreamHandler,
  ): Promise<StreamHealthStatus> {
    let isAlive = false;
    let pendingMessages = 0;
    let consumerLag = 0;

    try {
      // Check Redis connection
      isAlive = this.client.isOpen;
      if (!isAlive && this.client.connect) {
        await this.client.connect();
        isAlive = this.client.isOpen;
      }

      // Get consumer group information
      if (isAlive) {
        try {
          for (const streamKey of this.streamKeyNames) {
            const groups = await this.client.xInfoGroups(streamKey);
            const group = groups.find((g) => g.name === this.groupName);
            if (group) {
              pendingMessages += group.pending || 0;
              consumerLag += group.lag || 0;
            }
          }
        } catch (error) {
          // If we can't get group info, stream might not exist yet
          this.logger.error("Error getting group info:", error);
        }
      }
    } catch (error) {
      isAlive = false;
      this.logger.error("Error checking Redis connection:", error);
    }

    // Get handler-specific health info
    let handlerHealth: Partial<StreamHealthStatus> = {
      isReading: false,
      lastActivity: null,
      messagesProcessed: 0,
      lastError: null,
    };

    if (streamHandler) {
      handlerHealth = streamHandler.getHealthStatus();
    }

    // Determine overall status
    let status: "healthy" | "degraded" | "unhealthy" = "unhealthy";
    if (isAlive) {
      if (handlerHealth.isReading && consumerLag < 1000) {
        status = "healthy";
      } else if (consumerLag < 10000) {
        status = "degraded";
      }
    }

    return {
      isAlive,
      isReading: handlerHealth.isReading || false,
      lastActivity: handlerHealth.lastActivity || null,
      pendingMessages,
      consumerLag,
      messagesProcessed: handlerHealth.messagesProcessed || 0,
      lastError: handlerHealth.lastError || null,
      status,
    };
  }
}

/** Resolved drain options */
type ResolvedDrain = Required<Omit<DrainOptions, "enabled">> & {
  enabled: boolean;
};
/** Resolved autoclaim options */
type ResolvedAutoClaim = Required<AutoClaimOptions>;

/** An entry claimed by the periodic XAUTOCLAIM pass, queued for the main loop */
interface QueuedEntry {
  streamKey: string;
  id: string;
  message: Record<string, string> | null;
  deliveries?: number;
}

/**
 * Handles stream consumption and message processing for Redis Event Streams.
 * Manages message acknowledgment and event filtering for multiple streams.
 *
 * Two connections are used: the dedicated `client` (XREADGROUP BLOCK) and the
 * non-blocking `mainClient` (XACK, XAUTOCLAIM, XPENDING, parking, CLIENT UNBLOCK).
 */
class StreamHandler {
  private client: RedisClient;
  private mainClient: RedisClient;
  private streamKeys: string[];
  private groupName: string;
  private options: Required<StreamOptions>;
  private logger: Logger;
  private isActive = false;
  private lastMessageTime: Date | null = null;
  private messagesProcessed = 0;
  private lastError: Error | null = null;

  private _running = false;
  private _clientId = 0;
  private loopDone: Promise<void> | null = null;
  private claimTimer: ReturnType<typeof setInterval> | null = null;
  private claimInFlight: Promise<void> | null = null;
  private claimQueue: QueuedEntry[] = [];

  /**
   * Creates a new StreamHandler instance.
   *
   * @param client - Dedicated Redis client for streaming (blocking reads)
   * @param streamKeys - Array of Redis stream key names
   * @param groupName - Consumer group name
   * @param options - Stream configuration options
   * @param logger - Logger instance
   * @param mainClient - Non-blocking client for acks/claims (defaults to `client`)
   */
  constructor(
    client: RedisClient,
    streamKeys: string[],
    groupName: string,
    options: Required<StreamOptions>,
    logger: Logger,
    mainClient?: RedisClient,
  ) {
    this.client = client;
    this.mainClient = mainClient ?? client;
    this.streamKeys = streamKeys;
    this.groupName = groupName;
    this.options = options;
    this.logger = logger;
  }

  /** True while the consume loop runs (from subscribe() until it exits) */
  get running(): boolean {
    return this._running;
  }

  /** CLIENT ID of the dedicated (blocking) connection; 0 before the first subscribe() */
  get clientId(): number {
    return this._clientId;
  }

  private warn(message: string, ...args: unknown[]): void {
    (this.logger.warn ?? this.logger.info).call(this.logger, message, ...args);
  }

  /**
   * Acknowledges a message as processed (via the non-blocking main client).
   *
   * @param streamKey - Stream key the message belongs to
   * @param messageId - Redis stream message ID to acknowledge
   * @returns Number of messages acknowledged
   */
  async ack(streamKey: string, messageId: string): Promise<number> {
    return await this.mainClient.xAck(streamKey, this.groupName, messageId);
  }

  /**
   * Creates the consumer group at `startId` (MKSTREAM) when it does not exist.
   * An existing group (BUSYGROUP) is left untouched.
   */
  async ensureGroup(streamKey: string, startId?: string): Promise<void> {
    if (!this.mainClient.isOpen) await this.mainClient.connect();
    try {
      await this.mainClient.xGroupCreate(
        streamKey,
        this.groupName,
        startId ?? this.options.startID,
        { MKSTREAM: true },
      );
    } catch (error) {
      if (!isBusyGroup(error)) throw error;
    }
  }

  /**
   * Subscribes to events from the Redis stream(s).
   *
   * Start sequence per stream: XGROUP CREATE <startId> MKSTREAM (BUSYGROUP ignored)
   * → drain own PEL with a moving cursor (entries delivered more than
   * `maxDeliveries` times are parked) → XAUTOCLAIM of idle entries → `>` loop.
   * XAUTOCLAIM repeats every `autoClaim.everyMs` on the main connection.
   *
   * Resolves when `stop()` is called; rejects (after cleanup) on a fatal loop error,
   * e.g. a handler throw or an XREADGROUP error.
   *
   * @param eventHandler - Async function to handle received events
   * @param filterOrOptions - Event filter (legacy) or {@link SubscribeOptions}
   * @param maybeOptions - {@link SubscribeOptions} when the second argument is a filter
   *
   * @example
   * ```javascript
   * const done = handler.subscribe(onMessage, ["order.created"], { consumer: "svc-1", startId: "0" });
   * // later
   * await handler.stop();
   * await done;
   * ```
   */
  async subscribe(
    eventHandler: EventHandler,
    filterOrOptions: string[] | null | SubscribeOptions = null,
    maybeOptions: SubscribeOptions = {},
  ): Promise<void> {
    let opts: SubscribeOptions;
    let filterEvents: string[] | null;
    if (
      filterOrOptions && !Array.isArray(filterOrOptions) &&
      typeof filterOrOptions === "object"
    ) {
      opts = filterOrOptions;
      filterEvents = opts.events ?? null;
    } else {
      opts = maybeOptions ?? {};
      filterEvents = (filterOrOptions as string[] | null) ?? opts.events ??
        null;
    }

    if (this._running) {
      throw new Error("StreamHandler.subscribe(): already running");
    }

    const consumer = opts.consumer ?? this.options.consumer;
    const startId = opts.startId ?? this.options.startID;
    const blockMs = opts.blockMs ?? this.options.blockMs;
    const drain: ResolvedDrain = {
      enabled: opts.drain !== false && (opts.drain?.enabled ?? true),
      maxDeliveries: (opts.drain || {}).maxDeliveries ?? 5,
      parkedStream: (opts.drain || {}).parkedStream ??
        `ynohub:parked:${this.groupName}`,
      batch: (opts.drain || {}).batch ?? 50,
    };
    const claim: ResolvedAutoClaim = {
      enabled: opts.autoClaim !== false && (opts.autoClaim?.enabled ?? true),
      minIdleMs: (opts.autoClaim || {}).minIdleMs ?? 60000,
      everyMs: (opts.autoClaim || {}).everyMs ?? 60000,
      count: (opts.autoClaim || {}).count ?? 100,
    };

    this._running = true;
    this.isActive = true;
    this.lastError = null;
    this.claimQueue = [];

    let resolveDone!: () => void;
    this.loopDone = new Promise<void>((r) => (resolveDone = r));

    const ctx = { consumer, drain, filterEvents, eventHandler };
    let fatal: unknown = null;

    try {
      if (!this.client.isOpen) await this.client.connect();
      if (!this.mainClient.isOpen) await this.mainClient.connect();
      this._clientId = Number(await this.client.sendCommand(["CLIENT", "ID"]));

      for (const key of this.streamKeys) {
        await this.ensureGroup(key, startId);
        await this.mainClient.xGroupCreateConsumer(
          key,
          this.groupName,
          consumer,
        );
      }

      if (drain.enabled) {
        for (const key of this.streamKeys) {
          if (!this._running) break;
          await this.drainPel(key, ctx);
        }
      }

      if (claim.enabled) {
        for (const key of this.streamKeys) {
          if (!this._running) break;
          for (const e of await this.autoClaim(key, consumer, claim)) {
            if (!this._running) break;
            await this.processEntry(e, ctx);
          }
        }
        if (this._running && claim.everyMs > 0) {
          this.claimTimer = setInterval(() => {
            if (this.claimInFlight || !this._running) return;
            this.claimInFlight = this.periodicClaim(consumer, claim).finally(
              () => (this.claimInFlight = null),
            );
          }, claim.everyMs);
        }
      }

      while (this._running) {
        while (this.claimQueue.length && this._running) {
          await this.processEntry(this.claimQueue.shift()!, ctx);
        }
        if (!this._running) break;

        const streams = this.streamKeys.map((key) => ({ key, id: ">" }));
        const messages = await this.client.xReadGroup(
          this.groupName,
          consumer,
          streams,
          { BLOCK: blockMs, COUNT: 1 },
        );
        if (!messages) continue;

        // Entries returned here are already in our PEL; handle them even when
        // stop() was called meanwhile (the in-flight batch finishes and may ack).
        for (const streamResponse of messages) {
          for (const { id, message } of streamResponse.messages) {
            await this.processEntry(
              { streamKey: streamResponse.name, id, message },
              ctx,
            );
          }
        }
      }
    } catch (error) {
      fatal = error;
      this.lastError = error instanceof Error
        ? error
        : new Error(String(error));
      this.logger.error("Stream processing error:", error);
    } finally {
      this._running = false;
      if (this.claimTimer) clearInterval(this.claimTimer);
      this.claimTimer = null;
      if (this.claimInFlight) await this.claimInFlight.catch(() => {});
      await this.closeDedicated();
      this.isActive = false;
      resolveDone();
    }
    if (fatal) throw fatal;
  }

  /**
   * Stops the consume loop: running=false, CLIENT UNBLOCK on the blocking
   * connection, waits for the loop to exit (an in-flight handler finishes and may
   * ack), then closes the dedicated connection. Safe to call more than once.
   */
  async stop(): Promise<void> {
    const done = this.loopDone;
    this._running = false;
    if (this.claimTimer) clearInterval(this.claimTimer);
    this.claimTimer = null;
    if (!done) {
      // never subscribed: just release the dedicated connection
      await this.closeDedicated();
      return;
    }
    let exited = false;
    done.then(() => (exited = true));
    const unblock = async () => {
      if (exited || !this._clientId) return;
      try {
        if (!this.mainClient.isOpen) return;
        await this.mainClient.sendCommand([
          "CLIENT",
          "UNBLOCK",
          String(this._clientId),
        ]);
      } catch (_) {
        // connection gone: the loop will exit on its own error
      }
    };
    await unblock();
    // re-send until the loop is gone: covers a stop() that lands between the
    // running check and the next XREADGROUP BLOCK
    const iv = setInterval(unblock, 100);
    try {
      await done;
    } finally {
      clearInterval(iv);
    }
  }

  private async closeDedicated(): Promise<void> {
    if (!this.client.isOpen || this.client === this.mainClient) return;
    try {
      if (this.client.quit) await this.client.quit();
      else if (this.client.close) await this.client.close();
      else if (this.client.disconnect) await this.client.disconnect();
    } catch (_) {
      // already closed
    }
  }

  /** Delivery counts of this consumer's PEL entries in [start, end] */
  private async pendingCounts(
    key: string,
    consumer: string,
    start: string,
    end: string,
    count: number,
  ): Promise<Map<string, number>> {
    const raw = await this.mainClient.sendCommand([
      "XPENDING",
      key,
      this.groupName,
      start,
      end,
      String(count),
      consumer,
    ]);
    const out = new Map<string, number>();
    if (Array.isArray(raw)) {
      for (const row of raw) {
        if (Array.isArray(row)) out.set(String(row[0]), Number(row[3]));
      }
    }
    return out;
  }

  /** Number of PEL entries owned by `consumer` */
  private async consumerPendingCount(
    key: string,
    consumer: string,
  ): Promise<number> {
    const raw = await this.mainClient.sendCommand([
      "XPENDING",
      key,
      this.groupName,
    ]);
    if (!Array.isArray(raw) || !Array.isArray(raw[3])) return 0;
    for (const row of raw[3]) {
      if (Array.isArray(row) && String(row[0]) === consumer) {
        return Number(row[1]);
      }
    }
    return 0;
  }

  /**
   * Drains this consumer's own PEL with a moving cursor: XREADGROUP … STREAMS key
   * <lastId> starting at "0", bounded by the XPENDING count taken at start.
   */
  private async drainPel(
    key: string,
    ctx: {
      consumer: string;
      drain: ResolvedDrain;
      filterEvents: string[] | null;
      eventHandler: EventHandler;
    },
  ): Promise<void> {
    const bound = await this.consumerPendingCount(key, ctx.consumer);
    if (bound === 0) return;
    this.logger.info(
      `${this.groupName}/${ctx.consumer}: draining ${bound} pending entries on ${key}`,
    );
    let lastId = "0";
    let seen = 0;
    let parked = 0;
    while (this._running && seen < bound) {
      const raw = await this.client.sendCommand([
        "XREADGROUP",
        "GROUP",
        this.groupName,
        ctx.consumer,
        "COUNT",
        String(Math.min(ctx.drain.batch, bound - seen)),
        "STREAMS",
        key,
        lastId,
      ]);
      const entries = Array.isArray(raw) && Array.isArray(raw[0])
        ? parseRawEntries(raw[0][1])
        : [];
      if (entries.length === 0) break;
      const counts = await this.pendingCounts(
        key,
        ctx.consumer,
        entries[0].id,
        entries[entries.length - 1].id,
        entries.length,
      );
      for (const e of entries) {
        lastId = e.id;
        seen++;
        if (!this._running) break;
        const res = await this.processEntry(
          {
            streamKey: key,
            id: e.id,
            message: e.message,
            deliveries: counts.get(e.id),
          },
          ctx,
        );
        if (res === "parked") parked++;
      }
    }
    this.logger.info(
      `${this.groupName}/${ctx.consumer}: drain of ${key} done (${seen} seen, ${parked} parked)`,
    );
  }

  /**
   * Claims entries idle for at least `minIdleMs` from other consumers
   * (XAUTOCLAIM, fallback XPENDING + XCLAIM below Redis 6.2), on the main client.
   */
  private async autoClaim(
    key: string,
    consumer: string,
    claim: ResolvedAutoClaim,
  ): Promise<QueuedEntry[]> {
    const claimed: RawEntry[] = [];
    let cursor = "0-0";
    try {
      for (let i = 0; i < 1000; i++) {
        const raw = await this.mainClient.sendCommand([
          "XAUTOCLAIM",
          key,
          this.groupName,
          consumer,
          String(claim.minIdleMs),
          cursor,
          "COUNT",
          String(claim.count),
        ]);
        if (!Array.isArray(raw)) break;
        cursor = String(raw[0]);
        claimed.push(...parseRawEntries(raw[1]));
        if (cursor === "0-0") break;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (!/unknown command/i.test(msg)) throw error;
      claimed.push(...await this.claimFallback(key, consumer, claim));
    }
    if (claimed.length === 0) return [];
    this.logger.info(
      `${this.groupName}/${consumer}: claimed ${claimed.length} idle entries on ${key}`,
    );
    const ids = claimed.map((e) => e.id).sort(compareIds);
    const counts = await this.pendingCounts(
      key,
      consumer,
      ids[0],
      ids[ids.length - 1],
      Math.max(claimed.length, claim.count) * 10,
    );
    return claimed.map((e) => ({
      streamKey: key,
      id: e.id,
      message: e.message,
      deliveries: counts.get(e.id),
    }));
  }

  /** XPENDING + XCLAIM for Redis < 6.2 */
  private async claimFallback(
    key: string,
    consumer: string,
    claim: ResolvedAutoClaim,
  ): Promise<RawEntry[]> {
    const raw = await this.mainClient.sendCommand([
      "XPENDING",
      key,
      this.groupName,
      "-",
      "+",
      String(claim.count),
    ]);
    if (!Array.isArray(raw)) return [];
    const ids = raw
      .filter((r) =>
        Array.isArray(r) && String(r[1]) !== consumer &&
        Number(r[2]) >= claim.minIdleMs
      )
      .map((r) => String((r as unknown[])[0]));
    if (ids.length === 0) return [];
    const claimed = await this.mainClient.sendCommand([
      "XCLAIM",
      key,
      this.groupName,
      consumer,
      String(claim.minIdleMs),
      ...ids,
    ]);
    return parseRawEntries(claimed);
  }

  /** Periodic claim pass: queues claimed entries and wakes the blocked reader */
  private async periodicClaim(
    consumer: string,
    claim: ResolvedAutoClaim,
  ): Promise<void> {
    try {
      let added = 0;
      for (const key of this.streamKeys) {
        if (!this._running) return;
        const entries = await this.autoClaim(key, consumer, claim);
        this.claimQueue.push(...entries);
        added += entries.length;
      }
      if (added > 0 && this._running && this._clientId) {
        await this.mainClient.sendCommand([
          "CLIENT",
          "UNBLOCK",
          String(this._clientId),
        ]);
      }
    } catch (error) {
      this.lastError = error instanceof Error
        ? error
        : new Error(String(error));
      this.logger.error("Periodic XAUTOCLAIM failed:", error);
    }
  }

  /** Copies an entry to the parked stream and acks it */
  private async park(
    entry: QueuedEntry,
    consumer: string,
    drain: ResolvedDrain,
    reason: string,
  ): Promise<void> {
    const fields: Record<string, string> = {
      ...(entry.message ?? {}),
      streamKey: entry.streamKey,
      group: this.groupName,
      consumer,
      entryId: entry.id,
      deliveries: String(entry.deliveries ?? 0),
      reason,
    };
    const args = [
      "XADD",
      drain.parkedStream,
      "MAXLEN",
      "~",
      String(PARKED_MAXLEN),
      "*",
    ];
    for (const [k, v] of Object.entries(fields)) args.push(k, v);
    await this.mainClient.sendCommand(args);
    await this.ack(entry.streamKey, entry.id);
    this.warn(
      `${this.groupName}/${consumer}: parked ${entry.streamKey} ${entry.id} → ${drain.parkedStream} (${reason})`,
    );
  }

  /** Handles one entry: ack deleted, park poison, filter, invoke handler */
  private async processEntry(
    entry: QueuedEntry,
    ctx: {
      consumer: string;
      drain: ResolvedDrain;
      filterEvents: string[] | null;
      eventHandler: EventHandler;
    },
  ): Promise<"handled" | "skipped" | "parked" | "deleted"> {
    const { streamKey, id, message } = entry;
    if (!message) {
      // trimmed/deleted entry still referenced by the PEL
      await this.ack(streamKey, id);
      this.warn(
        `${this.groupName}/${ctx.consumer}: acked deleted entry ${streamKey} ${id}`,
      );
      return "deleted";
    }
    if (
      entry.deliveries !== undefined &&
      entry.deliveries > ctx.drain.maxDeliveries
    ) {
      await this.park(
        entry,
        ctx.consumer,
        ctx.drain,
        `delivered ${entry.deliveries} times (max ${ctx.drain.maxDeliveries})`,
      );
      return "parked";
    }

    if (ctx.filterEvents && !ctx.filterEvents.includes(message.event)) {
      await this.ack(streamKey, id);
      return "skipped";
    }

    let payload: unknown = message.payload;
    try {
      payload = JSON.parse(payload as string);
    } catch (_) {
      // Payload is not JSON
    }
    let headers: Record<string, string> = {};
    if (message.headers) {
      try {
        headers = JSON.parse(message.headers as string);
      } catch (_) {
        // Headers are not JSON, use empty object
      }
    }

    const streamMessage: StreamMessage = {
      streamId: id,
      streamKey,
      event: message.event,
      aggregateId: message.aggregateId,
      timestamp: message.timestamp,
      serviceName: message.serviceName,
      mimeType: message.mimeType,
      payload,
      headers,
      ack: () => this.ack(streamKey, id),
    };
    if (entry.deliveries !== undefined) {
      streamMessage.deliveries = entry.deliveries;
    }
    await ctx.eventHandler(streamMessage);
    this.lastMessageTime = new Date();
    this.messagesProcessed++;
    return "handled";
  }

  /**
   * Gets the current health status of this stream handler.
   *
   * @returns Partial health status information from the handler
   */
  getHealthStatus(): Partial<StreamHealthStatus> {
    return {
      isReading: this.isActive,
      lastActivity: this.lastMessageTime,
      messagesProcessed: this.messagesProcessed,
      lastError: this.lastError,
    };
  }
}

/** Orders stream ids numerically ("ms-seq") */
function compareIds(a: string, b: string): number {
  const [am, as] = a.split("-").map(BigInt);
  const [bm, bs] = b.split("-").map(BigInt);
  if (am !== bm) return am < bm ? -1 : 1;
  if ((as ?? 0n) !== (bs ?? 0n)) return (as ?? 0n) < (bs ?? 0n) ? -1 : 1;
  return 0;
}

export { StreamHandler };
export type {
  AutoClaimOptions,
  DrainOptions,
  EventHandler,
  StreamHealthStatus,
  StreamMessage,
  StreamOptions,
  SubscribeOptions,
};
export default RedisEventStream;
