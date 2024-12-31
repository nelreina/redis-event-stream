# Usage Example:

```javascript
const redis = new Redis(); // create redis client
const eventStream = new RedisEventStream(redis, "orders", "order-processor");

// Publisher
await eventStream.publish("order.created", "order123", {
  id: "order123",
  amount: 100,
  currency: "USD",
});

// Subscriber
const ordersStream = await eventStream.createStream();
await ordersStream.subscribe(async ({ event, payload, ack }) => {
  console.log(`Received ${event}:`, payload);
  await ack();
}, ["order.created", "order.updated"]);
```

# Installation

```bash
npx jsr add @nelreina/redis-stream-event
or 
deno add jsr:@nelreina/redis-stream-event
```

# License

MIT
