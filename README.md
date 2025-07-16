# Redis Event Stream v2 (v0.8.5)

A powerful, type-safe Redis Streams library for building event-driven applications with advanced features like schema validation, middleware support, and comprehensive observability.

[![JSR](https://jsr.io/badges/@nelreina/redis-stream-event)](https://jsr.io/@nelreina/redis-stream-event)
[![JSR Score](https://jsr.io/badges/@nelreina/redis-stream-event/score)](https://jsr.io/@nelreina/redis-stream-event)

## 🚀 Key Features

- **🔒 Type Safety**: Full TypeScript support with generics and discriminated unions
- **✅ Schema Validation**: Built-in schema validation with Zod integration
- **🔄 Middleware Pipeline**: Composable middleware for cross-cutting concerns
- **📊 Observability**: Metrics collection, health checks, and structured logging
- **🏗️ Builder Pattern**: Fluent API for easy configuration
- **🔁 Resilience**: Retry strategies, circuit breakers, and dead letter queues
- **⚡ Performance**: Connection pooling, batch publishing, and prefetching
- **🧪 Testing**: In-memory implementation for unit tests

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
import { RedisEventStream } from "@nelreina/redis-stream-event";
import { Redis } from "ioredis";

// Create event stream with builder pattern
const eventStream = RedisEventStream.builder(
  new Redis(),
  "orders",
  "order-service"
)
  .withLogger(console)
  .withMetrics(true)
  .withRetries(3, 1000)
  .build();

// Type-safe event publishing
const result = await eventStream.publish(
  "order.created",
  "order-123",
  {
    orderId: "order-123",
    amount: 99.99,
    currency: "USD",
  },
  { correlationId: "req-456" }
);

if (!result.ok) {
  console.error("Publish failed:", result.error);
}

// Create consumer with error handling
const consumerResult = await eventStream.createConsumer(
  async (message) => {
    console.log(`Processing ${message.event}:`, message.payload);
    
    // Process your business logic
    await processOrder(message.payload);
    
    // Acknowledge message
    await message.ack();
  },
  { concurrency: 5, processingTimeout: 30000 }
);

if (consumerResult.ok) {
  await consumerResult.value.start(["order.created", "order.updated"]);
}
```

## 📚 Advanced Usage

### Schema Validation with Zod

```typescript
import { z } from "zod";
import { createZodSchema } from "@nelreina/redis-stream-event";

// Define schema
const OrderSchema = z.object({
  orderId: z.string().uuid(),
  items: z.array(z.object({
    productId: z.string(),
    quantity: z.number().positive(),
  })),
  totalAmount: z.number().positive(),
});

// Configure with schema
const eventStream = RedisEventStream.builder(redis, "orders", "service")
  .withSchema(createZodSchema("order.created", 1, OrderSchema))
  .build();

// Publishing validates automatically
const result = await eventStream.publish("order.created", "id", {
  orderId: "invalid", // Will fail validation
  items: [],
  totalAmount: -10,
});
```

### Middleware Pipeline

```typescript
import {
  createLoggingMiddleware,
  createMetricsMiddleware,
  createRetryMiddleware,
  createTimeoutMiddleware,
  composeMiddleware,
} from "@nelreina/redis-stream-event";

const eventStream = RedisEventStream.builder(redis, "events", "service")
  .withMiddleware(createLoggingMiddleware())
  .withMiddleware(createTimeoutMiddleware(30000))
  .withMiddleware(createRetryMiddleware(3, 1000))
  .withMiddleware(createMetricsMiddleware((metric) => {
    prometheus.observe(metric);
  }))
  .build();
```

### Batch Publishing

```typescript
const events = [
  { event: "user.created", aggregateId: "user-1", payload: { name: "Alice" } },
  { event: "user.created", aggregateId: "user-2", payload: { name: "Bob" } },
  { event: "user.updated", aggregateId: "user-1", payload: { email: "alice@example.com" } },
];

const result = await eventStream.publishBatch(events, {
  maxBatchSize: 100,
  onError: (error, failedEvents) => {
    console.error("Batch error:", error);
    // Handle failed events
  },
});
```

### Health Monitoring

```typescript
// Get health status
const health = await eventStream.getHealth();
console.log("Health:", health);
// {
//   status: "healthy" | "degraded" | "unhealthy",
//   checks: { redis: true, consumer: true, lag: 150 },
//   timestamp: "2024-01-01T00:00:00.000Z"
// }

// Get metrics
const metrics = eventStream.getMetrics();
console.log("Metrics:", {
  published: metrics.messagesPublished,
  consumed: metrics.messagesConsumed,
  failed: metrics.messagesFailed,
  lag: metrics.consumerLag,
});
```

### Dead Letter Queue

```typescript
const eventStream = RedisEventStream.builder(redis, "orders", "service")
  .withDeadLetterStream("orders:dlq")
  .withRetries(3, 1000)
  .build();

// Process dead letters
const dlqStream = RedisEventStream.builder(redis, "orders:dlq", "dlq-processor")
  .build();

await dlqStream.createConsumer(async (message) => {
  console.log("Dead letter:", message);
  // Analyze and potentially fix/retry
});
```

## 🏗️ API Reference

### RedisEventStream

#### Static Methods

##### `builder(client, streamKey, consumerGroup)`
Creates a new builder instance for configuring the event stream.

#### Builder Methods

- `withLogger(logger)` - Set custom logger
- `withBlockTimeout(ms)` - Set blocking timeout for reads
- `withAutoAck(enabled)` - Enable automatic acknowledgment
- `withStartId(id)` - Set starting message ID
- `withConsumer(name)` - Set consumer name
- `withTimeZone(tz)` - Set timezone for timestamps
- `withMaxLength(length)` - Set maximum stream length
- `withRetries(max, delayMs)` - Configure retry behavior
- `withDeadLetterStream(key)` - Set dead letter stream
- `withMetrics(enabled)` - Enable metrics collection
- `withConnectionPool(size)` - Set connection pool size
- `withSchema(schema)` - Add event schema
- `withMiddleware(middleware)` - Add middleware

#### Instance Methods

##### `publish<T>(event, aggregateId, payload, metadata?)`
Publishes a single event with optional metadata.

**Returns**: `Result<string>` - Success with message ID or error

##### `publishBatch<T>(events, options?)`
Publishes multiple events in batch.

**Returns**: `Result<string[]>` - Success with message IDs or error

##### `createConsumer<T>(handler, options?)`
Creates a consumer for processing events.

**Returns**: `Result<StreamConsumer<T>>` - Success with consumer or error

##### `getHealth()`
Gets the current health status of the stream.

**Returns**: `Promise<HealthStatus>`

##### `getMetrics()`
Gets current metrics if enabled.

**Returns**: `StreamMetrics | undefined`

### StreamConsumer

#### Methods

##### `start(eventFilter?)`
Starts consuming events, optionally filtering by event types.

##### `stop()`
Gracefully stops the consumer.

## 🛡️ Error Handling

The library uses a `Result<T, E>` type for error handling:

```typescript
const result = await eventStream.publish("event", "id", data);

if (result.ok) {
  console.log("Message ID:", result.value);
} else {
  console.error("Error:", result.error);
  
  // Specific error types
  if (result.error instanceof ValidationError) {
    console.error("Validation errors:", result.error.errors);
  }
}
```

### Error Types

- `ConnectionError` - Redis connection failures
- `ConsumerGroupError` - Consumer group operations
- `PublishError` - Publishing failures
- `ProcessingError` - Message processing errors
- `ValidationError` - Schema validation failures
- `TimeoutError` - Operation timeouts
- `MaxRetriesExceededError` - Retry limit reached

## 🧪 Testing

The library includes utilities for testing:

```typescript
import { InMemoryRedisClient } from "@nelreina/redis-stream-event/testing";

const mockClient = new InMemoryRedisClient();
const eventStream = RedisEventStream.builder(
  mockClient,
  "test-stream",
  "test-group"
).build();

// Write your tests
const result = await eventStream.publish("test.event", "id", { data: "test" });
expect(result.ok).toBe(true);
```

## 📊 Metrics Export

Export metrics in Prometheus format:

```typescript
const collector = eventStream.getMetrics();
const prometheusMetrics = collector.toPrometheusFormat("app_events");
```

## 🔧 Configuration Reference

### StreamOptions

```typescript
interface StreamOptions {
  logger?: Logger;              // Custom logger (default: console)
  blockMs?: number;            // Block timeout in ms (default: 30000)
  autoAck?: boolean;           // Auto acknowledge (default: false)
  startID?: string;            // Start consuming from (default: "$")
  consumer?: string;           // Consumer name (default: "consumer-1")
  timeZone?: string;           // Timezone (default: "UTC")
  maxLength?: number;          // Max stream length (default: 10000)
  initLog?: boolean;           // Log initialization (default: false)
  maxRetries?: number;         // Max retry attempts (default: 3)
  retryDelayMs?: number;       // Retry delay in ms (default: 1000)
  deadLetterStream?: string;   // Dead letter stream key
  enableMetrics?: boolean;     // Enable metrics (default: false)
  connectionPoolSize?: number; // Connection pool size (default: 1)
  prefetchCount?: number;      // Messages to prefetch (default: 1)
}
```

### ConsumerOptions

```typescript
interface ConsumerOptions extends StreamOptions {
  concurrency?: number;        // Concurrent message processing
  processingTimeout?: number;  // Processing timeout in ms
  errorHandler?: (error, message) => Promise<void>;
}
```

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

MIT © Nelson Reina