import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";

const app = createApp();

const WALLET = "GCD32N3MW23NYDOYNQ4OX5STW6COAQX3M5PN3BVV36SVHMUCKENRJW7I";
const EMAIL = "reviewer@example.com";

const submission = {
  name: "Priya R",
  email: EMAIL,
  walletAddress: WALLET,
  message: "Locked and released a testnet order without touching the CLI once.",
  rating: 5,
};

describe("feedback wall route boundary", () => {
  it("serves GET /api/feedback with no session at all", async () => {
    const res = await request(app).get("/api/feedback");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.feedback)).toBe(true);
    expect(res.body.summary).toMatchObject({ total: expect.any(Number) });
  });

  it("rejects an unauthenticated POST", async () => {
    const res = await request(app).post("/api/feedback").send(submission);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH");
  });

  it("accepts a submission and publishes it without the contact details", async () => {
    const created = await request(app)
      .post("/api/feedback")
      .set("Authorization", "Bearer dev-local-token")
      .send(submission);
    expect(created.status).toBe(201);
    expect(created.body.feedback).toMatchObject({
      name: "Priya R",
      rating: 5,
    });

    // The response to the author does not echo them back...
    expect(JSON.stringify(created.body)).not.toContain(EMAIL);
    expect(JSON.stringify(created.body)).not.toContain(WALLET);

    // ...and neither does the public wall, which needs no token to read.
    const wall = await request(app).get("/api/feedback");
    expect(wall.status).toBe(200);
    const entry = wall.body.feedback.find(
      (item: { id: string }) => item.id === created.body.feedback.id,
    );
    expect(entry).toBeDefined();
    expect(Object.keys(entry).sort()).toEqual([
      "createdAt",
      "id",
      "message",
      "name",
      "rating",
    ]);
    expect(JSON.stringify(wall.body)).not.toContain(EMAIL);
    expect(JSON.stringify(wall.body)).not.toContain(WALLET);
    expect(wall.body.summary.total).toBeGreaterThan(0);
    expect(wall.body.summary.averageRating).not.toBeNull();
  });

  it("allows only one entry per account", async () => {
    // The dev bearer resolves to a single userId, so this is the same author
    // as the submission above.
    const res = await request(app)
      .post("/api/feedback")
      .set("Authorization", "Bearer dev-local-token")
      .send({ ...submission, message: "A second opinion from one account." });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });

  it("rejects a rating outside 1..5", async () => {
    const res = await request(app)
      .post("/api/feedback")
      .set("Authorization", "Bearer dev-local-token")
      .send({ ...submission, rating: 9 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION");
  });
});
