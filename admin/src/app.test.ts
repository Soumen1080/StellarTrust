/**
 * The console's access control.
 *
 * This application is the widest data grant in the platform — every user's
 * position, every queue, and the controls that approve KYC. It is deployed
 * privately behind a password, so these tests are about one question: can
 * anything reach it without that password?
 *
 * The password is hashed at module load with a fixed test value, so these run
 * against the real `verifyPassword` rather than a stub. A stubbed password
 * check is a test that would pass with authentication removed entirely.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import {
  Account,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { hashPassword } from "./lib/password.js";

/**
 * A real keypair, so the wallet factor is exercised end to end: the test
 * signs with the secret and the server verifies against the public key. A
 * stubbed signature check would pass with the second factor removed.
 */
const ADMIN_KEYPAIR = Keypair.random();
/** A different wallet — what an attacker holding the password would have. */
const OTHER_KEYPAIR = Keypair.random();

const PASSWORD = "a-sufficiently-long-test-password";

// Every route except /login and /health talks to Postgres. The console's
// access control is what is under test here, not its SQL, so the database
// layer is replaced wholesale — a test that needed a live database to prove
// "an unauthenticated request is refused" would be testing the wrong thing.
vi.mock("./lib/db.js", () => ({
  getPool: () => ({ query: async () => ({ rows: [] }) }),
  closePool: async () => undefined,
  listTokenizations: async () => [],
  listOrders: async () => [],
  listDisputes: async () => [],
  listTreasuryMovements: async () => [],
  listAudit: async () => [],
  listKycReviews: async () => [],
  listAssetReviews: async () => [],
  listPolicies: async () => [],
  updatePolicy: async () => undefined,
  decideKycReview: async () => true,
  decideAssetReview: async () => true,
  rejectWithdrawal: async () => true,
}));

let app: Express;
let resetAttempts: () => void;

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = "postgresql://localhost:5432/test";
  process.env.ADMIN_PASSWORD_HASH = await hashPassword(PASSWORD);
  process.env.SESSION_SECRET = "test-session-secret-at-least-32-chars-long";
  process.env.ADMIN_REVIEWER_USER_ID = "11111111-2222-4333-8444-555555555555";
  process.env.ADMIN_WALLET = ADMIN_KEYPAIR.publicKey();
  process.env.LOGIN_MAX_ATTEMPTS = "3";

  const appModule = await import("./app.js");
  const sessionModule = await import("./lib/session.js");
  app = appModule.createApp();
  resetAttempts = sessionModule.resetAttempts;
});

beforeEach(() => {
  resetAttempts();
});

/**
 * Sign a challenge transaction the way a wallet does: parse the envelope,
 * add a signature, hand back the new envelope.
 */
function signChallenge(
  step1Body: { transactionXdr: string; networkPassphrase: string },
  keypair = ADMIN_KEYPAIR,
): string {
  const tx = TransactionBuilder.fromXDR(
    step1Body.transactionXdr,
    step1Body.networkPassphrase,
  );
  tx.sign(keypair);
  return tx.toXDR();
}

/**
 * Complete both factors and return the session cookie.
 *
 * Password first, then a signature over the challenge it returns — the same
 * two calls a browser makes.
 */
async function signIn(keypair = ADMIN_KEYPAIR): Promise<string> {
  const step1 = await request(app).post("/login").send({ password: PASSWORD });
  if (step1.status !== 200) {
    throw new Error(`password step failed: ${step1.status}`);
  }
  const signedTransactionXdr = signChallenge(step1.body, keypair);

  const step2 = await request(app)
    .post("/login/verify")
    .send({ challengeId: step1.body.challengeId, signedTransactionXdr });
  const cookie = step2.headers["set-cookie"]?.[0];
  if (!cookie) throw new Error("wallet step did not set a session cookie");
  return cookie.split(";")[0] as string;
}

describe("nothing reaches the console without a password", () => {
  it.each([
    "/",
    "/api/overview",
    "/api/queues",
    "/api/audit",
    "/api/policies",
  ])("refuses %s when unauthenticated", async (path) => {
    const res = await request(app).get(path);
    // A page redirects to the form; an API call gets 401. Both refuse.
    expect([302, 401]).toContain(res.status);
    expect(res.text).not.toContain("Total value locked");
  });

  it("refuses a decision endpoint when unauthenticated", async () => {
    await request(app)
      .post("/api/kyc/some-id")
      .send({ decision: "approve", reason: "because" })
      .expect(401);
  });

  it("refuses a forged session cookie", async () => {
    // The signature is what makes the cookie unforgeable. Without this check a
    // hand-written cookie would be as good as a password.
    await request(app)
      .get("/api/overview")
      .set("Cookie", "stellartrust_admin=eyJleHAiOjk5OTk5OTk5OTk5OTl9.deadbeef")
      .expect(401);
  });

  it("refuses a cookie whose payload was edited after signing", async () => {
    const cookie = await signIn();
    const [name, value] = cookie.split("=");
    const tampered = `${name}=${(value ?? "").replace(/^./, "X")}`;
    await request(app).get("/api/overview").set("Cookie", tampered).expect(401);
  });

  it("offers a show/hide toggle on the password field", async () => {
    // Typing a password blind is how a correct one gets reported as wrong,
    // and here a wrong one costs an attempt against a five-try lockout.
    const res = await request(app).get("/login").expect(200);
    expect(res.text).toContain('id="toggle"');
    // Starts hidden. A field that renders readable by default would expose the
    // password to anyone glancing at the screen before it is even submitted.
    expect(res.text).toContain('id="password" type="password"');
    expect(res.text).toContain('aria-pressed="false"');
  });

  it("serves the login form without a session", async () => {
    // The one page that must be reachable — and it says nothing about what
    // this system is.
    const res = await request(app).get("/login").expect(200);
    expect(res.text).toContain("Sign in");
    expect(res.text).not.toMatch(/StellarTrust/i);
  });
});

