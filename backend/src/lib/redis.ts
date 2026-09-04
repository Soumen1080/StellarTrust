/**
 * Redis connection boundary (plane.md §4.1).
 *
 * The standing Golden Rule #4 hole: idempotency and rate limiting were both
 * in-process, so two API instances each kept their own copy. A retry that
 * landed on the other instance saw no stored response and re-executed — which
 * on a money-mutating endpoint is a double spend, and is exactly what
 * idempotency keys exist to prevent.
 *
 * One connection for the whole process, created lazily and only when
 * `REDIS_URL` is configured. Everything downstream degrades to its in-memory
 * implementation when it is not, so a deployment without Redis keeps working
 * with the documented single-instance constraint rather than failing to boot.
 */
// ioredis ships CJS with the class on `default`. Under this project's
// NodeNext resolution the namespace import is what actually resolves, so the
// class is reached through `.default` and typed from the instance type.
import * as IORedis from "ioredis";

const RedisClient = (IORedis as unknown as { default: typeof IORedis.Redis })
  .default;
type RedisConnection = IORedis.Redis;
import { config } from "../config/index.js";
import { logger } from "./logger.js";

let client: RedisConnection | undefined;
let unavailable = false;

/**
 * The shared Redis client, or `undefined` when Redis is not configured.
 *
 * Never throws. A caller uses the answer to choose an implementation, and a
 * throw here would turn "no Redis configured" into a failed boot.
 */
export function getRedis(): RedisConnection | undefined {
  if (unavailable) return undefined;
  if (client) return client;
  if (!config.REDIS_URL) return undefined;

  try {
    client = new RedisClient(config.REDIS_URL, {
      // Fail a command rather than queue it forever when the connection is
      // down. An idempotency check that hangs is worse than one that errors:
      // the request is already holding a connection, and the caller has a
      // timeout of their own.
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: false,
      connectTimeout: 5_000,
      // A managed Redis (Upstash, Redis Cloud) is TLS on rediss://; ioredis
      // infers that from the scheme, so nothing is forced here.
    });

    client.on("error", (err: Error) => {
      // Logged, not thrown. A Redis blip must not take the API down — the
      // stores that use it decide their own fallback.
      logger.warn({ errorType: err.name }, "redis connection error");
    });
    client.on("connect", () => {
      logger.info("redis: connected");
    });

    return client;
  } catch (err) {
    unavailable = true;
    logger.error(
      { errorType: (err as Error).name },
      "redis: failed to construct client; falling back to in-memory stores",
    );
    return undefined;
  }
}

/** Close the shared connection. Used by the server's shutdown path. */
export async function closeRedis(): Promise<void> {
  if (!client) return;
  const current = client;
  client = undefined;
  await current.quit().catch(() => current.disconnect());
}
