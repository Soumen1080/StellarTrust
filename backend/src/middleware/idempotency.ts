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
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      void store.set(key, {
        statusCode: res.statusCode,
        body,
        requestHash,
      });
      return originalJson(body);
    };

    next();
  };
}
