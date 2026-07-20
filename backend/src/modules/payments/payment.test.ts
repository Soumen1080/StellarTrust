import {
  PaymentTransition,
  ReconciliationStatus,
  type PaymentTransitionDTO,
} from "@stellartrust/shared";
import { describe, expect, it } from "vitest";
import { ReconciliationJob } from "../../jobs/reconciliation.job.js";
import { InMemoryAuditRepository } from "../audit/audit.repository.js";
import { DeterministicEscrowGateway } from "../escrow/escrow.gateway.js";
import { isBalanced } from "../ledger/ledger.balance.js";
import { InMemoryPaymentRepository } from "./payment.repository.js";
import { PaymentService } from "./payment.service.js";

function setup() {
  const repository = new InMemoryPaymentRepository();
  const gateway = new DeterministicEscrowGateway();
  const audit = new InMemoryAuditRepository();
  const service = new PaymentService(repository, gateway, audit);
  const reconciliation = new ReconciliationJob(repository, gateway, 60_000);
  return { repository, gateway, audit, service, reconciliation };
}

async function happyPath() {
  const context = setup();
  const buyer = { userId: "buyer-1", roles: ["user"] };
  const seller = { userId: "seller-1", roles: ["user"] };
  const created = await context.service.createOrder(buyer.userId, {
    sellerId: seller.userId,
    amount: { amount: "12500", currency: "USDC" },
  });
  const id = created.order.id;
  await context.service.transition(id, PaymentTransition.Accept, seller);
  await context.service.transition(id, PaymentTransition.Deposit, buyer);
  await context.service.transition(id, PaymentTransition.Lock, buyer);
  await context.service.transition(id, PaymentTransition.Confirm, buyer);
  const released = await context.service.transition(
    id,
    PaymentTransition.Release,
    buyer,
  );
  return { ...context, buyer, seller, id, released };
}

function expectLinkedAndBalanced(transitions: PaymentTransitionDTO[]) {
  for (const transition of transitions) {
    expect(isBalanced(transition.ledgerTransaction.entries)).toBe(true);
    expect(transition.stellarTransaction.hash).toBeTruthy();
    expect(transition.stellarTransaction.ledgerTransactionId).toBe(
      transition.ledgerTransaction.id,
    );
  }
}

describe("Phase 2 payment and escrow happy path", () => {
  it("runs create → accept → deposit → lock → confirm → release", async () => {
    const result = await happyPath();
    expect(result.released.order.status).toBe("released");
    expect(result.released.escrow?.state).toBe("released");
    expect(result.released.escrow?.contractId).toBeTruthy();

    const transitions = await result.repository.listTransitions(result.id);
    expect(transitions.map((item) => item.transition)).toEqual([
      "create",
      "accept",
      "deposit",
      "lock",
      "confirm",
      "release",
    ]);
    expectLinkedAndBalanced(transitions);
  });

  it("reports zero unresolved mismatches for the happy path", async () => {
    const result = await happyPath();
    const report = await result.reconciliation.run();
    expect(report.status).toBe(ReconciliationStatus.Matched);
    expect(report.checked).toBe(6);
    expect(report.matched).toBe(6);
    expect(report.unresolved).toBe(0);
  });

  it("rejects unauthorized and out-of-order transitions", async () => {
    const { service } = setup();
    const created = await service.createOrder("buyer-1", {
      sellerId: "seller-1",
      amount: { amount: "500", currency: "USDC" },
    });
    await expect(
      service.transition(created.order.id, PaymentTransition.Accept, {
        userId: "intruder",
        roles: ["user"],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      service.transition(created.order.id, PaymentTransition.Deposit, {
        userId: "buyer-1",
        roles: ["user"],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("allows only an authorized arbiter to refund locked escrow", async () => {
    const { service } = setup();
    const buyer = { userId: "buyer-1", roles: ["user"] };
    const seller = { userId: "seller-1", roles: ["user"] };
    const created = await service.createOrder(buyer.userId, {
      sellerId: seller.userId,
      amount: { amount: "500", currency: "USDC" },
    });
    const id = created.order.id;
    await service.transition(id, PaymentTransition.Accept, seller);
    await service.transition(id, PaymentTransition.Deposit, buyer);
    await service.transition(id, PaymentTransition.Lock, buyer);
    await expect(
      service.transition(id, PaymentTransition.Refund, buyer),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const refunded = await service.transition(id, PaymentTransition.Refund, {
      userId: "reviewer-1",
      roles: ["compliance"],
    });
    expect(refunded.order.status).toBe("refunded");
    expect(refunded.escrow?.state).toBe("refunded");
  });
});
