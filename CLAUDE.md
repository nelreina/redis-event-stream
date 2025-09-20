# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a TypeScript library for Redis Streams-based event streaming, supporting both Deno and Node.js environments. The package is published to JSR as `@nelreina/redis-stream-event` (currently v0.9.0).

## Architecture

The codebase has two architectural implementations:

### Legacy API (`mod.ts`)
- **RedisEventStream**: Main class handling Redis client configuration, stream/group creation, and event publishing
- **StreamHandler**: Manages subscription logic and message processing with dedicated Redis connections
- Simple event-based patterns with manual acknowledgment support

### v2 API (`mod-v2.ts`)
- **Builder Pattern**: `RedisEventStreamBuilder` for fluent configuration
- **Type Safety**: Full TypeScript generics and discriminated unions via `Result<T, E>` pattern
- **Middleware Pipeline**: Composable middleware system in `middleware.ts`
- **Schema Registry**: Event validation with Zod integration in `schema-registry.ts`
- **Metrics & Observability**: Built-in metrics collection in `metrics.ts`
- **Connection Pooling**: Advanced connection management in `connection-pool.ts`
- **Error Hierarchy**: Comprehensive error types in `errors.ts`

Key patterns:
- Consumer groups for reliable message processing
- Automatic retry with exponential backoff
- Dead letter queue support
- Health monitoring and metrics
- Circuit breaker pattern for resilience

## Development Commands

```bash
# Run TypeScript file directly with Deno
deno run --allow-net --allow-env mod.ts

# Type check
deno check mod.ts mod-v2.ts

# Format code
deno fmt

# Lint code
deno lint

# Publish to JSR
deno publish
```

## Testing

Currently no test files exist. When adding tests:
```bash
# Run tests (when available)
deno test --allow-net --allow-env

# Run with coverage
deno test --coverage
```

## Key Implementation Details

### Message Format
- Events include: `event`, `aggregateId`, `timestamp`, `serviceName`, `payload`, `headers`
- Payloads are JSON stringified with optional schema validation
- Timestamps use configurable timezone (default: UTC)

### Stream Management
- Automatic stream trimming (default maxLength: 10000)
- Consumer groups and consumers created on-demand
- Supports XREADGROUP with blocking reads
- Batch publishing with atomic operations

### Error Handling
- Result type pattern for explicit error handling
- Retryable vs non-retryable error classification
- Dead letter queue for failed messages
- Comprehensive error types for different failure modes

### Configuration Defaults
- `blockMs`: 30000 (blocking timeout)
- `autoAck`: false (manual acknowledgment)
- `startID`: "$" (latest messages)
- `consumer`: "consumer-1"
- `maxRetries`: 3
- `retryDelayMs`: 1000

## Health Check Implementation

### Health Status Interface
The library exports a `StreamHealthStatus` interface for comprehensive health monitoring:

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

### Health Check Methods

#### RedisEventStream.getStreamHealth(handler?: StreamHandler)
- **Purpose**: Get comprehensive health status for the stream
- **Parameters**: Optional StreamHandler for detailed metrics
- **Returns**: Promise<StreamHealthStatus>
- **Usage**: `const health = await eventStream.getStreamHealth(handler);`

#### StreamHandler.getHealthStatus()
- **Purpose**: Get handler-specific health information
- **Parameters**: None
- **Returns**: Partial<StreamHealthStatus> (synchronous)
- **Usage**: `const handlerHealth = handler.getHealthStatus();`

### Health Status Levels
- **healthy**: Redis connected, consumer reading, lag < 1000 messages
- **degraded**: Redis connected, lag 1000-10000 messages or consumer not reading
- **unhealthy**: Redis disconnected or lag > 10000 messages

### Implementation Details
- StreamHandler tracks `isActive`, `lastMessageTime`, `messagesProcessed`, `lastError`
- Health state is updated during `subscribe()` method execution
- `getStreamHealth()` combines Redis connection status with consumer group info
- Health checks work even when no messages are flowing
- Safe for frequent calls (K8s probes, monitoring)