// Example demonstrating multi-stream subscription and publishing
// This shows how to subscribe to multiple Redis streams in a single connection

import RedisEventStream from '../mod.ts';
import { createClient } from 'redis';

async function main() {
  // Create Redis client
  const redis = createClient({
    url: 'redis://localhost:6379'
  });
  
  await redis.connect();
  
  // Example 1: Create event stream for multiple keys
  const multiStream = new RedisEventStream(
    redis,
    ['orders', 'payments', 'inventory'], // Multiple stream keys
    'multi-processor',
    { 
      logger: console,
      initLog: true 
    }
  );
  
  // Create stream handler for all configured streams
  const streamHandler = await multiStream.createStream();
  
  if (streamHandler) {
    // Subscribe to events from all streams
    console.log('Subscribing to multiple streams: orders, payments, inventory');
    
    streamHandler.subscribe(async (message) => {
      console.log(`Received event from stream:`, {
        event: message.event,
        aggregateId: message.aggregateId,
        payload: message.payload,
        timestamp: message.timestamp
      });
      
      // Process based on event type
      switch (message.event) {
        case 'order.created':
          console.log('Processing new order:', message.payload);
          break;
        case 'payment.processed':
          console.log('Processing payment:', message.payload);
          break;
        case 'inventory.updated':
          console.log('Processing inventory update:', message.payload);
          break;
      }
      
      // Acknowledge the message
      await message.ack();
    }, ['order.created', 'payment.processed', 'inventory.updated']);
  }
  
  // Example 2: Publishing to different streams
  console.log('\nPublishing events to different streams...');
  
  // Publish to orders stream
  await multiStream.publish(
    'order.created',
    'order-123',
    { orderId: 'order-123', total: 99.99, items: ['item1', 'item2'] },
    { userId: 'user-456' },
    'orders' // Specify the stream key
  );
  console.log('Published order.created to orders stream');
  
  // Publish to payments stream
  await multiStream.publish(
    'payment.processed',
    'payment-789',
    { paymentId: 'payment-789', orderId: 'order-123', amount: 99.99 },
    { userId: 'user-456' },
    'payments' // Specify the stream key
  );
  console.log('Published payment.processed to payments stream');
  
  // Publish to inventory stream
  await multiStream.publish(
    'inventory.updated',
    'product-001',
    { productId: 'product-001', quantity: -2, newStock: 48 },
    { orderId: 'order-123' },
    'inventory' // Specify the stream key
  );
  console.log('Published inventory.updated to inventory stream');
  
  // Example 3: Create stream handler for specific streams only
  const partialStreamHandler = await multiStream.createStream(['orders', 'payments']);
  
  if (partialStreamHandler) {
    console.log('\nSubscribing to subset of streams: orders, payments only');
    
    partialStreamHandler.subscribe(async (message) => {
      console.log(`Received from partial subscription:`, message.event);
      await message.ack();
    });
  }
  
  // Example 4: Publishing without specifying stream (uses first configured stream)
  await multiStream.publish(
    'order.cancelled',
    'order-999',
    { orderId: 'order-999', reason: 'Customer request' },
    { userId: 'user-789' }
    // No stream key specified - will use 'orders' (first in array)
  );
  console.log('Published order.cancelled to default stream (orders)');
}

// Run the example
main().catch(console.error);