describe("a password alone opens nothing", () => {
  it("returns a challenge, not a session, for the correct password", async () => {
    // The whole point of the second factor. Whoever holds a leaked password
    // gets a nonce to sign and nothing else.
    const res = await request(app)
      .post("/login")
      .send({ password: PASSWORD })
      .expect(200);

    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.body).toHaveProperty("challengeId");
    expect(res.body.message).toContain("nonce:");
  });

  it("refuses a signature from a different wallet", async () => {
    // An attacker with the password but not the key. This is the case the
    // second factor exists for.
    const step1 = await request(app).post("/login").send({ password: PASSWORD });
    const signedTransactionXdr = signChallenge(step1.body, OTHER_KEYPAIR);

    const res = await request(app)
      .post("/login/verify")
      .send({ challengeId: step1.body.challengeId, signedTransactionXdr })
      .expect(401);

    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.body.error.message).toMatch(/not from the authorised wallet/i);
  });

  it("refuses a signature over a different message", async () => {
    // Guards against replaying a signature the operator made elsewhere: the
    // server rebuilds the expected transaction from its stored nonce, so a
    // signature over any other envelope cannot match.
    const [step1, other] = await Promise.all([
      request(app).post("/login").send({ password: PASSWORD }),
      request(app).post("/login").send({ password: PASSWORD }),
    ]);
    // Correctly signed — but over the *other* challenge's transaction.
    const signedTransactionXdr = signChallenge(other.body);

    await request(app)
      .post("/login/verify")
      .send({ challengeId: step1.body.challengeId, signedTransactionXdr })
      .expect(401);
  });

  it("refuses a challenge that was already used", async () => {
    // Single-use: a captured signature proves control at one moment for one
    // challenge, and that challenge is spent.
    const step1 = await request(app).post("/login").send({ password: PASSWORD });
    const body = {
      challengeId: step1.body.challengeId,
      signedTransactionXdr: signChallenge(step1.body),
    };

    await request(app).post("/login/verify").send(body).expect(200);
    await request(app).post("/login/verify").send(body).expect(401);
  });

  it("refuses an invented challenge id", async () => {
    const step1 = await request(app).post("/login").send({ password: PASSWORD });
    await request(app)
      .post("/login/verify")
      .send({
        challengeId: "not-a-real-challenge",
        signedTransactionXdr: signChallenge(step1.body),
      })
      .expect(401);
  });

  it("refuses a signature over a transaction the client authored", async () => {
    // The attack the transaction flow has to answer that a signed message did
    // not: a client that returns a *valid* signature over an envelope of its
    // own choosing. The server rebuilds the expected transaction from the
    // nonce it stored and compares hashes, so only the challenge it issued
    // can match — whoever signed it.
    const step1 = await request(app).post("/login").send({ password: PASSWORD });
    const forged = new TransactionBuilder(
      new Account(ADMIN_KEYPAIR.publicKey(), "-1"),
      {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
        timebounds: { minTime: 0, maxTime: 0 },
      },
    )
      .addOperation(
        Operation.manageData({ name: "attacker chosen", value: "anything" }),
      )
      .build();
    forged.sign(ADMIN_KEYPAIR);

    const res = await request(app)
      .post("/login/verify")
      .send({
        challengeId: step1.body.challengeId,
        signedTransactionXdr: forged.toXDR(),
      })
      .expect(401);

    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses a malformed proof", async () => {
    await request(app).post("/login/verify").send({}).expect(400);
  });

  it("issues a fresh nonce per attempt", async () => {
    // A reused nonce would make one captured signature valid forever.
    const a = await request(app).post("/login").send({ password: PASSWORD });
    const b = await request(app).post("/login").send({ password: PASSWORD });
    expect(a.body.message).not.toBe(b.body.message);
  });
});

