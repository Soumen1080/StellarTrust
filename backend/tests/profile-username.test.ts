/**
 * The username claim, end to end.
 *
 * The rule under test is that a handle is writable exactly once and unique
 * across accounts. It guards a display value that appears against settled
 * transactions, so "already taken" and "already set" must both be refusals
 * rather than silent overwrites.
 */
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
  return { wallet, token: verify.body.accessToken as string };
}

describe("usernames", () => {
  it("gives every new account a handle without being asked", async () => {
    const app = createApp();
    const { token } = await walletSignIn(app);

    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(me.status).toBe(200);
    expect(me.body.user.username).toMatch(/^[a-z0-9_]{3,20}$/);
    // Not yet claimed, so the one edit is still available.
    expect(me.body.user.usernameSetAt).toBeUndefined();
  });

  it("lets a user claim a handle once", async () => {
    const app = createApp();
    const { token } = await walletSignIn(app);

    const claim = await request(app)
      .patch("/api/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ username: "ada_lovelace" });

    expect(claim.status).toBe(200);
    expect(claim.body.user.username).toBe("ada_lovelace");
    expect(claim.body.user.usernameSetAt).toBeDefined();
  });

  it("refuses a second claim, because history already shows the first", async () => {
    const app = createApp();
    const { token } = await walletSignIn(app);

    await request(app)
      .patch("/api/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ username: "first_choice" })
      .expect(200);

    const second = await request(app)
      .patch("/api/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ username: "second_choice" });

    expect(second.status).toBe(409);

    // The original must survive the rejected attempt.
    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);
    expect(me.body.user.username).toBe("first_choice");
  });

  it("refuses a handle another account already holds", async () => {
    const app = createApp();
    const first = await walletSignIn(app);
    const second = await walletSignIn(app);

    await request(app)
      .patch("/api/auth/me")
      .set("Authorization", `Bearer ${first.token}`)
      .send({ username: "taken_name" })
      .expect(200);

    const clash = await request(app)
      .patch("/api/auth/me")
      .set("Authorization", `Bearer ${second.token}`)
      .send({ username: "taken_name" });

    expect(clash.status).toBe(409);
  });

  it("treats a handle as the same name in any case", async () => {
    const app = createApp();
    const first = await walletSignIn(app);
    const second = await walletSignIn(app);

    await request(app)
      .patch("/api/auth/me")
      .set("Authorization", `Bearer ${first.token}`)
      .send({ username: "casefold" })
      .expect(200);

    // Folded to lower case before the uniqueness check, so this is a clash and
    // not a second, visually-identical account.
    const clash = await request(app)
      .patch("/api/auth/me")
      .set("Authorization", `Bearer ${second.token}`)
      .send({ username: "CaseFold" });

    expect(clash.status).toBe(409);
  });

  it("stores a mixed-case claim folded", async () => {
    const app = createApp();
    const { token } = await walletSignIn(app);

    const claim = await request(app)
      .patch("/api/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ username: "MixedCase" });

    expect(claim.status).toBe(200);
    expect(claim.body.user.username).toBe("mixedcase");
  });

  it.each([
    ["too short", "ab"],
    ["too long", "a".repeat(21)],
    ["a space", "has space"],
    ["punctuation", "no-hyphens"],
    ["reserved", "support"],
  ])("rejects a handle that is %s", async (_label, username) => {
    const app = createApp();
    const { token } = await walletSignIn(app);

    const claim = await request(app)
      .patch("/api/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ username });

    expect(claim.status).toBe(400);
  });

  it("requires a session", async () => {
    const app = createApp();
    const claim = await request(app)
      .patch("/api/auth/me")
      .send({ username: "anonymous_x" });

    expect(claim.status).toBe(401);
  });
});
