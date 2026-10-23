// Integration tests against a local Redis (REDIS_URL, default redis://localhost:6379).
// Every test uses its own `test:<random>:` key prefix and deletes its keys.
import { assert, assertEquals } from "@std/assert";
import { createClient } from "redis";
import RedisEventStream, { type StreamMessage } from "../mod.ts";

const REDIS_URL = Deno.env.get("REDIS_URL") ?? "redis://localhost:6379";
const quiet = { info() {}, error() {}, warn() {} };

// deno-lint-ignore no-explicit-any
type Client = any;

async function setup() {
  const client: Client = createClient({ url: REDIS_URL });
  await client.connect();
  const prefix = `test:${crypto.randomUUID().slice(0, 8)}:`;
  const cleanup = async () => {
    const keys: string[] = [];
    for await (const k of client.scanIterator({ MATCH: `${prefix}*` })) {
      keys.push(k);
    }
    if (keys.length) await client.del(keys);
    await client.quit();
  };
  return { client, prefix, cleanup };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timed out");
    await sleep(20);
  }
}

function entry(event: string, payload: unknown = {}) {
  return {
    event,
    aggregateId: "agg",
    timestamp: new Date().toISOString(),
    payload: JSON.stringify(payload),
    serviceName: "test",
    headers: "{}",
  };
}

Deno.test("stop() unblocks a blocked XREADGROUP, resolves subscribe and closes the connection", async () => {
  const { client, prefix, cleanup } = await setup();
  try {
    const es = new RedisEventStream(client, `${prefix}s`, "grp", {
      logger: quiet,
    });
    const handler = (await es.createStream())!;
    const done = handler.subscribe(async () => {}, null, {
      consumer: "svc-1",
      blockMs: 30000,
    });
    await waitFor(() => handler.running && handler.clientId > 0);
    await sleep(200); // now blocked inside XREADGROUP BLOCK 30000
    const t0 = Date.now();
    await handler.stop();
    await done;
    const elapsed = Date.now() - t0;
    assert(elapsed < 2000, `stop took ${elapsed} ms`);
    assertEquals(handler.running, false);
    const list = String(await client.sendCommand(["CLIENT", "LIST"]));
    assert(
      !list.includes(`id=${handler.clientId} `),
      "dedicated connection still open",
    );
    // consumer registered under the per-call name, no stray default name
    const consumers = await client.xInfoConsumers(`${prefix}s`, "grp");
    assertEquals(consumers.map((c: { name: string }) => c.name), ["svc-1"]);
  } finally {
    await cleanup();
  }
});

Deno.test("legacy subscribe(handler, events) still works; message carries streamKey; ack via main client", async () => {
  const { client, prefix, cleanup } = await setup();
  try {
    const key = `${prefix}s`;
    const es = new RedisEventStream(client, key, "grp", { logger: quiet });
    const handler = (await es.createStream())!;
    const got: StreamMessage[] = [];
    const done = handler.subscribe(async (m) => {
      got.push(m);
      await m.ack();
    }, ["WANTED"]);
    await waitFor(() => handler.running);
    await es.publish("OTHER", "a1", { x: 1 }, {});
    await es.publish("WANTED", "a2", { x: 2 }, { h: "v" });
    await waitFor(() => got.length === 1);
    assertEquals(got[0].event, "WANTED");
    assertEquals(got[0].streamKey, key);
    assertEquals(got[0].payload, { x: 2 });
    assertEquals(got[0].headers, { h: "v" });
    await sleep(50);
    const pending = await client.sendCommand(["XPENDING", key, "grp"]);
    assertEquals(Number((pending as unknown[])[0]), 0);
    await handler.stop();
    await done;
  } finally {
    await cleanup();
  }
});

