/**
 * @fileoverview Advanced usage examples for Redis Event Stream v2
 */

import { RedisEventStream, createZodSchema } from '../mod-v2.ts';
import { 
  createLoggingMiddleware,
  createMetricsMiddleware,
  createRetryMiddleware,
  createTimeoutMiddleware,
  createValidationMiddleware,
  composeMiddleware
} from '../middleware.ts';
import { z } from 'zod';

// Example 1: Typed Events with Zod Schema Validation
// ==================================================

// Define event payload schemas
const OrderCreatedSchema = z.object({
  orderId: z.string().uuid(),
  customerId: z.string().uuid(),
  items: z.array(z.object({
    productId: z.string(),
    quantity: z.number().positive(),
    price: z.number().positive(),
  })),
  totalAmount: z.number().positive(),
  currency: z.string().length(3),
});

const OrderUpdatedSchema = z.object({
  orderId: z.string().uuid(),
  status: z.enum(['pending', 'confirmed', 'shipped', 'delivered', 'cancelled']),
  updatedAt: z.string().datetime(),
});

// Create typed event types
type OrderCreatedEvent = z.infer<typeof OrderCreatedSchema>;
type OrderUpdatedEvent = z.infer<typeof OrderUpdatedSchema>;

// Define discriminated union for all order events
type OrderEvent = 
  | { event: 'order.created'; payload: OrderCreatedEvent }
  | { event: 'order.updated'; payload: OrderUpdatedEvent };

// Example 2: Building Event Stream with Full Configuration
// =======================================================

async function createConfiguredEventStream(redisClient: any) {
  const eventStream = RedisEventStream.builder(redisClient, 'orders', 'order-service')
    // Configuration
    .withLogger(console)
    .withTimeZone('UTC')
    .withMaxLength(100000)
    .withBlockTimeout(5000)
    .withRetries(3, 1000)
    .withDeadLetterStream('orders:dlq')
    .withMetrics(true)
    .withConnectionPool(5)
    
    // Schemas
    .withSchema(createZodSchema('order.created', 1, OrderCreatedSchema))
    .withSchema(createZodSchema('order.updated', 1, OrderUpdatedSchema))
    
    // Middleware stack
    .withMiddleware(createLoggingMiddleware())
    .withMiddleware(createTimeoutMiddleware(30000))
    .withMiddleware(createRetryMiddleware(3, 1000))
    .withMiddleware(createMetricsMiddleware((metric) => {
      console.log('Metric:', metric);
    }))
    
    .build();

  return eventStream;
}

// Example 3: Publishing Events with Type Safety
// ============================================

async function publishOrderEvents(eventStream: RedisEventStream) {
  // Single event with type safety
  const publishResult = await eventStream.publish<OrderCreatedEvent>(
    'order.created',
    'order-123',
    {
      orderId: '550e8400-e29b-41d4-a716-446655440000',
      customerId: '550e8400-e29b-41d4-a716-446655440001',
      items: [
        { productId: 'prod-1', quantity: 2, price: 29.99 },
        { productId: 'prod-2', quantity: 1, price: 49.99 },
      ],
      totalAmount: 109.97,
      currency: 'USD',
    },
    {
      correlationId: 'req-123',
      userId: 'user-456',
    }
  );

  if (!publishResult.ok) {
    console.error('Publish failed:', publishResult.error);
    return;
  }

  // Batch publishing
  const batchResult = await eventStream.publishBatch([
    {
      event: 'order.created',
      aggregateId: 'order-124',
      payload: {
        orderId: '550e8400-e29b-41d4-a716-446655440002',
        customerId: '550e8400-e29b-41d4-a716-446655440001',
        items: [{ productId: 'prod-3', quantity: 1, price: 99.99 }],
        totalAmount: 99.99,
        currency: 'EUR',
      },
    },
    {
      event: 'order.updated',
      aggregateId: 'order-123',
      payload: {
        orderId: '550e8400-e29b-41d4-a716-446655440000',
        status: 'confirmed',
        updatedAt: new Date().toISOString(),
      },
    },
  ], {
    maxBatchSize: 100,
    onError: (error, events) => {
      console.error('Batch error:', error, 'for events:', events);
    },
  });

  if (!batchResult.ok) {
    console.error('Batch publish failed:', batchResult.error);
  }
}

// Example 4: Consuming Events with Type Safety
// ===========================================

async function consumeOrderEvents(eventStream: RedisEventStream) {
  // Create consumer with type-safe handler
  const consumerResult = await eventStream.createConsumer<OrderEvent['payload']>(
    async (message) => {
      // TypeScript knows the payload type based on event
      switch (message.event) {
        case 'order.created':
          await handleOrderCreated(message.payload as OrderCreatedEvent);
          break;
        
        case 'order.updated':
          await handleOrderUpdated(message.payload as OrderUpdatedEvent);
          break;
        
        default:
          console.warn('Unknown event:', message.event);
      }
      
      // Acknowledge message after successful processing
      await message.ack();
    },
    {
      concurrency: 5,
      processingTimeout: 30000,
      errorHandler: async (error, message) => {
        console.error('Processing error:', error);
        
        // Send to dead letter queue after max retries
        if (message.retryCount && message.retryCount >= 3) {
          await message.nack();
        }
      },
    }
  );

  if (!consumerResult.ok) {
    console.error('Consumer creation failed:', consumerResult.error);
    return;
  }

  const consumer = consumerResult.value;
  
  // Start consuming specific events
  await consumer.start(['order.created', 'order.updated']);
}

