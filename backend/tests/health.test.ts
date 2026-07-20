import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";

const app = createApp();

describe("end-to-end health", () => {
  it("GET /health returns ok (the CI empty end-to-end request)", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.service).toBe("stellartrust-backend");
  });

  it("unknown route returns the standard API error shape", async () => {
    const res = await request(app).get("/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(res.body.error.requestId).toBeTruthy();
  });
});

describe("ledger route auth + idempotency + balancing", () => {
  const balanced = {
    referenceId: "ref-e2e-1",
    description: "e2e balanced deposit",
    entries: [
      {
        accountId: "11111111-1111-1111-1111-111111111111",
        direction: "debit",
        amount: "10000",
        currency: "USD",
      },
      {
        accountId: "22222222-2222-2222-2222-222222222222",
        direction: "credit",
        amount: "10000",
        currency: "USD",
      },
    ],
  };

  it("rejects unauthenticated POST /api/ledger/transactions", async () => {
    const res = await request(app)
      .post("/api/ledger/transactions")
      .set("Idempotency-Key", "key-unauth-123456")
      .send(balanced);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH");
  });

  it("requires an Idempotency-Key", async () => {
    const res = await request(app)
      .post("/api/ledger/transactions")
      .set("Authorization", "Bearer dev-local-token")
      .send(balanced);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION");
  });

  it("records a balanced transaction and replays on retry with same key", async () => {
    const key = "key-balanced-abcdef";
    const first = await request(app)
      .post("/api/ledger/transactions")
      .set("Authorization", "Bearer dev-local-token")
      .set("Idempotency-Key", key)
      .send(balanced);
    expect(first.status).toBe(201);
    expect(first.body.id).toBeTruthy();

    // Same key + same body → replayed response, no double-post.
    const retry = await request(app)
      .post("/api/ledger/transactions")
      .set("Authorization", "Bearer dev-local-token")
      .set("Idempotency-Key", key)
      .send(balanced);
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);
  });

  it("rejects an unbalanced transaction with a LEDGER error", async () => {
    const res = await request(app)
      .post("/api/ledger/transactions")
      .set("Authorization", "Bearer dev-local-token")
      .set("Idempotency-Key", "key-unbalanced-123456")
      .send({
        referenceId: "ref-e2e-unbalanced",
        description: "bad",
        entries: [
          { ...balanced.entries[0] },
          { ...balanced.entries[1], amount: "9999" },
        ],
      });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("LEDGER");
  });
});



describe("Phase 2 payment route auth + idempotency", () => {
  const input = {
    sellerId: "seller-e2e",
    amount: { amount: "2500", currency: "USDC" },
  };

  it("protects order creation and replays the same mutation once", async () => {
    const unauthenticated = await request(app)
      .post("/api/payments/orders")
      .set("Idempotency-Key", "phase2-unauth-key")
      .send(input);
    expect(unauthenticated.status).toBe(401);

    const key = "phase2-order-create-key";
    const first = await request(app)
      .post("/api/payments/orders")
      .set("Authorization", "Bearer dev-local-token")
      .set("Idempotency-Key", key)
      .send(input);
    expect(first.status).toBe(201);
    expect(first.body.order.status).toBe("created");
    expect(first.body.transition.ledgerTransaction.entries).toHaveLength(2);
    expect(first.body.transition.stellarTransaction.ledgerTransactionId).toBe(
      first.body.transition.ledgerTransaction.id,
    );

    const replay = await request(app)
      .post("/api/payments/orders")
      .set("Authorization", "Bearer dev-local-token")
      .set("Idempotency-Key", key)
      .send(input);
    expect(replay.status).toBe(201);
    expect(replay.body.order.id).toBe(first.body.order.id);
    expect(replay.body.transition.id).toBe(first.body.transition.id);
  });
});
