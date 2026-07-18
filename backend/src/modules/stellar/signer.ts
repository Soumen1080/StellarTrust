/**
 * Signing boundary (Golden Rule #2: no secret keys in code, DB, env, or logs).
 *
 * All transaction signing goes through this interface. The concrete signer is
 * chosen by config (`SIGNER_PROVIDER`):
 *   - `local-stub` : ephemeral in-memory keypair for local dev/tests. The secret
 *                    is generated at boot, never persisted, never logged, never
 *                    read from env. Cannot be used in staging/production.
 *   - `aws-kms` / `gcp-kms` : real KMS/HSM signer (implemented in a later phase).
 *
 * Real environments MUST use a KMS/HSM provider; the stub is rejected there.
 */
import { Keypair } from "@stellar/stellar-sdk";
import { config } from "../../config/index.js";
import { logger } from "../../lib/logger.js";

export interface Signer {
  /** The Stellar public key this signer signs for. Public keys are not secret. */
  getPublicKey(): Promise<string>;
  /**
   * Sign a base64 transaction envelope (XDR) for the given network passphrase.
   * Returns the signed envelope XDR. Secret material never leaves the boundary.
   */
  signTransactionXdr(xdr: string, networkPassphrase: string): Promise<string>;
}

/**
 * Local development stub. Generates a random ephemeral keypair at construction.
 * The secret key exists only in process memory and is never logged or exported.
 */
export class LocalStubSigner implements Signer {
  private readonly keypair: Keypair;

  constructor() {
    this.keypair = Keypair.random();
    logger.warn(
      { publicKey: this.keypair.publicKey() },
      "using LOCAL STUB signer — ephemeral in-memory key. Not for staging/production.",
    );
  }

  async getPublicKey(): Promise<string> {
    return this.keypair.publicKey();
  }

  async signTransactionXdr(
    xdr: string,
    networkPassphrase: string,
  ): Promise<string> {
    // Import lazily to avoid a hard dependency cycle at module load.
    const { TransactionBuilder } = await import("@stellar/stellar-sdk");
    const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
    tx.sign(this.keypair);
    return tx.toXDR();
  }
}

/** Placeholder for the real KMS/HSM signer, implemented in a later phase. */
export class KmsSigner implements Signer {
  constructor(private readonly keyRef: string) {}

  async getPublicKey(): Promise<string> {
    throw new Error(
      `KMS signer not implemented yet (keyRef=${this.keyRef}). Configure a real KMS/HSM before staging/production.`,
    );
  }

  async signTransactionXdr(): Promise<string> {
    throw new Error("KMS signer not implemented yet.");
  }
}

/** Factory: pick the signer from config, refusing the stub in real environments. */
export function createSigner(): Signer {
  if (config.SIGNER_PROVIDER === "local-stub") {
    if (config.NODE_ENV === "staging" || config.NODE_ENV === "production") {
      throw new Error(
        "SIGNER_PROVIDER=local-stub is forbidden in staging/production. Use a KMS/HSM provider.",
      );
    }
    return new LocalStubSigner();
  }
  return new KmsSigner(config.SIGNER_KEY_REF);
}
