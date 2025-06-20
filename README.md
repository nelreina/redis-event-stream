# Redis Event Stream

A powerful Redis Streams-based event streaming library for event-driven applications. Built for both Deno and Node.js environments with TypeScript support.

[![JSR](https://jsr.io/badges/@nelreina/redis-stream-event)](https://jsr.io/@nelreina/redis-stream-event)
[![JSR Score](https://jsr.io/badges/@nelreina/redis-stream-event/score)](https://jsr.io/@nelreina/redis-stream-event)

## Features

- 🚀 **Redis Streams**: Built on Redis Streams for reliable, high-performance event processing
- 🏘️ **Consumer Groups**: Automatic consumer group and consumer management
- 🔄 **Reliable Processing**: Support for manual and automatic message acknowledgment
- 🎯 **Event Filtering**: Subscribe to specific events or all events on a stream
- ⚡ **Stream Trimming**: Built-in stream management to prevent unbounded growth
- 🕐 **Timezone Support**: Configurable timezone for event timestamps
- 📝 **TypeScript**: Full TypeScript support with comprehensive type definitions
- 🌍 **Universal**: Works with both Deno and Node.js

## Installation

### Deno
```bash
deno add jsr:@nelreina/redis-stream-event
```

### Node.js
```bash
npx jsr add @nelreina/redis-stream-event
```

## Quick Start

```typescript
import RedisEventStream from "@nelreina/redis-stream-event";
import { Redis } from "ioredis"; // or your preferred Redis client

// Initialize Redis client and event stream
const redis = new Redis();
const eventStream = new RedisEventStream(redis, "orders", "order-processor");

// Publishing events
await eventStream.publish("order.created", "order123", {
  id: "order123",
  amount: 100,
  currency: "USD",
  customer: "john.doe@example.com"
});

// Consuming events
const ordersStream = await eventStream.createStream();
await ordersStream.subscribe(async ({ event, payload, ack }) => {
  console.log(`Processing ${event}:`, payload);
  
  // Process your business logic here
  await processOrder(payload);
  
  // Acknowledge message processing
  await ack();
}, ["order.created", "order.updated"]); // Optional: filter specific events
```

## API Reference

### `RedisEventStream`

Main class for creating event streams and publishing events.

#### Constructor

```typescript
new RedisEventStream(client: RedisClient, streamKeyName: string, groupName: string, options?: StreamOptions)
```

**Parameters:**
- `client`: Redis client instance (ioredis or compatible)
- `streamKeyName`: Name of the Redis stream key
- `groupName`: Name of the consumer group
- `options`: Optional configuration options

#### Methods

##### `publish(event: string, aggregateId: string, data: unknown): Promise<string>`

Publishes an event to the Redis stream.

**Parameters:**
- `event`: Event type/name (e.g., "order.created")
- `aggregateId`: Unique identifier for the aggregate/entity
- `data`: Event payload data (will be JSON stringified)

**Returns:** Promise resolving to the Redis stream message ID

##### `createStream(): Promise<StreamHandler | null>`

Creates a stream handler for consuming messages.

**Returns:** Promise resolving to a StreamHandler instance or null if creation failed

### `StreamHandler`

Handles stream consumption and message processing.

##### `subscribe(eventHandler: EventHandler, filterEvents?: string[]): Promise<void>`

Subscribes to events from the Redis stream with optional event filtering.

**Parameters:**
- `eventHandler`: Async function to handle received events
- `filterEvents`: Optional array of event types to process (processes all events if not provided)

##### `ack(messageId: string): Promise<number>`

Manually acknowledges a message as processed.

## Configuration Options

```typescript
interface StreamOptions {
  logger?: Logger;          // Custom logger (default: console)
  blockMs?: number;         // Blocking timeout for stream reads (default: 30000)
  autoAck?: boolean;        // Enable automatic acknowledgment (default: false)
  startID?: string;         // Starting message ID for consumption (default: "$")
  consumer?: string;        // Consumer name (default: "consumer-1")
  timeZone?: string;        // Timezone for timestamps (default: "America/Curacao")
  maxLength?: number;       // Stream trimming limit (default: 10000)
  initLog?: boolean;        // Enable initialization logging (default: true)
}
```

## Event Message Structure

Events received by subscribers have the following structure:

```typescript
interface StreamMessage {
  streamId: string;         // Redis stream message ID
  event: string;            // Event type
  aggregateId: string;      // Aggregate identifier
  timestamp: string;        // Event timestamp
  serviceName: string;      // Name of the publishing service
  mimeType?: string;        // Optional MIME type
  payload: unknown;         // Event payload (parsed from JSON)
  ack: () => Promise<number>; // Acknowledgment function
}
```

## Advanced Usage

### Event Filtering

Subscribe to specific events only:

```typescript
await ordersStream.subscribe(async ({ event, payload, ack }) => {
  // This handler only receives order.created and order.updated events
  console.log(`Processing ${event}:`, payload);
  await ack();
}, ["order.created", "order.updated"]);
```

### Custom Configuration

```typescript
const eventStream = new RedisEventStream(redis, "events", "my-service", {
  blockMs: 5000,           // 5 second blocking timeout
  maxLength: 50000,        // Keep up to 50,000 messages
  timeZone: "UTC",         // Use UTC timestamps
  consumer: "worker-1",    // Custom consumer name
  logger: myCustomLogger   // Custom logger
});
```

### Error Handling

```typescript
try {
  const ordersStream = await eventStream.createStream();
  await ordersStream.subscribe(async ({ event, payload, ack }) => {
    try {
      await processEvent(event, payload);
      await ack();
    } catch (error) {
      console.error(`Failed to process event ${event}:`, error);
      // Don't acknowledge failed messages for retry
    }
  });
} catch (error) {
  console.error("Stream subscription failed:", error);
}
```

## Redis Client Compatibility

This library works with any Redis client that implements the required interface:

- ✅ [ioredis](https://github.com/redis/ioredis)
- ✅ [node-redis](https://github.com/redis/node-redis)
- ✅ Any client implementing the RedisClient interface

## Best Practices

1. **Always acknowledge messages**: Call `ack()` after successful processing to prevent message redelivery
2. **Handle errors gracefully**: Don't acknowledge messages that failed to process
3. **Use event filtering**: Subscribe only to events your service needs to process
4. **Monitor stream size**: Configure appropriate `maxLength` for your use case
5. **Use meaningful event names**: Follow a consistent naming convention (e.g., "entity.action")

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT © Nelson Reina
