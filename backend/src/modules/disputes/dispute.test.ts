import { randomUUID } from "node:crypto";
import {
  DisputeDecisionMaker,
  DisputeResolution,
  DisputeStatus,
  type CurrencyCode,
  type OrderDTO,
} from "@stellartrust/shared";
import { describe, expect, it } from "vitest";
import { InMemoryAuditRepository } from "../audit/audit.repository.js";
import { DeterministicDisputeRiskClient } from "./dispute-risk.client.js";
import {
  InMemoryDisputeRepository,
  type DisputeOrderGateway,
} from "./dispute.repository.js";
import { DisputeService } from "./dispute.service.js";

const buyer = { userId: "buyer-1", roles: ["user"] };
const seller = { userId: "seller-1", roles: ["user"] };
const compliance = { userId: "reviewer-1", roles: ["user", "compliance"] };

function makeOrder(amount: string, currency: CurrencyCode = "USD"): OrderDTO {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    buyerId: buyer.userId,
    sellerId: seller.userId,
    amount: { amount, currency },
    status: "locked",
    createdAt: now,
    updatedAt: now,
  };
}

function setup(order: OrderDTO) {
  const repository = new InMemoryDisputeRepository();
  const audit = new InMemoryAuditRepository();
  const orders: DisputeOrderGateway = {
    getOrder: async (orderId) => (orderId === order.id ? order : undefined),
    // These cases exercise the advisory/decision path against orders that
    // never went through the escrow flow, so there is no custody to name.
    getEscrow: async () => undefined,
  };
  const service = new DisputeService(
    repository,
    orders,
    new DeterministicDisputeRiskClient(),
    audit,
  );
  return { repository, audit, service, order };
}

const releaseEvidence = (weight: number) => ({
  kind: "tracking" as const,
  supports: DisputeResolution.Release,
  weight,
  reference: "storage://evidence/tracking-1",
});
const refundEvidence = (weight: number) => ({
  kind: "invoice" as const,
  supports: DisputeResolution.Refund,
  weight,
  reference: "storage://evidence/invoice-1",
});

