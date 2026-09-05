/**
 * Second factor: proof of control over a specific Stellar wallet.
 *
 * A password alone is one leak away from full access — it can be phished,
 * reused, read from a hosting dashboard, or found in a backup. This adds a
 * factor that cannot be copied by reading something: the operator must sign a
 * challenge with a private key that never leaves their wallet.
 *
 * **Both factors are required.** The password proves something you know; the
 * signature proves something you hold. Either alone opens nothing.
 *
 * How the proof works
 * ───────────────────
 * The server issues a random nonce. The operator signs it in their wallet. The
 * server checks the signature against the *configured* public key. Because the
 * nonce is random, single-use, and short-lived, a captured signature is worth
 * nothing: it proves control at one moment for one challenge, and that
 * challenge is spent.
 *
 * This is deliberately simpler than the platform's SEP-10 flow. SEP-10 exists
 * to authenticate *any* wallet against a service, which needs a server signing
 * key and a full transaction envelope. Here the question is narrower — "is this
 * the one key I already named?" — and a signed nonce answers it exactly, with
 * no signing key on this host at all.
 */
import { randomBytes } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { config } from "../config.js";

/** How long a challenge stays usable. Long enough to open a wallet, no longer. */
const CHALLENGE_TTL_MS = 5 * 60_000;

interface Challenge {
  nonce: string;
  expiresAt: number;
}

/**
 * Outstanding challenges, keyed by the id handed to the client.
 *
 * In memory: a challenge lives for five minutes, and losing them on restart
 * costs an operator one retry. Persisting them would mean a table to migrate
 * and prune for no security gain.
 */
const outstanding = new Map<string, Challenge>();

/** Drop expired entries so a long-running process does not accumulate them. */
function sweep(): void {
  const now = Date.now();
  for (const [id, challenge] of outstanding) {
    if (challenge.expiresAt <= now) outstanding.delete(id);
  }
}

export interface IssuedChallenge {
  challengeId: string;
  /** The text the operator signs. Shown to them, so it says what it is for. */
  message: string;
}

export function issueChallenge(): IssuedChallenge {
  sweep();
  const challengeId = randomBytes(16).toString("hex");
  const nonce = randomBytes(32).toString("hex");
  outstanding.set(challengeId, {
    nonce,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  });
  // The message states its purpose in plain words. A wallet prompt showing raw
  // hex tells the signer nothing about what they are authorising, which is how
  // people are tricked into signing things.
  return {
    challengeId,
    message: `StellarTrust admin sign-in\n\nnonce: ${nonce}`,
  };
}

export type WalletProofResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Verify a signature over an issued challenge.
 *
 * The challenge is consumed whether or not verification succeeds. A challenge
 * that survived a failed attempt would let an attacker grind signatures
 * against one nonce, which is the whole reason it is single-use.
 */
export function verifyWalletProof(
  challengeId: string,
  signatureBase64: string,
): WalletProofResult {
  sweep();

  const challenge = outstanding.get(challengeId);
  // Consumed immediately, before any check that could fail.
  outstanding.delete(challengeId);

  if (!challenge) {
    return { ok: false, reason: "That challenge has expired. Try again." };
  }

  let signature: Buffer;
  try {
    signature = Buffer.from(signatureBase64, "base64");
  } catch {
    return { ok: false, reason: "The signature could not be read." };
  }
  if (signature.length === 0) {
    return { ok: false, reason: "The signature could not be read." };
  }

  const message = Buffer.from(
    `StellarTrust admin sign-in\n\nnonce: ${challenge.nonce}`,
    "utf8",
  );

  // Checked against the *configured* wallet, not one the request names. A
  // request that supplied its own public key would be proving control of a key
  // it chose, which proves nothing at all.
  try {
    const keypair = Keypair.fromPublicKey(config.ADMIN_WALLET);
    if (!keypair.verify(message, signature)) {
      return {
        ok: false,
        reason: "That signature is not from the authorised wallet.",
      };
    }
  } catch {
    return { ok: false, reason: "The signature could not be verified." };
  }

  return { ok: true };
}

/** Test-only: clear outstanding challenges between cases. */
export function resetChallenges(): void {
  outstanding.clear();
}
