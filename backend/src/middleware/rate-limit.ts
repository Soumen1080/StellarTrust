/**
 * Rate-limit store backed by Redis (plane.md §4.1).
 *
 * `express-rate-limit`'s default store is per-process. Behind two API
 * instances a limit of 300/minute is really 600/minute, and the limit that
 * matters — the one on an authentication or payment endpoint — is the one an
 * attacker can double simply by being load-balanced elsewhere.
 *
 * This implements express-rate-limit v8's `Store` against Redis, so the window
 * is shared. It deliberately does *not* pull in `rate-limit-redis`: the whole
 * implementation is one INCR and one EXPIRE, and a dependency whose job is to
 * write four lines is a dependency that has to be pinned, audited, and
 * upgraded for the life of the project (Rules.md §4).
 */
import type { Store, ClientRateLimitInfo, Options } from "express-rate-limit";
import { logger } from "../lib/logger.js";

/** The slice of ioredis this store needs, so tests can supply a fake. */
export interface RateLimitRedis {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<unknown>;
  pttl(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  del(key: string): Promise<unknown>;
}

export class RedisRateLimitStore implements Store {
  private windowMs = 60_000;

  constructor(
    private readonly redis: RateLimitRedis,
    readonly prefix = "rl:",
  ) {}

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const redisKey = this.prefix + key;
    try {
      const totalHits = await this.redis.incr(redisKey);
      // Set the expiry only on the first hit of a window. Refreshing it on
      // every request would turn a fixed window into a sliding one that never
      // expires while traffic continues, and a caller under sustained load
      // would stay blocked indefinitely rather than for one window.
      if (totalHits === 1) {
        await this.redis.pexpire(redisKey, this.windowMs);
      }
      const ttl = await this.redis.pttl(redisKey);
      return {
        totalHits,
        resetTime: new Date(Date.now() + (ttl > 0 ? ttl : this.windowMs)),
      };
    } catch (err) {
      // Redis is down. Fail *open* — a rate limiter that cannot reach its
      // store must not become an outage of the whole API. This is the one
      // place in the platform where failing open is right: the limiter
      // protects against abuse, not against incorrect money movement, and
      // every money path has its own authorization and idempotency behind it.
      logger.warn(
        { errorType: (err as Error).name },
        "rate limiter: redis unavailable, allowing the request",
      );
      return { totalHits: 1, resetTime: new Date(Date.now() + this.windowMs) };
    }
  }

  async decrement(key: string): Promise<void> {
    await this.redis.decr(this.prefix + key).catch(() => undefined);
  }

  async resetKey(key: string): Promise<void> {
    await this.redis.del(this.prefix + key).catch(() => undefined);
  }
}