async function handleOrderCreated(order: OrderCreatedEvent) {
  console.log('Processing new order:', order.orderId);
  // Business logic here
}

async function handleOrderUpdated(update: OrderUpdatedEvent) {
  console.log('Order status updated:', update.orderId, update.status);
  // Business logic here
}

// Example 5: Advanced Middleware Usage
// ===================================

function createOrderProcessingMiddleware() {
  // Compose multiple middleware
  return composeMiddleware(
    // Add correlation ID if missing
    async (message, next) => {
      if (!message.metadata?.correlationId) {
        message.metadata = {
          ...message.metadata,
          correlationId: crypto.randomUUID(),
        };
      }
      await next();
    },
    
    // Validate order ID format
    createValidationMiddleware(async (payload: any) => {
      if (payload.orderId && !payload.orderId.match(/^[0-9a-f-]{36}$/)) {
        throw new Error('Invalid order ID format');
      }
      return payload;
    }),
    
    // Add processing timestamp
    async (message, next) => {
      const startTime = Date.now();
      try {
        await next();
      } finally {
        const duration = Date.now() - startTime;
        console.log(`Processed ${message.event} in ${duration}ms`);
      }
    }
  );
}

// Example 6: Monitoring and Health Checks
// =======================================

async function setupMonitoring(eventStream: RedisEventStream) {
  // Health check endpoint
  setInterval(async () => {
    const health = await eventStream.getHealth();
    console.log('Health status:', health);
    
    if (health.status === 'unhealthy') {
      // Trigger alerts
      console.error('Stream is unhealthy!', health.checks);
    }
  }, 30000);

  // Metrics endpoint
  setInterval(() => {
    const metrics = eventStream.getMetrics();
    if (metrics) {
      console.log('Stream metrics:', {
        published: metrics.messagesPublished,
        consumed: metrics.messagesConsumed,
        failed: metrics.messagesFailed,
        lag: metrics.consumerLag,
      });
    }
  }, 60000);
}

// Example 7: Schema Evolution
// ==========================

// Version 1 of order schema
const OrderSchemaV1 = z.object({
  orderId: z.string(),
  amount: z.number(),
});

// Version 2 adds currency field
const OrderSchemaV2 = z.object({
  orderId: z.string(),
  amount: z.number(),
  currency: z.string(),
});

// Create schema with upgrade function
const upgradableOrderSchema = createZodSchema(
  'order.placed',
  2,
  OrderSchemaV2,
  (payload: any, fromVersion: number) => {
    if (fromVersion === 1) {
      // Add default currency for v1 events
      return { ...payload, currency: 'USD' };
    }
    return payload;
  }
);

// Example 8: Error Recovery and Dead Letter Queue
// ==============================================

async function setupDeadLetterProcessing(redisClient: any) {
  const dlqStream = RedisEventStream.builder(
    redisClient,
    'orders:dlq',
    'dlq-processor'
  )
    .withLogger(console)
    .withAutoAck(false)
    .build();

  const consumerResult = await dlqStream.createConsumer(
    async (message) => {
      console.log('Processing dead letter:', message);
      
      // Analyze why message failed
      const originalError = message.metadata?.error;
      
      // Attempt to fix and republish
      try {
        // Fix the issue (e.g., data transformation)
        const fixedPayload = await fixPayload(message.payload);
        
        // Republish to main stream
        await mainStream.publish(
          message.event,
          message.aggregateId,
          fixedPayload
        );
        
        await message.ack();
      } catch (error) {
        console.error('Failed to process dead letter:', error);
        // Could send to another queue or alert administrators
      }
    }
  );
}

async function fixPayload(payload: unknown): Promise<unknown> {
  // Implementation specific to your use case
  return payload;
}

// Example 9: Testing with In-Memory Implementation
// ===============================================

class InMemoryRedisClient {
  private streams = new Map<string, any[]>();
  isOpen = true;

  async connect() {}
  
  duplicate() {
    return new InMemoryRedisClient();
  }

  async xAdd(key: string, id: string, fields: Record<string, string>) {
    const messages = this.streams.get(key) || [];
    const messageId = `${Date.now()}-0`;
    messages.push({ id: messageId, fields });
    this.streams.set(key, messages);
    return messageId;
  }

  // Implement other required methods...
}

async function testEventStream() {
  const mockClient = new InMemoryRedisClient();
  const eventStream = RedisEventStream.builder(
    mockClient as any,
    'test-stream',
    'test-group'
  ).build();

  // Run tests
  const result = await eventStream.publish('test.event', 'test-1', { data: 'test' });
  console.assert(result.ok, 'Publish should succeed');
}

// Export examples for documentation
export {
  createConfiguredEventStream,
  publishOrderEvents,
  consumeOrderEvents,
  setupMonitoring,
  setupDeadLetterProcessing,
  testEventStream,
};