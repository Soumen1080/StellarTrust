import { describe, expect, it } from "vitest";
import { InMemoryAuditRepository } from "../audit/audit.repository.js";
import { InMemoryReputationRepository, computeScore } from "./reputation.repository.js";
import { ReputationService } from "./reputation.service.js";

function setup() {
  const repository = new InMemoryReputationRepository();
  const audit = new InMemoryAuditRepository();
  const service = new ReputationService(repository, audit);
  return { repository, audit, service };
}

describe("Phase 6 reputation store", () => {
  it("returns a neutral score for a user with no history", async () => {
    const { service } = setup();
    expect(await service.getScore("nobody")).toBe(0.5);
    const dto = await service.getReputation("nobody");
    expect(dto.score).toBe(0.5);
    expect(dto.ordersCompleted).toBe(0);
  });

  it("raises the score as orders complete", async () => {
    const { service } = setup();
    const before = await service.getScore("u1");
    await service.recordOrderCompleted("u1");
    await service.recordOrderCompleted("u1");
    await service.recordOrderCompleted("u1");
    const after = await service.getScore("u1");
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThanOrEqual(1);
  });

  it("moves winner up and loser down on a dispute outcome", async () => {
    const { service } = setup();
    await service.recordDisputeOutcome({
      winnerUserId: "winner",
      loserUserId: "loser",
      disputeId: "d1",
    });
    const winner = await service.getScore("winner");
    const loser = await service.getScore("loser");
    expect(winner).toBeGreaterThan(0.5);
    expect(loser).toBeLessThan(0.5);
  });

  it("audits every reputation update", async () => {
    const { service, audit } = setup();
    await service.recordOrderCompleted("u1");
    const events = await audit.listForEntity("reputation", "u1");
    expect(events.map((e) => e.action)).toContain("reputation.order_completed");
  });

  it("computes a bounded, smoothed score", () => {
    // Pure positives should trend up but stay <= 1 with smoothing.
    const score = computeScore({
      userId: "x",
      ordersCompleted: 10,
      disputesWon: 0,
      disputesLost: 0,
      updatedAt: new Date().toISOString(),
    });
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThanOrEqual(1);
  });
});
