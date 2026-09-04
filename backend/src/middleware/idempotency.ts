/**
 * Idempotency middleware (Rules.md #4).
 * All money-mutating endpoints require an `Idempotency-Key` header. Retries with
 * the same key + same request body return the stored response instead of
 * re-executing — retries must never double-spend.
 *
 * Phase 0 uses an in-memory store behind an interface; a Redis-backed store
 * replaces it in later phases without changing call sites.
 */
import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { idempotencyKeySchema } from "@stellartrust/shared";
import {
  IdempotencyConflictError,
  ValidationError,
} from "../lib/errors.js";

export interface StoredResponse {
  statusCode: number;
  body: unknown;
  requestHash: string;
}

export interface IdempotencyStore {
  get(key: string): Promise<StoredResponse | undefined>;
  set(key: string, value: StoredResponse): Promise<void>;
}

/** In-memory store for local/dev + tests. Not for multi-instance production. */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, StoredResponse>();

  async get(key: string): Promise<StoredResponse | undefined> {
    return this.map.get(key);
  }

  async set(key: string, value: StoredResponse): Promise<void> {
    this.map.set(key, value);
  }
}

/**
 * Redis-backed store (plane.md §4.1).
 *
 * Closes the standing Golden Rule #4 hole: with the in-memory store, two API
 * instances each kept their own copy of every key, so a retry that landed on
 * the other instance found nothing stored and re-executed. On a money-mutating
 * endpoint that is a double spend.
 *
 * Keys expire. An idempotency key is meaningful for as long as a client might
 * retry with it — minutes, not forever — and a store that never forgets grows
 * without bound and eventually refuses the writes it exists to serve.
 */
export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly redis: {
      get(key: string): Promise<string | null>;
      set(
        key: string,
        value: string,
        mode: "EX",
        ttl: number,
      ): Promise<unknown>;
    },
    private readonly ttlSeconds = 86_400,
    /** Namespaced so a shared Redis is not ambiguous between deployments. */
    private readonly prefix = "idem:",
  ) {}

  async get(key: string): Promise<StoredResponse | undefined> {
    const raw = await this.redis.get(this.prefix + key);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as StoredResponse;
    } catch {
      // A value we cannot parse is a value we cannot replay. Treating it as
      // absent re-executes the request, which is the same outcome the client
      // would have got had the key expired — and far better than serving a
      // corrupted response as if it were the original.
      return undefined;
    }
  }

  async set(key: string, value: StoredResponse): Promise<void> {
    await this.redis.set(
      this.prefix + key,
      JSON.stringify(value),
      "EX",
      this.ttlSeconds,
    );
  }
}

/**
 * Use Redis when it is configured, memory otherwise.
 *
 * The fallback is deliberate and is *not* silent: a deployment without Redis
 * keeps the documented single-instance constraint and says so at boot, rather
 * than failing to start. Failing closed here would mean an operator who has
 * not yet provisioned Redis cannot run the platform at all, which trades a
 * known limitation for an outage.
 */
export function createIdempotencyStore(
  redis:
    | ConstructorParameters<typeof RedisIdempotencyStore>[0]
    | undefined,
): IdempotencyStore {
  return redis ? new RedisIdempotencyStore(redis) : new InMemoryIdempotencyStore();
}

function hashRequest(req: Request): string {
  const payload = JSON.stringify({
    method: req.method,
    path: req.path,
    body: req.body ?? null,
  });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Returns middleware enforcing idempotency using the provided store.
 * Apply to money-mutating routes only.
 */
export function idempotency(store: IdempotencyStore) {
  return async function idempotencyMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const rawKey = req.header("idempotency-key");
    const parsed = idempotencyKeySchema.safeParse(rawKey);
    if (!parsed.success) {
      next(
        new ValidationError(
          "A valid Idempotency-Key header is required for this operation.",
        ),
      );
      return;
    }
    const key = parsed.data;
    const requestHash = hashRequest(req);

    try {
      const existing = await store.get(key);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          // Same key, different payload → reject (Rules.md §5 idempotent retries).
          next(new IdempotencyConflictError());
          return;
        }
        res.status(existing.statusCode).json(existing.body);
        return;
      }
    } catch (err) {
      next(err);
      return;
    }

    // Capture the response so a retry can be replayed.
    //
    // Only successful responses are stored. Replaying a 4xx/5xx would make a
    // transient failure permanent for that key: a payment that failed because
    // the chain was briefly unreachable would keep returning the same error to
    // every retry, when retrying is exactly the right response to it.
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        // Not awaited — Express's `json` is synchronous and the response must
        // go out regardless. A store write that fails costs us the replay,
        // which the client experiences as a re-execution guarded by whatever
        // service-level idempotency the operation has of its own; it never
        // costs us the response itself.
        void store
          .set(key, { statusCode: res.statusCode, body, requestHash })
          .catch(() => undefined);
      }
      return originalJson(body);
    };

    next();
  };
}
