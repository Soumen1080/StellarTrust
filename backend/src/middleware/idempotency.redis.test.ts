/**
 * Cross-instance idempotency and rate limiting (plane.md §4.1).
 *
 * The claim being tested is the one the in-memory store could not make: two
 * API *instances* agree. Both instances are modelled as two store objects over
 * one fake Redis, which is exactly the topology — separate processes, shared
 * backing store — and is what makes a retry landing on the other instance
 * replay rather than re-execute.
 */
import { describe, expect, it } from "vitest";
import {
  createIdempotencyStore,
  InMemoryIdempotencyStore,
  RedisIdempotencyStore,
  type StoredResponse,
} from "./idempotency.js";
import { RedisRateLimitStore, type RateLimitRedis } from "./rate-limit.js";
import type { Options } from "express-rate-limit";

/** A minimal Redis stand-in with the commands these stores actually use. */
class FakeRedis implements RateLimitRedis {
  readonly values = new Map<string, string>();
  readonly expiries = new Map<string, number>();
  failNext = false;

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, _mode: "EX", ttl: number) {
    this.values.set(key, value);
    this.expiries.set(key, ttl);
    return "OK";
  }

  async incr(key: string): Promise<number> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("connection refused");
    }
    const next = Number(this.values.get(key) ?? "0") + 1;
    this.values.set(key, String(next));
    return next;
  }

  async pexpire(key: string, ms: number) {
    this.expiries.set(key, ms);
    return 1;
  }

  async pttl(key: string): Promise<number> {
    return this.expiries.get(key) ?? -1;
  }

  async decr(key: string): Promise<number> {
    const next = Number(this.values.get(key) ?? "0") - 1;
    this.values.set(key, String(next));
    return next;
  }

  async del(key: string) {
    this.values.delete(key);
    this.expiries.delete(key);
    return 1;
  }
}

const response: StoredResponse = {
  statusCode: 201,
  body: { id: "order-1" },
  requestHash: "abc",
};

describe("idempotency across instances", () => {
  it("replays a response stored by the other instance", async () => {
    // The whole point of §4.1. With the in-memory store this returns
    // undefined, the request re-executes, and a payment is made twice.
    const redis = new FakeRedis();
    const instanceA = new RedisIdempotencyStore(redis);
    const instanceB = new RedisIdempotencyStore(redis);

    await instanceA.set("key-1", response);
    expect(await instanceB.get("key-1")).toEqual(response);
  });

  it("does not replay across instances with the in-memory store", async () => {
    // Stated as a test so the limitation is documented as behaviour rather
    // than as a comment: this is what the platform does without REDIS_URL.
    const instanceA = new InMemoryIdempotencyStore();
    const instanceB = new InMemoryIdempotencyStore();

    await instanceA.set("key-1", response);
    expect(await instanceB.get("key-1")).toBeUndefined();
  });

  it("expires keys so the store does not grow without bound", async () => {
    const redis = new FakeRedis();
    await new RedisIdempotencyStore(redis, 3600).set("key-1", response);
    expect(redis.expiries.get("idem:key-1")).toBe(3600);
  });

  it("namespaces keys so a shared Redis is unambiguous", async () => {
    const redis = new FakeRedis();
    await new RedisIdempotencyStore(redis).set("key-1", response);
    expect([...redis.values.keys()]).toEqual(["idem:key-1"]);
  });

  it("treats an unparseable value as absent rather than serving it", async () => {
    // Re-executing is the same outcome an expired key produces. Serving a
    // corrupted body as if it were the original response is not.
    const redis = new FakeRedis();
    redis.values.set("idem:key-1", "{not json");
    expect(await new RedisIdempotencyStore(redis).get("key-1")).toBeUndefined();
  });

  it("returns nothing for a key that was never set", async () => {
    expect(
      await new RedisIdempotencyStore(new FakeRedis()).get("missing"),
    ).toBeUndefined();
  });
});

describe("choosing a store", () => {
  it("uses Redis when one is available", () => {
    expect(createIdempotencyStore(new FakeRedis())).toBeInstanceOf(
      RedisIdempotencyStore,
    );
  });

  it("falls back to memory when Redis is not configured", () => {
    // Deliberate: a deployment without Redis keeps the single-instance
    // constraint rather than failing to boot.
    expect(createIdempotencyStore(undefined)).toBeInstanceOf(
      InMemoryIdempotencyStore,
    );
  });
});

describe("rate limiting across instances", () => {
  function store(redis: FakeRedis) {
    const limiter = new RedisRateLimitStore(redis);
    limiter.init({ windowMs: 60_000 } as Options);
    return limiter;
  }

  it("counts one caller's hits across both instances", async () => {
    // A 300/minute limit behind two instances is 600/minute unless the window
    // is shared. This is that.
    const redis = new FakeRedis();
    const instanceA = store(redis);
    const instanceB = store(redis);

    expect((await instanceA.increment("1.2.3.4")).totalHits).toBe(1);
    expect((await instanceB.increment("1.2.3.4")).totalHits).toBe(2);
    expect((await instanceA.increment("1.2.3.4")).totalHits).toBe(3);
  });

  it("counts different callers separately", async () => {
    const redis = new FakeRedis();
    const limiter = store(redis);
    await limiter.increment("1.2.3.4");
    expect((await limiter.increment("5.6.7.8")).totalHits).toBe(1);
  });

  it("sets the window expiry once, on the first hit", async () => {
    // Refreshing it on every request turns a fixed window into one that never
    // expires under load, so a caller stays blocked indefinitely.
    const redis = new FakeRedis();
    const limiter = store(redis);
    await limiter.increment("1.2.3.4");
    redis.expiries.set("rl:1.2.3.4", 12_345);
    await limiter.increment("1.2.3.4");
    expect(redis.expiries.get("rl:1.2.3.4")).toBe(12_345);
  });

  it("allows the request when Redis is unreachable", async () => {
    // The one place failing open is right: the limiter guards against abuse,
    // not against incorrect money movement, and every money path has its own
    // authorization and idempotency behind it. A limiter that cannot reach its
    // store must not become an outage of the whole API.
    const redis = new FakeRedis();
    redis.failNext = true;
    const result = await store(redis).increment("1.2.3.4");
    expect(result.totalHits).toBe(1);
  });

  it("releases a key on reset", async () => {
    const redis = new FakeRedis();
    const limiter = store(redis);
    await limiter.increment("1.2.3.4");
    await limiter.resetKey("1.2.3.4");
    expect((await limiter.increment("1.2.3.4")).totalHits).toBe(1);
  });
});
