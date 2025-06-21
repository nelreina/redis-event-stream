# Migration Guide: v1 to v2

This guide helps you migrate from Redis Event Stream v1 to v2, which includes significant API improvements, better type safety, and new features.

## 🔄 Breaking Changes

### 1. **Builder Pattern for Configuration**

**v1:**
```typescript
const eventStream = new RedisEventStream(redis, "orders", "order-processor", {
  logger: console,
  blockMs: 30000,
  maxLength: 10000,
});
```

**v2:**
```typescript
const eventStream = RedisEventStream.builder(redis, "orders", "order-processor")
  .withLogger(console)
  .withBlockTimeout(30000)
  .withMaxLength(10000)
  .build();
```

### 2. **Result Type for Error Handling**

**v1:**
```typescript
try {
  const messageId = await eventStream.publish("event", "id", data);
} catch (error) {
  console.error(error);
}
```

**v2:**
```typescript
const result = await eventStream.publish("event", "id", data);
if (!result.ok) {
  console.error(result.error);
} else {
  const messageId = result.value;
}
```

### 3. **Renamed Methods**

- `createStream()` → `createConsumer()`
- `StreamHandler.subscribe()` → `StreamConsumer.start()`

**v1:**
```typescript
const stream = await eventStream.createStream();
await stream.subscribe(handler, ["event1", "event2"]);
```

**v2:**
```typescript
const consumerResult = await eventStream.createConsumer(handler);
if (consumerResult.ok) {
  await consumerResult.value.start(["event1", "event2"]);
}
```

### 4. **Generic Type Support**

**v1:**
```typescript
await eventStream.publish("order.created", "id", orderData);
// No type checking on orderData
```

**v2:**
```typescript
interface OrderCreated {
  orderId: string;
  amount: number;
}

await eventStream.publish<OrderCreated>("order.created", "id", {
  orderId: "123",
  amount: 99.99,
});
// Full type checking!
```

### 5. **Message Structure Changes**

**v1:**
```typescript
interface StreamMessage {
  streamId: string;
  event: string;
  payload: unknown;
  ack: () => Promise<number>;
}
```

**v2:**
```typescript
interface StreamMessage<T = unknown> {
  streamId: string;
  event: string;
  payload: T;
  metadata?: EventMetadata;
  ack: () => Promise<number>;
  nack: () => Promise<void>;
  retryCount?: number;
}
```

## ✨ New Features in v2

### 1. **Schema Validation**

```typescript
import { z } from "zod";
import { createZodSchema } from "@nelreina/redis-stream-event";

const OrderSchema = z.object({
  orderId: z.string().uuid(),
  amount: z.number().positive(),
});

const eventStream = RedisEventStream.builder(redis, "orders", "service")
  .withSchema(createZodSchema("order.created", 1, OrderSchema))
  .build();
```

### 2. **Middleware Support**

```typescript
import { createLoggingMiddleware, createRetryMiddleware } from "@nelreina/redis-stream-event";

const eventStream = RedisEventStream.builder(redis, "orders", "service")
  .withMiddleware(createLoggingMiddleware())
  .withMiddleware(createRetryMiddleware(3, 1000))
  .build();
```

### 3. **Batch Publishing**

```typescript
await eventStream.publishBatch([
  { event: "order.created", aggregateId: "1", payload: data1 },
  { event: "order.created", aggregateId: "2", payload: data2 },
]);
```

### 4. **Health Monitoring**

```typescript
const health = await eventStream.getHealth();
const metrics = eventStream.getMetrics();
```

### 5. **Dead Letter Queue**

```typescript
const eventStream = RedisEventStream.builder(redis, "orders", "service")
  .withDeadLetterStream("orders:dlq")
  .withRetries(3, 1000)
  .build();
```

## 📝 Step-by-Step Migration

### Step 1: Update Imports

**v1:**
```typescript
import RedisEventStream from "@nelreina/redis-stream-event";
```

