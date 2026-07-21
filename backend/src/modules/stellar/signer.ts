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
import { ExternalServiceError } from "../../lib/errors.js";
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

/**
 * Stable demo signer for deployed testnet demos. Loads a Stellar secret seed
 * from the environment (host secret manager) so the server public key is the
 * same across serverless instances/restarts — unlike LocalStubSigner, whose
 * ephemeral key differs per process and breaks SEP-10 across instances.
 *
 * Testnet-only and gated behind DEMO_MODE. This is NOT a production signer:
 * production real-money signing must use the KMS/HSM boundary (KmsSigner).
 */
export class DemoEnvSigner implements Signer {
  private readonly keypair: Keypair;

  constructor(secret: string) {
    this.keypair = Keypair.fromSecret(secret);
    logger.warn(
      { publicKey: this.keypair.publicKey() },
      "using DEMO env signer — testnet demo key from environment. Not for production real-money signing.",
    );
  }

  async getPublicKey(): Promise<string> {
    return this.keypair.publicKey();
  }

  async signTransactionXdr(
    xdr: string,
    networkPassphrase: string,
  ): Promise<string> {
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

/** Fail-closed signer used when production signing is not configured. */
class UnavailableSigner implements Signer {
  private unavailable(): never {
    throw new ExternalServiceError("Wallet signing service is unavailable");
  }

  async getPublicKey(): Promise<string> {
    return this.unavailable();
  }

  async signTransactionXdr(): Promise<string> {
    return this.unavailable();
  }
}

/** Factory: pick the signer without allowing the local stub in real environments. */
export function createSigner(): Signer {
  if (config.SIGNER_PROVIDER === "local-stub") {
    // Stable testnet demo signer (DEMO_MODE) unblocks deployed demos where the
    // ephemeral in-process stub key would differ across instances/restarts.
    if (config.DEMO_MODE && config.DEMO_SIGNER_SECRET) {
      if (config.STELLAR_NETWORK !== "testnet") {
        logger.error(
          "DEMO signer is permitted on testnet only; refusing to sign on the public network",
        );
        return new UnavailableSigner();
      }
      return new DemoEnvSigner(config.DEMO_SIGNER_SECRET);
    }
    if (config.NODE_ENV === "staging" || config.NODE_ENV === "production") {
      logger.error(
        "wallet signing disabled: configure a KMS/HSM signer (or DEMO_MODE testnet signer) for staging/production",
      );
      return new UnavailableSigner();
    }
    return new LocalStubSigner();
  }
  return new KmsSigner(config.SIGNER_KEY_REF);
}
