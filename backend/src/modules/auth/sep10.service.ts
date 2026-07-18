/**
 * SEP-10 wallet authentication service.
 *
 * Challenges follow SEP-10's transaction shape and are signed only through the
 * Signer boundary (KMS/HSM in real environments; ephemeral stub locally). Client
 * signatures are verified by @stellar/stellar-sdk WebAuth. Successful proof
 * issues an opaque, one-hour server session; only its SHA-256 hash is stored.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  Account,
  BASE_FEE,
  Operation,
  TransactionBuilder,
  WebAuth,
} from "@stellar/stellar-sdk";
import type {
  AuthSessionResponse,
  Sep10ChallengeResponse,
  Sep10VerifyRequest,
} from "@stellartrust/shared";
import { config } from "../../config/index.js";
import { AuthError, ConflictError } from "../../lib/errors.js";
import type { AuthContext, BearerVerifier } from "../../middleware/auth.js";
import type { Signer } from "../stellar/signer.js";
import type { IdentityRepository } from "../identity/identity.repository.js";
import type { AuthRepository } from "./auth.repository.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class Sep10Service {
  constructor(
    private readonly authRepo: AuthRepository,
    private readonly identityRepo: IdentityRepository,
    private readonly signer: Signer,
  ) {}

  async createChallenge(
    stellarPublicKey: string,
  ): Promise<Sep10ChallengeResponse> {
    const serverPublicKey = await this.signer.getPublicKey();
    const now = Math.floor(Date.now() / 1_000);
    const expires = now + config.SEP10_CHALLENGE_TTL_SECONDS;

    // Account sequence -1 makes TransactionBuilder produce sequence 0, as
    // required by SEP-10. The 48-byte nonce prevents replay/collision.
    const tx = new TransactionBuilder(new Account(serverPublicKey, "-1"), {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
      timebounds: { minTime: now, maxTime: expires },
    })
      .addOperation(
        Operation.manageData({
          name: `${config.SEP10_HOME_DOMAIN} auth`,
          value: randomBytes(48).toString("base64"),
          source: stellarPublicKey,
        }),
      )
      .addOperation(
        Operation.manageData({
          name: "web_auth_domain",
          value: config.SEP10_WEB_AUTH_DOMAIN,
          source: serverPublicKey,
        }),
      )
      .build();

    const signedXdr = await this.signer.signTransactionXdr(
      tx.toXDR(),
      this.networkPassphrase,
    );
    const signedTx = TransactionBuilder.fromXDR(
      signedXdr,
      this.networkPassphrase,
    );
    const challengeId = randomUUID();
    const expiresAt = new Date(expires * 1_000).toISOString();

    await this.authRepo.saveChallenge({
      id: challengeId,
      stellarPublicKey,
      transactionHash: signedTx.hash().toString("hex"),
      expiresAt,
      consumedAt: null,
    });

    return {
      challengeId,
      transactionXdr: signedXdr,
      networkPassphrase: this.networkPassphrase,
      expiresAt,
    };
  }

  async verifyChallenge(
    input: Sep10VerifyRequest,
  ): Promise<AuthSessionResponse> {
    const challenge = await this.authRepo.getChallenge(input.challengeId);
    if (!challenge) throw new AuthError("Unknown wallet challenge");
    if (challenge.consumedAt) throw new ConflictError("Challenge already used");
    if (challenge.expiresAt <= new Date().toISOString()) {
      throw new AuthError("Wallet challenge expired");
    }

    const serverPublicKey = await this.signer.getPublicKey();
    let signedTx;
    try {
      signedTx = TransactionBuilder.fromXDR(
        input.signedTransactionXdr,
        this.networkPassphrase,
      );
      if (signedTx.hash().toString("hex") !== challenge.transactionHash) {
        throw new AuthError("Signed challenge does not match the issued challenge");
      }

      const signers = WebAuth.verifyChallengeTxSigners(
        input.signedTransactionXdr,
        serverPublicKey,
        this.networkPassphrase,
        [challenge.stellarPublicKey],
        [config.SEP10_HOME_DOMAIN],
        config.SEP10_WEB_AUTH_DOMAIN,
      );
      if (!signers.includes(challenge.stellarPublicKey)) {
        throw new AuthError("Wallet signature is missing");
      }
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw new AuthError("Invalid wallet challenge signature");
    }

    const consumed = await this.authRepo.consumeChallenge(
      input.challengeId,
      new Date().toISOString(),
    );
    if (!consumed) throw new ConflictError("Challenge already used");

    const { user, wallet } = await this.identityRepo.upsertWalletIdentity(
      challenge.stellarPublicKey,
    );
    const accessToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(
      Date.now() + config.AUTH_SESSION_TTL_SECONDS * 1_000,
    ).toISOString();
    await this.authRepo.saveSession({
      tokenHash: sha256(accessToken),
      userId: user.id,
      walletId: wallet.id,
      expiresAt,
      revokedAt: null,
    });

    return {
      accessToken,
      tokenType: "Bearer",
      expiresAt,
      user,
      wallet,
    };
  }

  readonly sessionVerifier: BearerVerifier = async (
    token: string,
  ): Promise<AuthContext | null> => {
    const session = await this.authRepo.findActiveSession(
      sha256(token),
      new Date().toISOString(),
    );
    return session
      ? {
          userId: session.userId,
          walletId: session.walletId,
          roles: ["user"],
        }
      : null;
  };

  private get networkPassphrase(): string {
    return config.STELLAR_NETWORK === "public"
      ? "Public Global Stellar Network ; September 2015"
      : "Test SDF Network ; September 2015";
  }
}

/** Try verifiers in order without letting one invalid-token result block another. */
export function composeBearerVerifiers(
  ...verifiers: BearerVerifier[]
): BearerVerifier {
  return async (token) => {
    for (const verifier of verifiers) {
      const context = await verifier(token);
      if (context) return context;
    }
    return null;
  };
}
