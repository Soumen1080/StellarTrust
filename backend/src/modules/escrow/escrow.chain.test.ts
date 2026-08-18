/**
 * Escrow ↔ contract parity and the wallet-signing round trip.
 *
 * The deterministic adapter is what CI actually exercises, so its value depends
 * entirely on it rejecting what the deployed Rust contract rejects. These tests
 * pin the rules that used to differ between the two.
 */
import {
  ChainSigningMode,
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

const BUYER = { userId: "buyer-1", roles: ["user"] };
const SELLER = { userId: "seller-1", roles: ["user"] };
const ARBITER = { userId: "compliance-1", roles: ["compliance"] };

function setup() {
  const repository = new InMemoryPaymentRepository();
  const gateway = new DeterministicEscrowGateway();
  const service = new PaymentService(
    repository,
    gateway,
    new InMemoryAuditRepository(),
  );
  return { repository, gateway, service };
}

/** Drive an order to the point where funds are locked in escrow. */
async function lockedOrder() {
  const context = setup();
  const created = await context.service.createOrder(BUYER.userId, {
    sellerId: SELLER.userId,
    amount: { amount: "12500", currency: "USDC" },
  });
  const id = created.order.id;
  await context.service.transition(id, PaymentTransition.Accept, SELLER);
  await context.service.transition(id, PaymentTransition.Deposit, BUYER);
  const locked = await context.service.transition(
    id,
    PaymentTransition.Lock,
    BUYER,
  );
  return { ...context, id, contractId: locked.escrow?.contractId ?? "" };
}

describe("deterministic gateway mirrors the Rust escrow contract", () => {
  it("refuses to release a locked escrow that was never confirmed or disputed", async () => {
    const { gateway, id, contractId } = await lockedOrder();
    // The contract's `release` accepts Disputed, or Locked + delivery_confirmed.
    // Arbiter authority is not a third option — asserting otherwise here would
    // green-light a call that fails on-chain with InvalidState.
    await expect(
      gateway.submitTransition({
        orderId: id,
        transition: PaymentTransition.Release,
        amount: "12500",
        currency: "USDC",
        buyerId: BUYER.userId,
        sellerId: SELLER.userId,
        contractId,
        arbiter: true,
      }),
    ).rejects.toThrow(/buyer confirmation, or a disputed escrow/);
  });

  it("releases once the escrow has been disputed", async () => {
    const { gateway, id, contractId } = await lockedOrder();
    await gateway.submitTransition({
      orderId: id,
      transition: PaymentTransition.Dispute,
      amount: "12500",
      currency: "USDC",
      buyerId: BUYER.userId,
      sellerId: SELLER.userId,
      contractId,
    });
    expect(await gateway.getEscrowState(contractId)).toBe(EscrowState.Disputed);

    await gateway.submitTransition({
      orderId: id,
      transition: PaymentTransition.Release,
      amount: "12500",
      currency: "USDC",
      buyerId: BUYER.userId,
      sellerId: SELLER.userId,
      contractId,
      arbiter: true,
    });
    expect(await gateway.getEscrowState(contractId)).toBe(EscrowState.Released);
  });

  it("refunds a disputed escrow", async () => {
    const { gateway, id, contractId } = await lockedOrder();
    for (const transition of [
      PaymentTransition.Dispute,
      PaymentTransition.Refund,
    ]) {
      await gateway.submitTransition({
        orderId: id,
        transition,
        amount: "12500",
        currency: "USDC",
        buyerId: BUYER.userId,
        sellerId: SELLER.userId,
        contractId,
        arbiter: transition === PaymentTransition.Refund,
      });
    }
    expect(await gateway.getEscrowState(contractId)).toBe(EscrowState.Refunded);
  });

  it("will not dispute an escrow that is not locked", async () => {
    const { gateway, id, contractId } = await lockedOrder();
    const dispute = {
      orderId: id,
      transition: PaymentTransition.Dispute,
      amount: "12500",
      currency: "USDC" as const,
      buyerId: BUYER.userId,
      sellerId: SELLER.userId,
      contractId,
    };
    await gateway.submitTransition(dispute);
    await expect(gateway.submitTransition(dispute)).rejects.toThrow(
      /Only locked escrow can be disputed/,
    );
  });

  it("reports custody bound to the order that created it", async () => {
    const { gateway, id, contractId } = await lockedOrder();
    const snapshot = await gateway.getEscrowSnapshot(contractId);
    expect(snapshot).toMatchObject({
      state: EscrowState.Locked,
      orderId: id,
      deliveryConfirmed: false,
    });
  });
});

describe("arbiter dispute settlement", () => {
  it("escalates an unconfirmed escrow before releasing it", async () => {
    const { service, gateway, id, contractId } = await lockedOrder();

    const settled = await service.settleDisputedOrder(
      id,
      DisputeResolution.Release,
      ARBITER,
    );

    // The escrow passed through Disputed on the way — that is what made the
    // release legal against the contract's own state machine.
    expect(settled.order.status).toBe(OrderStatus.Released);
    expect(settled.escrow?.state).toBe(EscrowState.Released);
    expect(await gateway.getEscrowState(contractId)).toBe(EscrowState.Released);
  });

  it("refunds a locked escrow without escalating", async () => {
    const { service, id, gateway, contractId } = await lockedOrder();
    const settled = await service.settleDisputedOrder(
      id,
      DisputeResolution.Refund,
      ARBITER,
    );
    // The contract already accepts a refund from Locked, so no dispute is
    // needed — escalating anyway would add a pointless on-chain transaction.
    expect(settled.order.status).toBe(OrderStatus.Refunded);
    expect(await gateway.getEscrowState(contractId)).toBe(EscrowState.Refunded);
  });

  it("requires arbiter authority", async () => {
    const { service, id } = await lockedOrder();
    await expect(
      service.settleDisputedOrder(id, DisputeResolution.Release, BUYER),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("signing capabilities", () => {
  it("advertises server signing for every chain step under the local adapter", () => {
    const { service } = setup();
    const capabilities = service.capabilities();

    expect(capabilities.walletSignedTransitions).toEqual([]);
    expect(capabilities.signingModes[PaymentTransition.Lock]).toBe(
      ChainSigningMode.Server,
    );
    expect(capabilities.signingModes[PaymentTransition.Create]).toBe(
      ChainSigningMode.None,
    );
    expect(capabilities.network).toBe("testnet");
    expect(capabilities.networkPassphrase).toBe(
      "Test SDF Network ; September 2015",
    );
  });

  it("rejects a prepare for a transition this deployment signs server-side", async () => {
    const { service, id } = await lockedOrder();
    await expect(
      service.prepareTransition(id, PaymentTransition.Confirm, BUYER),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses to route a dispute through the financial transition path", async () => {
    const { service, id } = await lockedOrder();
    await expect(
      service.transition(id, PaymentTransition.Dispute, BUYER),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
