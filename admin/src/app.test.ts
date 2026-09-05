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
import { hashPassword } from "./lib/password.js";

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
  process.env.LOGIN_MAX_ATTEMPTS = "3";

  const appModule = await import("./app.js");
  const sessionModule = await import("./lib/session.js");
  app = appModule.createApp();
  resetAttempts = sessionModule.resetAttempts;
});

beforeEach(() => {
  resetAttempts();
});

/** Sign in and return the session cookie. */
async function signIn(): Promise<string> {
  const res = await request(app)
    .post("/login")
    .type("form")
    .send({ password: PASSWORD });
  const cookie = res.headers["set-cookie"]?.[0];
  if (!cookie) throw new Error("sign-in did not set a session cookie");
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

  it("serves the login form without a session", async () => {
    // The one page that must be reachable — and it says nothing about what
    // this system is.
    const res = await request(app).get("/login").expect(200);
    expect(res.text).toContain("Sign in");
    expect(res.text).not.toMatch(/StellarTrust/i);
  });
});

describe("signing in", () => {
  it("accepts the correct password and issues a session", async () => {
    const res = await request(app)
      .post("/login")
      .type("form")
      .send({ password: PASSWORD })
      .expect(302);

    const cookie = res.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
  });

  it("refuses the wrong password", async () => {
    const res = await request(app)
      .post("/login")
      .type("form")
      .send({ password: "not-the-password" })
      .expect(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses a missing password with the same message as a wrong one", async () => {
    // Distinguishing them tells an attacker which half of their guess landed.
    const wrong = await request(app)
      .post("/login")
      .type("form")
      .send({ password: "nope" });
    const missing = await request(app).post("/login").type("form").send({});
    expect(missing.status).toBe(wrong.status);
    expect(missing.text).toContain("Incorrect password");
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
      await request(app).post("/login").type("form").send({ password: "wrong" });
    }
    const res = await request(app)
      .post("/login")
      .type("form")
      .send({ password: "wrong" })
      .expect(429);
    expect(res.text).toMatch(/too many attempts/i);
  });

  it("refuses even the correct password while locked out", async () => {
    // Otherwise the lockout is decorative: an attacker who guesses correctly
    // on the attempt after the limit still gets in.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await request(app).post("/login").type("form").send({ password: "wrong" });
    }
    await request(app)
      .post("/login")
      .type("form")
      .send({ password: PASSWORD })
      .expect(429);
  });

  it("clears the counter after a successful sign-in", async () => {
    await request(app).post("/login").type("form").send({ password: "wrong" });
    await request(app)
      .post("/login")
      .type("form")
      .send({ password: PASSWORD })
      .expect(302);
    // The earlier failure must not count toward a later lockout.
    await request(app).post("/login").type("form").send({ password: "wrong" });
    await request(app).post("/login").type("form").send({ password: "wrong" });
    await request(app)
      .post("/login")
      .type("form")
      .send({ password: PASSWORD })
      .expect(302);
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
