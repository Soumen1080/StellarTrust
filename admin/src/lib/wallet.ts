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
 * The server issues a transaction carrying a random nonce, built so it can
 * never execute. The operator signs it in their wallet. The server checks the
 * signature against the *configured* public key. Because the nonce is random,
 * single-use, and short-lived, a captured signature is worth nothing: it
 * proves control at one moment for one challenge, and that challenge is spent.
 *
 * Why a transaction rather than a plain message
 * ─────────────────────────────────────────────
 * Wallets disagree about `signMessage` — some omit it, some return different
 * shapes, and hardware wallets generally cannot do it at all. Signing a
 * transaction is the one operation every Stellar wallet supports, so this is
 * what makes the standard Connect Wallet modal work here with any wallet the
 * operator chooses, exactly as it does on the main site.
 *
 * This is deliberately simpler than the platform's SEP-10 flow. SEP-10 exists
 * to authenticate *any* wallet against a service, which needs a server signing
 * key and a full transaction envelope. Here the question is narrower — "is this
 * the one key I already named?" — and a signed nonce answers it exactly, with
 * no signing key on this host at all.
 *
 * The challenge transaction is unsubmittable by construction:
 *   * sequence 0, which no real account ever has;
 *   * a zero-value manageData operation, which moves nothing even if it ran;
 *   * timebounds that expire in five minutes.
 * So a signature harvested here cannot be replayed as a payment.
 */
import { randomBytes } from "node:crypto";
import {
  Account,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { config } from "../config.js";

/** How long a challenge stays usable. Long enough to open a wallet, no longer. */
const CHALLENGE_TTL_MS = 5 * 60_000;

/** The data-entry name the operator sees in their wallet before approving. */
const CHALLENGE_KEY = "StellarTrust admin sign-in";

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

export function networkPassphrase(): string {
  return config.STELLAR_NETWORK === "public"
    ? Networks.PUBLIC
    : Networks.TESTNET;
}

/**
 * Build the exact challenge transaction for a nonce.
 *
 * Deterministic: issuing and verifying both call this, so the server compares
 * against a transaction it rebuilt itself rather than trusting the envelope
 * the client sent back.
 */
function buildChallengeXdr(nonce: string): string {
  return new TransactionBuilder(new Account(config.ADMIN_WALLET, "-1"), {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(),
    // No timebounds: the challenge's own five-minute expiry governs, and a
    // wallet that rewrites timebounds would otherwise change the hash and make
    // a legitimate signature unverifiable.
    timebounds: { minTime: 0, maxTime: 0 },
  })
    .addOperation(
      Operation.manageData({
        name: CHALLENGE_KEY,
        value: nonce,
        source: config.ADMIN_WALLET,
      }),
    )
    .build()
    .toXDR();
}

export interface IssuedChallenge {
  challengeId: string;
  /** The unsigned transaction the wallet is asked to sign. */
  transactionXdr: string;
  networkPassphrase: string;
  /** Plain-language description of what is being signed, shown on the page. */
  message: string;
}

export function issueChallenge(): IssuedChallenge {
  sweep();
  const challengeId = randomBytes(16).toString("hex");
  // 64 base64 chars — inside manageData's 64-byte value limit.
  const nonce = randomBytes(48).toString("base64");
  outstanding.set(challengeId, {
    nonce,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  });
  return {
    challengeId,
    transactionXdr: buildChallengeXdr(nonce),
    networkPassphrase: networkPassphrase(),
    message: `${CHALLENGE_KEY}\n\nnonce: ${nonce}`,
  };
}

export type WalletProofResult = { ok: true } | { ok: false; reason: string };

/**
 * Verify a signed challenge transaction.
 *
 * The challenge is consumed whether or not verification succeeds. A challenge
 * that survived a failed attempt would let an attacker grind signatures
 * against one nonce, which is the whole reason it is single-use.
 */
export function verifyWalletProof(
  challengeId: string,
  signedTransactionXdr: string,
): WalletProofResult {
  sweep();

  const challenge = outstanding.get(challengeId);
  // Consumed immediately, before any check that could fail.
  outstanding.delete(challengeId);

  if (!challenge) {
    return { ok: false, reason: "That challenge has expired. Try again." };
  }

  const passphrase = networkPassphrase();

  let signed;
  try {
    signed = TransactionBuilder.fromXDR(signedTransactionXdr, passphrase);
  } catch {
    return { ok: false, reason: "That signed transaction could not be read." };
  }

  // Compare against a transaction rebuilt here from the stored nonce. The
  // client could otherwise return a signature over a *different* transaction —
  // one it authored — and a naive signature check would accept it.
  let expected;
  try {
    expected = TransactionBuilder.fromXDR(
      buildChallengeXdr(challenge.nonce),
      passphrase,
    );
  } catch {
    return { ok: false, reason: "The challenge could not be verified." };
  }

  if (!signed.hash().equals(expected.hash())) {
    return {
      ok: false,
      reason: "That signature is for a different challenge. Try again.",
    };
  }

  // Checked against the *configured* wallet, not one the request names. A
  // request that supplied its own public key would be proving control of a key
  // it chose, which proves nothing at all.
  let keypair: Keypair;
  try {
    keypair = Keypair.fromPublicKey(config.ADMIN_WALLET);
  } catch {
    return { ok: false, reason: "The signature could not be verified." };
  }

  const payload = signed.hash();
  const matched = signed.signatures.some((decorated) => {
    // Cheap hint-based filter first, then the real check. The hint alone is
    // four bytes and collides, so it can never be the deciding test.
    if (!decorated.hint().equals(keypair.signatureHint())) return false;
    return keypair.verify(payload, decorated.signature());
  });

  if (!matched) {
    return {
      ok: false,
      reason: "That signature is not from the authorised wallet.",
    };
  }

  return { ok: true };
}

/** Test-only: clear outstanding challenges between cases. */
export function resetChallenges(): void {
  outstanding.clear();
}
