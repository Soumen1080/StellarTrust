import { describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "../../lib/errors.js";
import { InMemoryAuditRepository } from "../audit/audit.repository.js";
import { InMemoryFeedbackRepository } from "./feedback.repository.js";
import { FeedbackService } from "./feedback.service.js";

const WALLET = "GCD32N3MW23NYDOYNQ4OX5STW6COAQX3M5PN3BVV36SVHMUCKENRJW7I";

function setup() {
  const repository = new InMemoryFeedbackRepository();
  const audit = new InMemoryAuditRepository();
  const service = new FeedbackService(repository, audit);
  return { repository, audit, service };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    name: "Ada Lovelace",
    email: "ada@example.com",
    walletAddress: WALLET,
    message: "Escrow release was instant and the fee preview matched exactly.",
    rating: 5,
    ...overrides,
  };
}

describe("Phase 6 product feedback", () => {
  it("publishes the name, message and rating", async () => {
    const { service } = setup();
    await service.submit("u1", input());

    const { feedback } = await service.listPublic();
    expect(feedback).toHaveLength(1);
    expect(feedback[0]).toMatchObject({
      name: "Ada Lovelace",
      message: expect.stringContaining("Escrow release"),
      rating: 5,
    });
  });

  it("never returns the email or wallet address", async () => {
    const { service, repository } = setup();
    const created = await service.submit("u1", input());

    // Stored, so the team can reach the author...
    const stored = await repository.findByUser("u1");
    expect(stored?.email).toBe("ada@example.com");
    expect(stored?.walletAddress).toBe(WALLET);

    // ...and absent from every shape a route can return. Checked as raw JSON
    // because the DTO type alone would hide an extra runtime property.
    const { feedback } = await service.listPublic();
    const published = JSON.stringify({ created, feedback });
    expect(published).not.toContain("ada@example.com");
    expect(published).not.toContain(WALLET);
    expect(Object.keys(feedback[0]!).sort()).toEqual([
      "createdAt",
      "id",
      "message",
      "name",
      "rating",
    ]);
  });

  it("keeps the email and wallet out of the audit trail too", async () => {
    const { service, audit } = setup();
    await service.submit("u1", input());
    const events = await audit.listForEntity("feedback", (await service.findMine("u1"))!.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("feedback.submitted");
    expect(JSON.stringify(events[0])).not.toContain("ada@example.com");
    expect(JSON.stringify(events[0])).not.toContain(WALLET);
  });

  it("summarizes the ratings, with every star present", async () => {
    const { service } = setup();
    await service.submit("u1", input({ rating: 5 }));
    await service.submit("u2", input({ rating: 4 }));

    const { summary } = await service.listPublic();
    expect(summary.total).toBe(2);
    expect(summary.averageRating).toBe(4.5);
    expect(summary.distribution).toEqual({
      "1": 0,
      "2": 0,
      "3": 0,
      "4": 1,
      "5": 1,
    });
  });

  it("reports a null average rather than NaN when there is no feedback", async () => {
    const { service } = setup();
    const { summary } = await service.listPublic();
    expect(summary.total).toBe(0);
    expect(summary.averageRating).toBeNull();
  });

  it("allows one entry per account", async () => {
    const { service } = setup();
    await service.submit("u1", input());
    await expect(service.submit("u1", input())).rejects.toBeInstanceOf(
      ConflictError,
    );
    // A different account is unaffected.
    await expect(service.submit("u2", input())).resolves.toBeDefined();
  });

  it("rejects a rating outside 1..5, a bad wallet, and a bad email", async () => {
    const { service } = setup();
    for (const bad of [
      input({ rating: 0 }),
      input({ rating: 6 }),
      input({ rating: 4.5 }),
      input({ walletAddress: "not-a-stellar-account" }),
      input({ email: "nope" }),
      input({ message: "too short" }),
      input({ name: "A" }),
    ]) {
      await expect(service.submit("fresh-user", bad)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
  });

  it("lists newest first", async () => {
    const { service, repository } = setup();
    await repository.save({
      id: "old",
      userId: "u1",
      name: "Older",
      message: "The first note anybody left on this wall.",
      rating: 3,
      email: "a@example.com",
      walletAddress: WALLET,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await repository.save({
      id: "new",
      userId: "u2",
      name: "Newer",
      message: "The second note anybody left on this wall.",
      rating: 4,
      email: "b@example.com",
      walletAddress: WALLET,
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    const { feedback } = await service.listPublic();
    expect(feedback.map((entry) => entry.name)).toEqual(["Newer", "Older"]);
  });
});
