# Redis Event Stream (v0.10.2)

A powerful, production-ready Redis Streams library for building event-driven applications with reliable message processing, consumer groups, and comprehensive health monitoring.

[![JSR](https://jsr.io/badges/@nelreina/redis-stream-event)](https://jsr.io/@nelreina/redis-stream-event)
[![JSR Score](https://jsr.io/badges/@nelreina/redis-stream-event/score)](https://jsr.io/@nelreina/redis-stream-event)

## 🚀 Key Features

- **🔒 Production Ready**: Battle-tested Redis Streams implementation
- **👥 Consumer Groups**: Reliable message processing with automatic group/consumer creation
- **🔄 Multi-Stream Support**: Handle multiple streams with a single instance
- **📊 Health Monitoring**: Built-in health checks for production deployments
- **⚡ High Performance**: Configurable blocking reads, stream trimming, and batch processing
- **🛡️ Error Resilient**: Robust error handling and recovery mechanisms
- **🧪 Testing Friendly**: Works with any Redis-compatible client (ioredis, node-redis, etc.)
- **🌍 Timezone Support**: Configurable timestamp formatting

## 📦 Installation

### Deno
```bash
deno add jsr:@nelreina/redis-stream-event
```

### Node.js
```bash
npx jsr add @nelreina/redis-stream-event
```

## 🎯 Quick Start

```typescript
import { Redis } from "ioredis";
import RedisEventStream from "@nelreina/redis-stream-event";

// Create Redis client
const redis = new Redis({
  host: "localhost",
  port: 6379,
});

// Create event stream
const eventStream = new RedisEventStream(
  redis,
  "orders",           // Stream name
  "order-service",    // Consumer group
  {
    consumer: "worker-1",
    blockMs: 30000,
    autoAck: false,
    maxLength: 10000,
  }
);

// Publisher: Send events to the stream
await eventStream.publish(
  "order.created",
  "order-123",
  {
    orderId: "order-123",
    customerId: "cust-456",
    amount: 99.99,
    items: [{ sku: "ITEM-1", quantity: 2 }],
  },
  { correlationId: "req-789" }  // headers
);

// Consumer: Process events from the stream
const streamHandler = await eventStream.createStream();

await streamHandler.subscribe(async (message) => {
  console.log(`Processing ${message.event} for ${message.aggregateId}`);
  console.log("Payload:", message.payload);
  console.log("Headers:", message.headers);

  try {
    // Your business logic here
    await processOrder(message.payload);

    // Acknowledge successful processing
    await message.ack();
  } catch (error) {
    console.error("Processing failed:", error);
    // Don't ack - message will remain in pending state
  }
}, ["order.created", "order.updated"]); // Optional event filter
```

## 📚 Advanced Usage

### Multi-Stream Processing

```typescript
// Handle multiple streams
const eventStream = new RedisEventStream(
  redis,
  ["orders", "inventory", "payments"],  // Multiple streams
  "commerce-service"
);

const handler = await eventStream.createStream();

// Process events from all streams
await handler.subscribe(async (message) => {
  switch (message.event) {
    case "order.created":
      await handleOrderCreated(message);
      break;
    case "inventory.updated":
      await handleInventoryUpdate(message);
      break;
    case "payment.processed":
      await handlePaymentProcessed(message);
      break;
  }
  await message.ack();
});
```

### Custom Configuration

```typescript
const eventStream = new RedisEventStream(redis, "events", "service", {
  logger: customLogger,        // Custom logger (default: console)
  blockMs: 60000,             // Block timeout in ms (default: 30000)
  autoAck: true,              // Auto-acknowledge messages (default: false)
  startID: "0",               // Start from beginning (default: "$")
  consumer: "worker-1",        // Consumer name (default: "consumer-1")
  timeZone: "UTC",            // Timezone for timestamps (default: "America/Curacao")
  maxLength: 50000,           // Stream max length (default: 10000)
  initLog: false,             // Disable init logging (default: true)
});
```

### Event Filtering

```typescript
// Only process specific event types
await handler.subscribe(async (message) => {
  console.log(`Processing: ${message.event}`);
  await message.ack();
}, ["user.created", "user.updated", "user.deleted"]);

// Process all events (no filter)
await handler.subscribe(async (message) => {
  console.log(`Processing: ${message.event}`);
  await message.ack();
});
```

### JSON Payload Handling

```typescript
// Complex objects are automatically JSON serialized/deserialized
await eventStream.publish("user.profile.updated", "user-123", {
  profile: {
    name: "John Doe",
    email: "john@example.com",
    preferences: {
      notifications: true,
      theme: "dark"
    }
  },
  metadata: {
    source: "profile-service",
    version: "1.2.0"
  }
}, { requestId: "req-456" });

// In consumer - payload is automatically parsed
await handler.subscribe(async (message) => {
  const data = message.payload; // Already parsed as object
  console.log("User name:", data.profile.name);
  console.log("Source:", data.metadata.source);
  await message.ack();
});
```

## 🩺 Health Monitoring

The library provides comprehensive health monitoring for production deployments:

### Health Check Methods

```typescript
import RedisEventStream, { StreamHealthStatus } from "@nelreina/redis-stream-event";

const eventStream = new RedisEventStream(redis, "events", "service");
const handler = await eventStream.createStream();

// Start consumer
handler.subscribe(async (msg) => {
  await processMessage(msg);
  await msg.ack();
});

// Get comprehensive health status
const health: StreamHealthStatus = await eventStream.getStreamHealth(handler);
console.log("Health status:", health);
```

### StreamHealthStatus Interface

```typescript
interface StreamHealthStatus {
  isAlive: boolean;           // Redis connection is active
  isReading: boolean;         // Consumer loop is running
  lastActivity: Date | null;  // Last message processed time
  pendingMessages: number;    // Messages waiting to be processed
  consumerLag: number;        // How far behind the consumer is
  messagesProcessed: number;  // Total messages processed
  lastError: Error | null;    // Last error encountered
  status: 'healthy' | 'degraded' | 'unhealthy';
}
```

### Health Status Levels

- **healthy**: Redis connected, consumer reading, lag < 1000 messages
- **degraded**: Redis connected, but lag 1000-10000 messages or consumer not reading
- **unhealthy**: Redis disconnected or lag > 10000 messages

### Production Health Endpoint

```typescript
// Express.js health endpoint
app.get('/health', async (req, res) => {
  try {
    const health = await eventStream.getStreamHealth(handler);
    const statusCode = health.status === 'healthy' ? 200 :
                       health.status === 'degraded' ? 200 : 503;
    res.status(statusCode).json(health);
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});
```

### Kubernetes Health Probes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: event-processor
spec:
  template:
    spec:
      containers:
      - name: app
        image: myapp:latest
        ports:
        - containerPort: 3000
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 2
```

## 🏗️ API Reference

### RedisEventStream

#### Constructor

```typescript
new RedisEventStream(
  client: RedisClient,
  streamKeyName: string | string[],
  groupName: string,
  options?: StreamOptions
)
```

**Parameters:**
- `client`: Redis client instance (ioredis, node-redis, etc.)
- `streamKeyName`: Stream name(s) - string for single stream, array for multiple
- `groupName`: Consumer group name (acts as service identifier)
- `options`: Optional configuration

#### Methods

##### `publish(event, aggregateId, data, headers, streamKey?)`
Publishes an event to the Redis stream.

**Parameters:**
- `event`: Event type/name (string)
- `aggregateId`: Unique identifier for the entity (string)
- `data`: Event payload (any serializable data)
- `headers`: Event headers (Record<string, string>)
- `streamKey`: Optional specific stream (defaults to first configured stream)

**Returns:** `Promise<string>` - Redis stream message ID

##### `createStream(streamKeys?)`
Creates a stream handler for consuming messages.

**Parameters:**
- `streamKeys`: Optional specific stream keys to consume from

**Returns:** `Promise<StreamHandler | null>` - Stream handler instance

##### `getStreamHealth(streamHandler?)`
Gets comprehensive health status for the stream.

**Parameters:**
- `streamHandler`: Optional StreamHandler for detailed metrics

**Returns:** `Promise<StreamHealthStatus>` - Complete health status

### StreamHandler

#### Methods

##### `subscribe(eventHandler, filterEvents?)`
Subscribes to events from the stream(s) with optional filtering.

**Parameters:**
- `eventHandler`: Async function to handle received events
- `filterEvents`: Optional array of event types to process

**Returns:** `Promise<void>` - Runs until error or termination

##### `ack(streamKey, messageId)`
Acknowledges a message as processed.

**Parameters:**
- `streamKey`: Stream key the message belongs to
- `messageId`: Redis stream message ID

**Returns:** `Promise<number>` - Number of messages acknowledged

##### `getHealthStatus()`
Gets handler-specific health information.

**Returns:** `Partial<StreamHealthStatus>` - Handler health status

### StreamMessage Interface

```typescript
interface StreamMessage {
  streamId: string;        // Redis stream message ID
  event: string;           // Event type
  aggregateId: string;     // Entity identifier
  timestamp: string;       // Event timestamp
  serviceName: string;     // Publishing service name
  mimeType?: string;       // Content type (optional)
  payload: unknown;        // Event data (parsed from JSON)
  headers: Record<string, string>; // Event headers
  ack: () => Promise<number>;      // Acknowledgment function
}
```

### StreamOptions Interface

```typescript
interface StreamOptions {
  logger?: Logger;         // Custom logger (default: console)
  blockMs?: number;        // Block timeout in ms (default: 30000)
  autoAck?: boolean;       // Auto acknowledge (default: false)
  startID?: string;        // Start consuming from (default: "$")
  consumer?: string;       // Consumer name (default: "consumer-1")
  timeZone?: string;       // Timezone (default: "America/Curacao")
  maxLength?: number;      // Max stream length (default: 10000)
  initLog?: boolean;       // Log initialization (default: true)
}
```

## 🛡️ Error Handling

The library provides robust error handling:

```typescript
try {
  const messageId = await eventStream.publish("event", "id", data, {});
  console.log("Published with ID:", messageId);
} catch (error) {
  console.error("Publish failed:", error);
  // Handle publish failure
}

// Consumer error handling
await handler.subscribe(async (message) => {
  try {
    await processMessage(message);
    await message.ack();
  } catch (processingError) {
    console.error("Processing failed:", processingError);
    // Don't ack - message remains pending for retry

    // Optionally implement dead letter queue logic
    if (shouldSendToDeadLetter(processingError)) {
      await sendToDeadLetterQueue(message);
      await message.ack(); // Ack to remove from main stream
    }
  }
});
```

## 🌍 Timezone Support

Configure timestamp formatting for your timezone:

```typescript
const eventStream = new RedisEventStream(redis, "events", "service", {
  timeZone: "UTC",              // UTC timestamps
  // timeZone: "America/New_York", // Eastern time
  // timeZone: "Europe/London",    // London time
  // timeZone: "Asia/Tokyo",       // Japan time
});
```

Timestamps are formatted as: `YYYY-MM-DDTHH:mm:ss.SSS`

## 🧪 Testing

The library works with any Redis-compatible client and supports testing:

```typescript
// Use Redis mock for tests
import RedisMock from "ioredis-mock";

const mockRedis = new RedisMock();
const eventStream = new RedisEventStream(mockRedis, "test-stream", "test-group");

// Test publishing
const messageId = await eventStream.publish("test.event", "test-id",
  { test: "data" }, { source: "test" });

console.log("Message published:", messageId);

// Test consuming
const handler = await eventStream.createStream();
const messages = [];

await handler.subscribe(async (message) => {
  messages.push(message);
  await message.ack();
}, ["test.event"]);
```

## 🚀 Production Deployment

### Best Practices

1. **Use specific consumer names** for each instance:
```typescript
const eventStream = new RedisEventStream(redis, "events", "service", {
  consumer: `worker-${process.env.HOSTNAME || 'unknown'}`,
});
```

2. **Configure appropriate timeouts**:
```typescript
const eventStream = new RedisEventStream(redis, "events", "service", {
  blockMs: 30000,  // 30 second timeout
  maxLength: 100000, // Retain 100k messages
});
```

3. **Implement graceful shutdown**:
```typescript
process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  // Stream handler will exit the subscribe loop
  await redis.quit();
  process.exit(0);
});
```

4. **Monitor health endpoints**:
```typescript
setInterval(async () => {
  const health = await eventStream.getStreamHealth(handler);
  if (health.status !== 'healthy') {
    console.warn('Stream health degraded:', health);
  }
}, 30000); // Check every 30 seconds
```

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

MIT © Nelson Reina