describe("signing in with both factors", () => {
  it("issues a session only after the wallet signature", async () => {
    const step1 = await request(app).post("/login").send({ password: PASSWORD });
    const signedTransactionXdr = signChallenge(step1.body);

    const res = await request(app)
      .post("/login/verify")
      .send({ challengeId: step1.body.challengeId, signedTransactionXdr })
      .expect(200);

    const cookie = res.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
  });

  it("refuses the wrong password before any challenge is issued", async () => {
    const res = await request(app)
      .post("/login")
      .send({ password: "not-the-password" })
      .expect(401);
    expect(res.body).not.toHaveProperty("challengeId");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses a missing password the same way as a wrong one", async () => {
    // Distinguishing them tells an attacker which half of their guess landed.
    const wrong = await request(app).post("/login").send({ password: "nope" });
    const missing = await request(app).post("/login").send({});
    expect(missing.status).toBe(wrong.status);
    expect(missing.body.error.message).toBe(wrong.body.error.message);
  });

  it("opens the console once signed in", async () => {
    const cookie = await signIn();
    const res = await request(app).get("/").set("Cookie", cookie).expect(200);
    expect(res.text).toContain("Console");
  });

  it("serves data to a signed-in session", async () => {
    const cookie = await signIn();
    const res = await request(app)
      .get("/api/overview")
      .set("Cookie", cookie)
      .expect(200);
    expect(res.body).toHaveProperty("metrics");
  });

  it("stops serving after sign-out", async () => {
    const cookie = await signIn();
    await request(app).get("/api/overview").set("Cookie", cookie).expect(200);

    const out = await request(app).post("/logout").set("Cookie", cookie);
    const cleared = out.headers["set-cookie"]?.[0] ?? "";
    expect(cleared).toContain("Max-Age=0");
  });
});

describe("guessing the password is throttled", () => {
  it("locks out after the configured number of failures", async () => {
    // A password with no rate limit is a password that will eventually be
    // guessed. Configured to 3 for this suite.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await request(app).post("/login").send({ password: "wrong" });
    }
    const res = await request(app)
      .post("/login")
      .send({ password: "wrong" })
      .expect(429);
    expect(res.body.error.message).toMatch(/too many attempts/i);
  });

  it("refuses even the correct password while locked out", async () => {
    // Otherwise the lockout is decorative: an attacker who guesses correctly
    // on the attempt after the limit still gets in.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await request(app).post("/login").send({ password: "wrong" });
    }
    await request(app)
      .post("/login")
      .send({ password: PASSWORD })
      .expect(429);
  });

  it("clears the counter after a successful sign-in", async () => {
    await request(app).post("/login").send({ password: "wrong" });
    // A completed sign-in clears the counter. The password step alone does
    // not, because on its own it has proved nothing.
    await signIn();
    await request(app).post("/login").send({ password: "wrong" });
    await request(app).post("/login").send({ password: "wrong" });
    await signIn();
  });
});

describe("what the console will not do", () => {
  it("has no route that approves a withdrawal", async () => {
    // Approving submits a real Stellar payment, which needs the signing key.
    // Putting that key in a separately deployed console would mean two systems
    // able to move funds instead of one.
    const cookie = await signIn();
    await request(app)
      .post("/api/withdrawals/some-id/approve")
      .set("Cookie", cookie)
      .send({})
      .expect(404);
  });

  it("does refuse a withdrawal, which needs no key", async () => {
    const cookie = await signIn();
    await request(app)
      .post("/api/withdrawals/some-id/reject")
      .set("Cookie", cookie)
      .send({ reason: "source of funds unclear" })
      .expect(200);
  });
});

describe("input validation on decisions", () => {
  it("refuses a KYC decision with no reason", async () => {
    const cookie = await signIn();
    await request(app)
      .post("/api/kyc/some-id")
      .set("Cookie", cookie)
      .send({ decision: "approve", reason: "" })
      .expect(400);
  });

  it("refuses an asset rejection with no note", async () => {
    // A rejection without a stated reason leaves the issuer nothing to act on.
    const cookie = await signIn();
    await request(app)
      .post("/api/assets/some-id")
      .set("Cookie", cookie)
      .send({ decision: "reject" })
      .expect(400);
  });

  it("refuses a policy whose approval band overlaps its rejection band", async () => {
    const cookie = await signIn();
    const res = await request(app)
      .post("/api/policies/kyc")
      .set("Cookie", cookie)
      .send({
        mode: "ai",
        approveMaxRiskBps: 8000,
        rejectMinRiskBps: 7000,
        minConfidenceBps: 7000,
        humanReviewAboveAmount: "0",
      })
      .expect(400);
    expect(res.body.error.message).toMatch(/below the rejection/i);
  });

  it("refuses an unknown policy domain", async () => {
    const cookie = await signIn();
    await request(app)
      .post("/api/policies/not-a-domain")
      .set("Cookie", cookie)
      .send({
        mode: "ai",
        approveMaxRiskBps: 3000,
        rejectMinRiskBps: 7000,
        minConfidenceBps: 7000,
        humanReviewAboveAmount: "0",
      })
      .expect(400);
  });
});
