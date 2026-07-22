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