describe("dispute lifecycle and authorization", () => {
  it("lets an order party open a dispute and blocks non-parties", async () => {
    const { service, order } = setup(makeOrder("10000"));
    const dispute = await service.open(buyer, {
      orderId: order.id,
      reason: "Item never arrived",
    });
    expect(dispute.status).toBe(DisputeStatus.EvidenceWindow);
    expect(dispute.evidenceWindowClosesAt > dispute.createdAt).toBe(true);

    await expect(
      service.open(
        { userId: "intruder", roles: ["user"] },
        { orderId: order.id, reason: "not my order" },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects an unknown order and a duplicate open dispute", async () => {
    const { service, order } = setup(makeOrder("10000"));
    await expect(
      service.open(buyer, {
        orderId: "00000000-0000-4000-8000-000000000000",
        reason: "no such order",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await service.open(buyer, { orderId: order.id, reason: "first" });
    await expect(
      service.open(seller, { orderId: order.id, reason: "second" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("AI advisory + human gate", () => {
  it("produces an explainable advisory from submitted evidence", async () => {
    const { service, order } = setup(makeOrder("10000"));
    const opened = await service.open(buyer, { orderId: order.id, reason: "dispute" });
    const updated = await service.submitEvidence(
      seller,
      opened.id,
      releaseEvidence(0.9),
    );
    expect(updated.status).toBe(DisputeStatus.UnderReview);
    expect(updated.advisory).not.toBeNull();
    expect(updated.advisory?.explanation.length).toBeGreaterThan(0);
    expect(updated.advisory?.signals.length).toBeGreaterThan(0);
  });

  it("auto-resolves a low-value, high-confidence, non-conflicting dispute", async () => {
    const { service, audit, order } = setup(makeOrder("10000")); // 100.00 USD
    const opened = await service.open(buyer, { orderId: order.id, reason: "dispute" });
    await service.submitEvidence(seller, opened.id, releaseEvidence(0.95));
    const dispute = await service.submitEvidence(
      seller,
      opened.id,
      releaseEvidence(0.95),
    );
    expect(dispute.autoResolvable).toBe(true);

    const resolved = await service.resolve(buyer, opened.id);
    expect(resolved.status).toBe(DisputeStatus.Resolved);
    expect(resolved.resolution?.decidedBy).toBe(DisputeDecisionMaker.AutoPolicy);
    expect(resolved.resolution?.outcome).toBe(DisputeResolution.Release);

    // Every AI advisory and final decision is audit-logged.
    const events = await audit.listForEntity("dispute", opened.id);
    const actions = events.map((event) => event.action);
    expect(actions).toContain("dispute.opened");
    expect(actions).toContain("dispute.advisory");
    expect(actions).toContain("dispute.resolved");
  });

  it("requires a human decision when evidence conflicts", async () => {
    const { service, order } = setup(makeOrder("10000"));
    const opened = await service.open(buyer, { orderId: order.id, reason: "dispute" });
    await service.submitEvidence(seller, opened.id, releaseEvidence(0.9));
    const dispute = await service.submitEvidence(
      buyer,
      opened.id,
      refundEvidence(0.9),
    );
    expect(dispute.autoResolvable).toBe(false);

    // Auto-resolve is refused; a human must decide.
    await expect(service.resolve(buyer, opened.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // A non-compliance user cannot make the final decision either.
    await expect(
      service.resolve(buyer, opened.id, {
        decision: DisputeResolution.Refund,
        reason: "buyer evidence stronger",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const resolved = await service.resolve(compliance, opened.id, {
      decision: DisputeResolution.Refund,
      reason: "Invoice shows non-delivery; refund the buyer.",
    });
    expect(resolved.resolution?.decidedBy).toBe(DisputeDecisionMaker.Human);
    expect(resolved.resolution?.outcome).toBe(DisputeResolution.Refund);
  });

  it("requires a human decision for a high-value dispute even with strong evidence", async () => {
    // 60,000.00 USD is above AUTO_RESOLVE_MAX_AMOUNT (50000).
    const { service, order } = setup(makeOrder("6000000"));
    const opened = await service.open(buyer, { orderId: order.id, reason: "dispute" });
    await service.submitEvidence(seller, opened.id, releaseEvidence(0.95));
    const dispute = await service.submitEvidence(
      seller,
      opened.id,
      releaseEvidence(0.95),
    );
    expect(dispute.autoResolvable).toBe(false);
    await expect(service.resolve(buyer, opened.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("rejects evidence after the dispute is resolved", async () => {
    const { service, order } = setup(makeOrder("10000"));
    const opened = await service.open(buyer, { orderId: order.id, reason: "dispute" });
    await service.submitEvidence(seller, opened.id, releaseEvidence(0.95));
    await service.submitEvidence(seller, opened.id, releaseEvidence(0.95));
    await service.resolve(buyer, opened.id);
    await expect(
      service.submitEvidence(seller, opened.id, releaseEvidence(0.5)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("both parties can see and answer a claim", () => {
  it("lists the dispute for the seller it was filed against, not just the opener", async () => {
    const { service, order } = setup(makeOrder("10000"));
    const opened = await service.open(buyer, {
      orderId: order.id,
      reason: "Item never arrived",
    });

    // The respondent has to find the claim to defend it inside the window.
    const sellerView = await service.list(seller.userId);
    expect(sellerView.map((dispute) => dispute.id)).toContain(opened.id);

    const buyerView = await service.list(buyer.userId);
    expect(buyerView.map((dispute) => dispute.id)).toContain(opened.id);

    // Someone with no stake in the order still sees nothing.
    expect(await service.list("intruder")).toHaveLength(0);
  });

  it("records both parties on the dispute so the log can name roles", async () => {
    const { service, order } = setup(makeOrder("10000"));
    const opened = await service.open(seller, { orderId: order.id, reason: "dispute" });
    expect(opened.buyerId).toBe(buyer.userId);
    expect(opened.sellerId).toBe(seller.userId);
    expect(opened.openedBy).toBe(seller.userId);
  });

  it("narrows the list to one order, which is how escrow asks about a card", async () => {
    const first = makeOrder("10000");
    const { service } = setup(first);
    const opened = await service.open(buyer, { orderId: first.id, reason: "dispute" });

    expect(await service.list(buyer.userId, first.id)).toHaveLength(1);
    expect(
      (await service.list(buyer.userId, first.id))[0]?.id,
    ).toBe(opened.id);
    expect(
      await service.list(buyer.userId, "00000000-0000-4000-8000-000000000000"),
    ).toHaveLength(0);
  });
});

describe("disputable order states", () => {
  it("refuses a dispute on an order whose funds were never committed", async () => {
    const order = { ...makeOrder("10000"), status: "created" as const };
    const { service } = setup(order);
    await expect(
      service.open(buyer, { orderId: order.id, reason: "too early" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a dispute on an order that already settled", async () => {
    const order = { ...makeOrder("10000"), status: "released" as const };
    const { service } = setup(order);
    await expect(
      service.open(buyer, { orderId: order.id, reason: "too late" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("accepts a dispute once funds are deposited", async () => {
    const order = { ...makeOrder("10000"), status: "deposited" as const };
    const { service } = setup(order);
    const dispute = await service.open(buyer, {
      orderId: order.id,
      reason: "seller unresponsive",
    });
    expect(dispute.status).toBe(DisputeStatus.EvidenceWindow);
  });
});

describe("evidence window", () => {
  /** Force the window shut without waiting out the configured hours. */
  async function withClosedWindow(service: DisputeService, disputeId: string, repository: InMemoryDisputeRepository) {
    const dispute = await repository.find(disputeId);
    if (!dispute) throw new Error("dispute missing");
    await repository.save({
      ...dispute,
      evidenceWindowClosesAt: new Date(Date.now() - 1000).toISOString(),
    });
    return service;
  }

  it("reports a lapsed window as under review rather than still open", async () => {
    const { service, repository, order } = setup(makeOrder("10000"));
    const opened = await service.open(buyer, { orderId: order.id, reason: "dispute" });
    await withClosedWindow(service, opened.id, repository);

    const [listed] = await service.list(buyer.userId);
    expect(listed?.status).toBe(DisputeStatus.UnderReview);
    expect((await service.details(opened.id, buyer)).status).toBe(
      DisputeStatus.UnderReview,
    );
  });

  it("lets compliance decide a dispute nobody evidenced once the window closes", async () => {
    const { service, repository, order } = setup(makeOrder("10000"));
    const opened = await service.open(buyer, { orderId: order.id, reason: "dispute" });

    // While the window is open, deciding with no evidence is premature.
    await expect(
      service.resolve(compliance, opened.id, {
        decision: DisputeResolution.Refund,
        reason: "no evidence from either side",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await withClosedWindow(service, opened.id, repository);

    // Once closed, the funds must not stay frozen with no path to a decision.
    const resolved = await service.resolve(compliance, opened.id, {
      decision: DisputeResolution.Refund,
      reason: "Neither party submitted evidence; refund the buyer.",
    });
    expect(resolved.resolution?.decidedBy).toBe(DisputeDecisionMaker.Human);
    expect(resolved.resolution?.outcome).toBe(DisputeResolution.Refund);
  });

  it("still refuses auto-resolve with no advisory", async () => {
    const { service, repository, order } = setup(makeOrder("10000"));
    const opened = await service.open(buyer, { orderId: order.id, reason: "dispute" });
    await withClosedWindow(service, opened.id, repository);
    await expect(service.resolve(buyer, opened.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("dispute log", () => {
  it("projects the audit trail into role-labelled lines for the parties", async () => {
    const { service, order } = setup(makeOrder("10000"));
    const opened = await service.open(buyer, { orderId: order.id, reason: "dispute" });
    await service.submitEvidence(seller, opened.id, releaseEvidence(0.95));
    await service.submitEvidence(seller, opened.id, releaseEvidence(0.95));
    await service.resolve(buyer, opened.id);

    const log = await service.log(opened.id, seller);
    const actions = log.map((entry) => entry.action);
    expect(actions).toContain("dispute.opened");
    expect(actions).toContain("dispute.evidence_submitted");
    expect(actions).toContain("dispute.advisory");
    expect(actions).toContain("dispute.resolved");

    // Oldest first, so the timeline reads top to bottom.
    expect([...log].sort((a, b) => a.at.localeCompare(b.at))).toEqual(log);

    // Roles, never raw user ids — the counterparty reads this.
    expect(log.find((entry) => entry.action === "dispute.opened")?.actor).toBe("buyer");
    expect(
      log.find((entry) => entry.action === "dispute.evidence_submitted")?.actor,
    ).toBe("seller");
    expect(log.find((entry) => entry.action === "dispute.advisory")?.actor).toBe("ai");
    expect(log.find((entry) => entry.action === "dispute.resolved")?.actor).toBe(
      "system",
    );
    for (const entry of log) expect(entry.summary.length).toBeGreaterThan(0);
  });

  it("refuses the log to someone who is not a party or compliance", async () => {
    const { service, order } = setup(makeOrder("10000"));
    const opened = await service.open(buyer, { orderId: order.id, reason: "dispute" });
    await expect(
      service.log(opened.id, { userId: "intruder", roles: ["user"] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