Deno.test("drain: poison entry is parked + acked, other pending entries handled, loop continues to '>'", async () => {
  const { client, prefix, cleanup } = await setup();
  try {
    const key = `${prefix}s`;
    const parked = `${prefix}parked`;
    const es = new RedisEventStream(client, key, "grp", { logger: quiet });
    await es.ensureGroup(key, "$");
    // poison: delivered to svc-1, never acked, delivery count pushed to 7
    const poisonId = await client.xAdd(key, "*", entry("POISON"));
    await client.sendCommand([
      "XREADGROUP",
      "GROUP",
      "grp",
      "svc-1",
      "COUNT",
      "10",
      "STREAMS",
      key,
      ">",
    ]);
    await client.sendCommand([
      "XCLAIM",
      key,
      "grp",
      "svc-1",
      "0",
      poisonId,
      "RETRYCOUNT",
      "7",
    ]);
    // two normal pending entries (count 1); the handler will NOT ack the first
    // one, which a fixed-"0" drain would return forever
    const okId1 = await client.xAdd(key, "*", entry("OK", { n: 1 }));
    const okId2 = await client.xAdd(key, "*", entry("OK", { n: 2 }));
    await client.sendCommand([
      "XREADGROUP",
      "GROUP",
      "grp",
      "svc-1",
      "COUNT",
      "10",
      "STREAMS",
      key,
      ">",
    ]);

    const handler = (await es.createStream())!;
    const got: StreamMessage[] = [];
    const done = handler.subscribe(
      async (m) => {
        got.push(m);
        if (m.streamId !== okId1) await m.ack();
      },
      null,
      {
        consumer: "svc-1",
        blockMs: 5000,
        drain: { maxDeliveries: 5, parkedStream: parked, batch: 1 },
        autoClaim: false,
      },
    );

    await waitFor(() => got.length === 2);
    assertEquals(got.map((m) => m.streamId), [okId1, okId2]);
    assertEquals(got[0].deliveries, 2);

    // loop moved on to new entries
    const newId = await client.xAdd(key, "*", entry("OK", { n: 3 }));
    await waitFor(() => got.length === 3);
    assertEquals(got[2].streamId, newId);
    assertEquals(got[2].deliveries, undefined);

    const parkedEntries = await client.xRange(parked, "-", "+");
    assertEquals(parkedEntries.length, 1);
    const p = parkedEntries[0].message;
    assertEquals(p.entryId, poisonId);
    assertEquals(p.streamKey, key);
    assertEquals(p.group, "grp");
    assertEquals(p.consumer, "svc-1");
    assertEquals(p.deliveries, "8");
    assertEquals(p.event, "POISON");
    assert(p.reason.includes("max 5"));

    // only the deliberately un-acked entry remains pending
    const rows = await client.sendCommand([
      "XPENDING",
      key,
      "grp",
      "-",
      "+",
      "10",
    ]) as unknown[][];
    assertEquals(rows.map((r) => r[0]), [okId1]);

    await handler.stop();
    await done;
  } finally {
    await cleanup();
  }
});

Deno.test("drain acks PEL entries whose stream entry was trimmed", async () => {
  const { client, prefix, cleanup } = await setup();
  try {
    const key = `${prefix}s`;
    const es = new RedisEventStream(client, key, "grp", { logger: quiet });
    await es.ensureGroup(key, "$");
    await client.xAdd(key, "*", entry("GONE"));
    await client.sendCommand([
      "XREADGROUP",
      "GROUP",
      "grp",
      "svc-1",
      "STREAMS",
      key,
      ">",
    ]);
    await client.sendCommand(["XTRIM", key, "MAXLEN", "0"]);
    const handler = (await es.createStream())!;
    let calls = 0;
    const done = handler.subscribe(
      () => {
        calls++;
        return Promise.resolve();
      },
      null,
      { consumer: "svc-1", blockMs: 1000, autoClaim: false },
    );
    await waitFor(() => handler.running);
    await sleep(200);
    const summary = await client.sendCommand(["XPENDING", key, "grp"]);
    assertEquals(Number((summary as unknown[])[0]), 0);
    assertEquals(calls, 0);
    await handler.stop();
    await done;
  } finally {
    await cleanup();
  }
});

Deno.test("startId is respected when the group is created (MKSTREAM)", async () => {
  const { client, prefix, cleanup } = await setup();
  try {
    const key = `${prefix}s`;
    const e1 = await client.xAdd(key, "*", entry("OLD", { n: 1 }));
    const e2 = await client.xAdd(key, "*", entry("OLD", { n: 2 }));

    // group A created at "0" via per-call startId → sees the history
    const esA = new RedisEventStream(client, key, "grpA", { logger: quiet });
    const hA = (await esA.createStream(undefined, { startId: "0" }))!;
    const gotA: string[] = [];
    const doneA = hA.subscribe(
      async (m) => {
        gotA.push(m.streamId);
        await m.ack();
      },
      null,
      { consumer: "a-1", startId: "0", blockMs: 1000 },
    );

    // group B with the default "$" → sees nothing old
    const esB = new RedisEventStream(client, key, "grpB", { logger: quiet });
    const hB = (await esB.createStream())!;
    const gotB: string[] = [];
    const doneB = hB.subscribe(
      async (m) => {
        gotB.push(m.streamId);
        await m.ack();
      },
      null,
      { consumer: "b-1", blockMs: 1000 },
    );

    // group C: created explicitly with ensureGroup at an entry id; the later
    // createStream()/subscribe() leave the existing group untouched (BUSYGROUP)
    const keyC = `${prefix}c`;
    const c1 = await client.xAdd(keyC, "*", entry("OLD"));
    const c2 = await client.xAdd(keyC, "*", entry("OLD"));
    const c3 = await client.xAdd(keyC, "*", entry("OLD"));
    const esC = new RedisEventStream(client, [], "grpC", { logger: quiet });
    await esC.ensureGroup(keyC, c1); // group starts after c1
    const hC = (await esC.createStream(keyC))!;
    const gotC: string[] = [];
    const doneC = hC.subscribe(
      async (m) => {
        gotC.push(m.streamId);
        await m.ack();
      },
      null,
      { consumer: "c-1", blockMs: 1000 },
    );

    await waitFor(() => gotA.length === 2 && gotC.length === 2);
    await sleep(200);
    assertEquals(gotA, [e1, e2]);
    assertEquals(gotB, []);
    assertEquals(gotC, [c2, c3]);

    // MKSTREAM: a group on a not-yet-existing stream
    const esD = new RedisEventStream(client, `${prefix}d`, "grpD", {
      logger: quiet,
    });
    await esD.ensureGroup(`${prefix}d`, "0");
    await esD.ensureGroup(`${prefix}d`, "0"); // BUSYGROUP ignored
    assertEquals(await client.exists(`${prefix}d`), 1);

    await Promise.all([hA.stop(), hB.stop(), hC.stop()]);
    await Promise.all([doneA, doneB, doneC]);
  } finally {
    await cleanup();
  }
});