**v2:**
```typescript
import { RedisEventStream } from "@nelreina/redis-stream-event";
```

### Step 2: Update Initialization

Replace constructor calls with builder pattern:

```typescript
// Old
const eventStream = new RedisEventStream(redis, streamKey, groupName, options);

// New
const eventStream = RedisEventStream.builder(redis, streamKey, groupName)
  .withLogger(options.logger)
  .withBlockTimeout(options.blockMs)
  .withAutoAck(options.autoAck)
  // ... other options
  .build();
```

### Step 3: Update Publishing Code

Add error handling with Result type:

```typescript
// Old
const messageId = await eventStream.publish(event, aggregateId, data);

// New
const result = await eventStream.publish(event, aggregateId, data);
if (!result.ok) {
  // Handle error
  throw result.error;
}
const messageId = result.value;
```

### Step 4: Update Consumer Creation

```typescript
// Old
const streamHandler = await eventStream.createStream();
if (!streamHandler) {
  throw new Error("Failed to create stream");
}
await streamHandler.subscribe(handler, events);

// New
const consumerResult = await eventStream.createConsumer(handler);
if (!consumerResult.ok) {
  throw consumerResult.error;
}
await consumerResult.value.start(events);
```

### Step 5: Update Event Handlers

Add type annotations and use new message properties:

```typescript
// Old
async function handler(message) {
  console.log(message.payload);
  await message.ack();
}

// New
async function handler(message: StreamMessage<MyEventType>) {
  console.log(message.payload); // Typed!
  console.log(message.metadata); // New!
  
  try {
    // Process message
    await message.ack();
  } catch (error) {
    await message.nack(); // New!
  }
}
```

## 🔧 Configuration Mapping

| v1 Option | v2 Builder Method | Notes |
|-----------|------------------|-------|
| `logger` | `withLogger()` | Same functionality |
| `blockMs` | `withBlockTimeout()` | Renamed for clarity |
| `autoAck` | `withAutoAck()` | Same functionality |
| `startID` | `withStartId()` | Same functionality |
| `consumer` | `withConsumer()` | Same functionality |
| `timeZone` | `withTimeZone()` | Same functionality |
| `maxLength` | `withMaxLength()` | Same functionality |
| `initLog` | - | Removed, use logger instead |
| - | `withRetries()` | New feature |
| - | `withDeadLetterStream()` | New feature |
| - | `withMetrics()` | New feature |
| - | `withConnectionPool()` | New feature |
| - | `withSchema()` | New feature |
| - | `withMiddleware()` | New feature |

## 💡 Tips

1. **Start with Type Definitions**: Define your event types first to get maximum benefit from v2's type safety.

2. **Add Schema Validation Gradually**: You don't need to add schemas for all events at once. Start with critical events.

3. **Use Middleware for Cross-Cutting Concerns**: Move logging, metrics, and error handling to middleware.

4. **Enable Metrics**: The new metrics feature provides valuable insights with minimal overhead.

5. **Test with In-Memory Client**: Use the provided in-memory Redis client for unit tests.

## 🆘 Common Issues

### Issue: TypeScript Errors After Migration

**Solution**: Add explicit type parameters to generic methods:
```typescript
// Specify the payload type
await eventStream.publish<OrderPayload>("order.created", id, payload);
```

### Issue: Missing StreamHandler

**Solution**: StreamHandler is now StreamConsumer and returned in a Result:
```typescript
const result = await eventStream.createConsumer(handler);
const consumer = result.ok ? result.value : null;
```

### Issue: Error Handling Changes

**Solution**: Check Result.ok before accessing value:
```typescript
if (result.ok) {
  // Use result.value
} else {
  // Handle result.error
}
```

## 📚 Further Reading

- [README-v2.md](./README-v2.md) - Complete v2 documentation
- [examples/advanced-usage.ts](./examples/advanced-usage.ts) - Advanced examples
- [API Reference](#) - Detailed API documentation

For questions or issues, please open an issue on GitHub.