import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

async function walletSignIn(app: ReturnType<typeof createApp>) {
  const wallet = Keypair.random();
  const challenge = await request(app)
    .post("/api/auth/sep10/challenge")
    .send({ account: wallet.publicKey() });
  expect(challenge.status).toBe(201);

  const tx = TransactionBuilder.fromXDR(
    challenge.body.transactionXdr,
    challenge.body.networkPassphrase,
  );
  tx.sign(wallet);
  const verify = await request(app).post("/api/auth/sep10/verify").send({
    challengeId: challenge.body.challengeId,
    signedTransactionXdr: tx.toXDR(),
  });
  expect(verify.status).toBe(200);
  return {
    wallet,
    token: verify.body.accessToken as string,
    challengeId: challenge.body.challengeId as string,
    signedTransactionXdr: tx.toXDR(),
  };
}

function application(overrides: Record<string, unknown> = {}) {
  return {
    applicantType: "individual",
    email: "applicant@example.test",
    legalName: "Sandbox Applicant",
    country: "US",
    dateOfBirth: "1990-01-01",
    document: {
      kind: "passport",
      issuingCountry: "US",
      number: "PASS-123456",
      expiryDate: "2099-01-01",
      frontImageRef: "sandbox://document/pass",
    },
    faceImageRef: "sandbox://face/pass",
    ...overrides,
  };
}

describe("Phase 1 SEP-10 wallet authentication", () => {
  it("issues a session after a valid wallet-signed challenge", async () => {
    const app = createApp();
    const signedIn = await walletSignIn(app);

    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${signedIn.token}`);
    expect(me.status).toBe(200);
    expect(me.body.wallets[0].stellarPublicKey).toBe(
      signedIn.wallet.publicKey(),
    );
    expect(me.body.user.kycStatus).toBe("pending");
  });

  it("rejects challenge replay", async () => {
    const app = createApp();
    const signedIn = await walletSignIn(app);
    const replay = await request(app).post("/api/auth/sep10/verify").send({
      challengeId: signedIn.challengeId,
      signedTransactionXdr: signedIn.signedTransactionXdr,
    });
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe("CONFLICT");
  });

  it("rejects a challenge signed by a different wallet", async () => {
    const app = createApp();
    const owner = Keypair.random();
    const attacker = Keypair.random();
    const challenge = await request(app)
      .post("/api/auth/sep10/challenge")
      .send({ account: owner.publicKey() });
    const tx = TransactionBuilder.fromXDR(
      challenge.body.transactionXdr,
      challenge.body.networkPassphrase,
    );
    tx.sign(attacker);
    const verify = await request(app).post("/api/auth/sep10/verify").send({
      challengeId: challenge.body.challengeId,
      signedTransactionXdr: tx.toXDR(),
    });
    expect(verify.status).toBe(401);
    expect(verify.body.error.code).toBe("AUTH");
  });
});

describe("Phase 1 KYC/KYB acceptance flow", () => {
  it("approves the sandbox happy path and creates a verified profile", async () => {
    const app = createApp();
    const { token } = await walletSignIn(app);
    const submitted = await request(app)
      .post("/api/kyc/applications")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "kyc-happy-path-0001")
      .send(application());
    expect(submitted.status).toBe(201);
    expect(submitted.body.status).toBe("verified");
    expect(submitted.body.advisory.explanation).toBeTruthy();
    expect(submitted.body.reviewId).toBeNull();

    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);
    expect(me.body.user.kycStatus).toBe("verified");
    expect(me.body.user.email).toBe("applicant@example.test");
  });

  it("routes borderline provider evidence to human review and audit resolution", async () => {
    const app = createApp();
    const { token } = await walletSignIn(app);
    const submitted = await request(app)
      .post("/api/kyc/applications")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "kyc-review-path-0001")
      .send(
        application({
          document: {
            kind: "passport",
            issuingCountry: "US",
            number: "REVIEW-123456",
            expiryDate: "2099-01-01",
            frontImageRef: "sandbox://document/review",
          },
        }),
      );
    expect(submitted.status).toBe(201);
    expect(submitted.body.status).toBe("under_review");
    expect(submitted.body.reviewId).toBeTruthy();

    const queue = await request(app)
      .get("/api/kyc/reviews")
      .set("Authorization", "Bearer dev-local-token");
    expect(queue.status).toBe(200);
    expect(queue.body.reviews).toHaveLength(1);

    const resolved = await request(app)
      .post(`/api/kyc/reviews/${submitted.body.reviewId}/decision`)
      .set("Authorization", "Bearer dev-local-token")
      .set("Idempotency-Key", "kyc-review-decision-0001")
      .send({ decision: "approve", reason: "Documents manually verified" });
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe("resolved");
    expect(resolved.body.resolution).toBe("approve");

    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);
    expect(me.body.user.kycStatus).toBe("verified");
  });

  it("creates a verified business profile for a passing KYB application", async () => {
    const app = createApp();
    const { token } = await walletSignIn(app);
    const submitted = await request(app)
      .post("/api/kyc/applications")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "kyb-happy-path-0001")
      .send(
        application({
          applicantType: "business",
          businessName: "Sandbox Exports Ltd",
          registrationNumber: "REG-10001",
          dateOfBirth: undefined,
        }),
      );
    expect(submitted.status).toBe(201);
    expect(submitted.body.status).toBe("verified");

    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);
    expect(me.body.business.legalName).toBe("Sandbox Exports Ltd");
    expect(me.body.user.kycStatus).toBe("verified");
  });
});
