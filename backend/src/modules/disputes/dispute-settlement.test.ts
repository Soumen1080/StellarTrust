/**
 * Phase 6 — dispute auto-execution integration.
 *
 * Verifies that resolving a dispute drives the fund movement through the Phase 2
 * arbiter payments path (release/refund), updates the advisory reputation prior,
 * and that a settlement failure is non-fatal (the dispute record stays the
 * authority and the failure is audited).
 */
import {
  DisputeResolution,
  PaymentTransition,
} from "@stellartrust/shared";
import { describe, expect, it } from "vitest";
import { InMemoryAuditRepository } from "../audit/audit.repository.js";
import { DeterministicEscrowGateway } from "../escrow/escrow.gateway.js";
import { InMemoryPaymentRepository } from "../payments/payment.repository.js";
import { PaymentService } from "../payments/payment.service.js";
import { InMemoryReputationRepository } from "../reputation/reputation.repository.js";
import { ReputationService } from "../reputation/reputation.service.js";
import { DeterministicDisputeRiskClient } from "./dispute-risk.client.js";
import { InMemoryDisputeRepository } from "./dispute.repository.js";
import { DisputeService } from "./dispute.service.js";

const buyer = { userId: "buyer-1", roles: ["user"] };
const seller = { userId: "seller-1", roles: ["user"] };
const compliance = { userId: "reviewer-1", roles: ["user", "compliance"] };

function setup() {
  const audit = new InMemoryAuditRepository();
  const reputation = new ReputationService(
    new InMemoryReputationRepository(),
    audit,
  );
  const paymentRepository = new InMemoryPaymentRepository();
  const escrowGateway = new DeterministicEscrowGateway();
  const payments = new PaymentService(
    paymentRepository,
    escrowGateway,
    audit,
    undefined,
    reputation,
  );
  const disputes = new DisputeService(
    new InMemoryDisputeRepository(),
    { getOrder: (id) => paymentRepository.findOrder(id) },
    new DeterministicDisputeRiskClient(),
    audit,
    reputation,
    {
      settle: ({ orderId, outcome }) =>
        payments
          .settleDisputedOrder(orderId, outcome, {
            userId: "system:dispute-resolver",
            roles: ["system"],
          })
          .then(() => undefined),
    },
  );
  return { audit, reputation, paymentRepository, payments, disputes };
}

/** Drive an order to the Locked state (create → accept → deposit → lock). */
async function lockOrder(payments: PaymentService): Promise<string> {
  const created = await payments.createOrder(buyer.userId, {
    sellerId: seller.userId,
    amount: { amount: "10000", currency: "USDC" },
  });
  const id = created.order.id;
  await payments.transition(id, PaymentTransition.Accept, seller);
  await payments.transition(id, PaymentTransition.Deposit, buyer);
  await payments.transition(id, PaymentTransition.Lock, buyer);
  return id;
}

const releaseEvidence = (weight: number) => ({
  kind: "tracking" as const,
  supports: DisputeResolution.Release,
  weight,
  reference: "storage://evidence/tracking-1",
});

describe("Phase 6 dispute auto-execution", () => {
  it("auto-resolves and releases a locked escrow to the seller", async () => {
    const { payments, paymentRepository, disputes, reputation } = setup();
    const orderId = await lockOrder(payments);

    const opened = await disputes.open(buyer, { orderId, reason: "no delivery" });
    await disputes.submitEvidence(seller, opened.id, releaseEvidence(0.95));
    const withEvidence = await disputes.submitEvidence(
      seller,
      opened.id,
      releaseEvidence(0.95),
    );
    expect(withEvidence.autoResolvable).toBe(true);

    const resolved = await disputes.resolve(buyer, opened.id);
    expect(resolved.resolution?.outcome).toBe(DisputeResolution.Release);

    // The order was settled through the arbiter payments path.
    const order = await paymentRepository.findOrder(orderId);
    expect(order?.status).toBe("released");
    const escrow = await paymentRepository.findEscrow(orderId);
    expect(escrow?.state).toBe("released");

    // Release favours the seller in the advisory reputation prior.
    expect(await reputation.getScore(seller.userId)).toBeGreaterThan(
      await reputation.getScore(buyer.userId),
    );
  });

  it("executes a compliance refund decision through the arbiter path", async () => {
    const { payments, paymentRepository, disputes, reputation } = setup();
    const orderId = await lockOrder(payments);

    const opened = await disputes.open(buyer, { orderId, reason: "not delivered" });
    // Conflicting evidence forces a human decision.
    await disputes.submitEvidence(seller, opened.id, releaseEvidence(0.9));
    await disputes.submitEvidence(buyer, opened.id, {
      kind: "invoice",
      supports: DisputeResolution.Refund,
      weight: 0.9,
      reference: "storage://evidence/invoice-1",
    });

    const resolved = await disputes.resolve(compliance, opened.id, {
      decision: DisputeResolution.Refund,
      reason: "Buyer evidence shows non-delivery.",
    });
    expect(resolved.resolution?.outcome).toBe(DisputeResolution.Refund);

    const order = await paymentRepository.findOrder(orderId);
    expect(order?.status).toBe("refunded");
    const escrow = await paymentRepository.findEscrow(orderId);
    expect(escrow?.state).toBe("refunded");

    // Refund favours the buyer in the reputation prior.
    expect(await reputation.getScore(buyer.userId)).toBeGreaterThan(
      await reputation.getScore(seller.userId),
    );
  });

  it("keeps resolution non-fatal and audited when settlement cannot execute", async () => {
    const { payments, paymentRepository, disputes, audit } = setup();
    // Order never locked (still 'created') → settlement guard rejects it.
    const created = await payments.createOrder(buyer.userId, {
      sellerId: seller.userId,
      amount: { amount: "10000", currency: "USDC" },
    });
    const orderId = created.order.id;

    const opened = await disputes.open(buyer, { orderId, reason: "dispute" });
    await disputes.submitEvidence(seller, opened.id, releaseEvidence(0.95));
    await disputes.submitEvidence(seller, opened.id, releaseEvidence(0.95));

    // Resolution still succeeds (the dispute record is the authority)...
    const resolved = await disputes.resolve(buyer, opened.id);
    expect(resolved.status).toBe("resolved");
    // ...but the order was not moved and the failure is audited for retry.
    const order = await paymentRepository.findOrder(orderId);
    expect(order?.status).toBe("created");
    const events = await audit.listForEntity("dispute", opened.id);
    expect(events.map((e) => e.action)).toContain("dispute.settlement_failed");
  });
});

describe("Phase 6 arbiter settlement guards", () => {
  it("refuses settlement from a non-arbiter actor", async () => {
    const { payments } = setup();
    const orderId = await lockOrder(payments);
    await expect(
      payments.settleDisputedOrder(orderId, DisputeResolution.Release, buyer),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses settlement for an order that is not locked", async () => {
    const { payments } = setup();
    const created = await payments.createOrder(buyer.userId, {
      sellerId: seller.userId,
      amount: { amount: "10000", currency: "USDC" },
    });
    await expect(
      payments.settleDisputedOrder(
        created.order.id,
        DisputeResolution.Release,
        { userId: "system", roles: ["system"] },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