Deno.test("autoclaim: idle entry of a dead consumer is claimed at start and periodically", async () => {
  const { client, prefix, cleanup } = await setup();
  try {
    const key = `${prefix}s`;
    const es = new RedisEventStream(client, key, "grp", { logger: quiet });
    await es.ensureGroup(key, "$");
    const x = await client.xAdd(key, "*", entry("X"));
    await client.sendCommand([
      "XREADGROUP",
      "GROUP",
      "grp",
      "dead-1",
      "STREAMS",
      key,
      ">",
    ]);
    await sleep(150);

    const handler = (await es.createStream())!;
    const got: StreamMessage[] = [];
    const done = handler.subscribe(
      async (m) => {
        got.push(m);
        await m.ack();
      },
      null,
      {
        consumer: "svc-1",
        blockMs: 30000,
        autoClaim: { minIdleMs: 100, everyMs: 300 },
      },
    );

    // start pass
    await waitFor(() => got.length === 1);
    assertEquals(got[0].streamId, x);
    assertEquals(got[0].deliveries, 2);

    await handler.stop();
    await done;

    // periodic pass: orphan z while svc-1 is down, then start svc-1 with a
    // min-idle longer than z's idle time so the start pass skips it; a later
    // periodic pass claims it while the reader is blocked for 30 s, and the
    // CLIENT UNBLOCK wakes the reader to handle it
    const z = await client.xAdd(key, "*", entry("Z"));
    await client.sendCommand([
      "XREADGROUP",
      "GROUP",
      "grp",
      "dead-2",
      "STREAMS",
      key,
      ">",
    ]);
    const handler2 = (await es.createStream())!;
    const done2 = handler2.subscribe(
      async (m) => {
        got.push(m);
        await m.ack();
      },
      null,
      {
        consumer: "svc-1",
        blockMs: 30000,
        autoClaim: { minIdleMs: 400, everyMs: 300 },
      },
    );
    // at start z is not idle enough (< 400 ms) → claimed by a later periodic pass
    await waitFor(() => handler2.running);
    await sleep(50);
    assertEquals(got.length, 1);
    const t0 = Date.now();
    await waitFor(() => got.length === 2, 3000);
    assertEquals(got[1].streamId, z);
    assertEquals(got[1].deliveries, 2);
    assert(Date.now() - t0 < 2000, "periodic claim did not wake the reader");

    const summary = await client.sendCommand(["XPENDING", key, "grp"]);
    assertEquals(Number((summary as unknown[])[0]), 0);
    await handler2.stop();
    await done2;
  } finally {
    await cleanup();
  }
});

Deno.test("fatal handler error rejects subscribe after cleanup", async () => {
  const { client, prefix, cleanup } = await setup();
  try {
    const key = `${prefix}s`;
    const es = new RedisEventStream(client, key, "grp", { logger: quiet });
    const handler = (await es.createStream())!;
    const done = handler.subscribe(
      () => Promise.reject(new Error("boom")),
      null,
      { consumer: "svc-1", blockMs: 1000 },
    );
    await waitFor(() => handler.running);
    await es.publish("E", "a", {}, {});
    let err: unknown = null;
    try {
      await done;
    } catch (e) {
      err = e;
    }
    assert(err instanceof Error && err.message === "boom");
    assertEquals(handler.running, false);
    const list = String(await client.sendCommand(["CLIENT", "LIST"]));
    assert(
      !list.includes(`id=${handler.clientId} `),
      "dedicated connection still open after a fatal error",
    );
    await handler.stop(); // no-op after exit
  } finally {
    await cleanup();
  }
});
