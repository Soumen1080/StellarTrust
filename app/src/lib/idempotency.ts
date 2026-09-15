/**
 * Idempotency keys for money-mutating requests.
 *
 * The API requires one on every such endpoint (Rules.md #4) and collapses
 * repeats of the same key into the first response. That only protects the user
 * if the key survives the retry — a fresh key per attempt is a fresh charge.
 *
 * So a key is minted once per *intent* (this order, this withdrawal) and held
 * until that intent succeeds. Two things can retry underneath it: the
 * transport, on a timeout, and the user, by pressing the button again after a
 * failure. Both must present the same key.
 */
import * as Crypto from "expo-crypto";
import { useCallback, useRef } from "react";

export function newIdempotencyKey(): string {
  return Crypto.randomUUID();
}

/**
 * A key that is stable across retries of one intent.
 *
 * Returns `next()`, which mints a key on first call and returns that same key
 * on every later call, and `reset()`, which the caller invokes once the
 * operation has definitively succeeded so the next one starts fresh.
 *
 * Deliberately not `useState`: the key must be readable synchronously inside
 * the submit handler that mints it, and a state update would not be visible
 * until the next render.
 */
export function useIdempotencyKey(): {
  next: () => string;
  reset: () => void;
} {
  const keyRef = useRef<string | null>(null);

  const next = useCallback((): string => {
    if (!keyRef.current) keyRef.current = newIdempotencyKey();
    return keyRef.current;
  }, []);

  const reset = useCallback((): void => {
    keyRef.current = null;
  }, []);

  return { next, reset };
}
