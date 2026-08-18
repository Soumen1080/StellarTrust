/**
 * A party can actually raise a dispute, and it reaches the contract.
 *
 * This used to be unreachable whenever the gateway signs server-side (the
 * default): `transition()` refused `dispute` as non-financial and pointed at
 * prepare/submit, while `prepareTransition()` refused it because nothing
 * needed a wallet signature. Both doors shut — so the contract's `dispute`
 * entry point, the only route to a settleable unconfirmed escrow, could be
 * reached by the arbiter and no one else.
 *
 * That mattered beyond ergonomics: opening a dispute through `/api/disputes`
 * left the escrow `Locked` on-chain, and the contract's `release` accepts only
 * `Disputed` or a buyer confirmation. A resolution would be recorded and then
 * fail to execute.
 */
import {
  DisputeResolution,
  EscrowState,
  OrderStatus,
  PaymentTransition,
} from "@stellartrust/shared";
import { describe, expect, it } from "vitest";
import { InMemoryAuditRepository } from "../audit/audit.repository.js";
import { InMemoryPaymentRepository } from "../payments/payment.repository.js";
import { PaymentService } from "../payments/payment.service.js";
import { DeterministicEscrowGateway } from "./escrow.gateway.js";

const buyer = { userId: "buyer-1", roles: ["user"] };
const seller = { userId: "seller-1", roles: ["user"] };
const stranger = { userId: "stranger-1", roles: ["user"] };
const compliance = { userId: "compliance-1", roles: ["compliance"] };

async function lockedOrder() {
  const repository = new InMemoryPaymentRepository();
  const gateway = new DeterministicEscrowGateway();
  const service = new PaymentService(
    repository,
    gateway,
    new InMemoryAuditRepository(),
  );
  const created = await service.createOrder(buyer.userId, {
    sellerId: seller.userId,
    amount: { amount: "12500", currency: "USDC" },
  });
  const id = created.order.id;
  await service.transition(id, PaymentTransition.Accept, seller);
  await service.transition(id, PaymentTransition.Deposit, buyer);
  const locked = await service.transition(id, PaymentTransition.Lock, buyer);
  return {
    repository,
    gateway,
    service,
    id,
    contractId: locked.escrow?.contractId ?? "",
  };
}

describe("raising a dispute on the server-signed path", () => {
  it("moves custody to Disputed on-chain and in the books", async () => {
    const { service, gateway, id, contractId } = await lockedOrder();

    const details = await service.raiseDispute(id, buyer);

    expect(details.order.status).toBe(OrderStatus.Disputed);
    expect(details.escrow?.state).toBe(EscrowState.Disputed);
    // The half that actually binds: the contract, not just our row.
    expect(await gateway.getEscrowState(contractId)).toBe(EscrowState.Disputed);
  });

  it("lets the seller dispute too, and refuses a stranger", async () => {
    const sellerCase = await lockedOrder();
    await expect(
      sellerCase.service.raiseDispute(sellerCase.id, seller),
    ).resolves.toMatchObject({ order: { status: OrderStatus.Disputed } });

    const strangerCase = await lockedOrder();
    await expect(
      strangerCase.service.raiseDispute(strangerCase.id, stranger),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses to dispute an escrow that is not locked", async () => {
    // Mirrors the contract, whose `dispute` requires State::Locked.
    const { service, id } = await lockedOrder();
    await service.raiseDispute(id, buyer);
    await expect(service.raiseDispute(id, buyer)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("leaves an escrow the arbiter can then settle", async () => {
    // The point of the whole path: a deal the buyer never confirmed becomes
    // settleable only once the contract has been moved to Disputed.
    const { service, gateway, id, contractId } = await lockedOrder();
    await service.raiseDispute(id, buyer);

    const settled = await service.settleDisputedOrder(
      id,
      DisputeResolution.Release,
      compliance,
    );

    expect(settled.order.status).toBe(OrderStatus.Released);
    expect(await gateway.getEscrowState(contractId)).toBe(EscrowState.Released);
  });
});
