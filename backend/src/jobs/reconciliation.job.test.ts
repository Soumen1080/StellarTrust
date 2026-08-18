/**
 * Reconciliation must compare what is actually comparable.
 *
 * Two failure modes are pinned here, both of which passed silently before:
 *   - Ledger-only transitions (`create`/`accept`/`deposit`) carry a synthetic
 *     chain hash. Looking it up on a real network returns NOT_FOUND, which was
 *     recorded as "chain transaction was not found" — a mismatch that blocks
 *     the order. Every order would have jammed on its first step.
 *   - Custody was compared by state alone. An escrow holding the wrong amount,
 *     or the wrong asset, is `Locked` on-chain and `locked` in the books:
 *     identical states, entirely different facts about where the money is.
 */
import {
  ChainTxStatus,
  EscrowState,
  PaymentTransition,
  ReconciliationStatus,
} from "@stellartrust/shared";
import { describe, expect, it } from "vitest";
import { InMemoryAuditRepository } from "../modules/audit/audit.repository.js";
import {
  DeterministicEscrowGateway,
  type EscrowGateway,
  type EscrowSnapshot,
} from "../modules/escrow/escrow.gateway.js";
import { InMemoryPaymentRepository } from "../modules/payments/payment.repository.js";
import { PaymentService } from "../modules/payments/payment.service.js";
import { ReconciliationJob } from "./reconciliation.job.js";

const buyer = { userId: "buyer-1", roles: ["user"] };
const seller = { userId: "seller-1", roles: ["user"] };

/** Drive an order through create → accept → deposit → lock → confirm. */
async function confirmedOrder() {
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
  await service.transition(id, PaymentTransition.Lock, buyer);
  await service.transition(id, PaymentTransition.Confirm, buyer);
  return { repository, gateway, service, id };
}

/**
 * A gateway standing in for a live network: it knows nothing about our
 * internal ids, so it can only answer about hashes it has actually seen. This
 * is the behaviour the deterministic adapter cannot reproduce — it keeps its
 * own receipts, including for transitions that never touched a chain.
 */
class PublicLedgerGateway implements EscrowGateway {
  constructor(
    private readonly inner: DeterministicEscrowGateway,
    private readonly snapshot?: EscrowSnapshot,
  ) {}

  signingMode(transition: PaymentTransition) {
    return this.inner.signingMode(transition);
  }

  prepareTransition(...args: Parameters<EscrowGateway["prepareTransition"]>) {
    return this.inner.prepareTransition(...args);
  }

  submitSignedTransition(
    ...args: Parameters<EscrowGateway["submitSignedTransition"]>
  ) {
    return this.inner.submitSignedTransition(...args);
  }

  submitTransition(...args: Parameters<EscrowGateway["submitTransition"]>) {
    return this.inner.submitTransition(...args);
  }

  /** Only chain-bearing transitions have a hash a network would recognise. */
  async getTransaction(hash: string) {
    const known = await this.inner.getTransaction(hash);
    if (!known || !isChainTransition(known.transition)) return undefined;
    return { hash, status: ChainTxStatus.Success };
  }

  async getEscrowState(contractId: string) {
    return (await this.getEscrowSnapshot(contractId))?.state;
  }

  async getEscrowSnapshot(contractId: string) {
    return this.snapshot ?? this.inner.getEscrowSnapshot(contractId);
  }
}

function isChainTransition(transition: PaymentTransition | undefined): boolean {
  return (
    transition === PaymentTransition.Lock ||
    transition === PaymentTransition.Confirm ||
    transition === PaymentTransition.Dispute ||
    transition === PaymentTransition.Release ||
    transition === PaymentTransition.Refund
  );
}

describe("ledger-only transitions are not expected on-chain", () => {
  it("reconciles clean when the network has never seen the synthetic hashes", async () => {
    const { repository, gateway, id } = await confirmedOrder();
    const job = new ReconciliationJob(
      repository,
      new PublicLedgerGateway(gateway),
      60_000,
    );

    const report = await job.run();

    // create/accept/deposit are bookkeeping. Asking a real network about their
    // hashes returns nothing, and treating that as evidence of a problem would
    // block the order permanently.
    expect(report.status).toBe(ReconciliationStatus.Matched);
    expect(report.unresolved).toBe(0);
    expect(await repository.hasUnresolvedMismatch(id)).toBe(false);
  });

  it("still flags a chain-bearing transition the network cannot confirm", async () => {
    const { repository, gateway } = await confirmedOrder();
    // A gateway that has seen nothing at all: `lock` and `confirm` really are
    // missing, and that must not be waved through by the same exemption.
    const blind = new PublicLedgerGateway(gateway);
    blind.getTransaction = async () => undefined;
    const job = new ReconciliationJob(repository, blind, 60_000);

    const report = await job.run();

    expect(report.status).toBe(ReconciliationStatus.Mismatch);
    expect(report.mismatches.map((m) => m.reason)).toContain(
      "chain transaction was not found",
    );
  });
});

describe("custody is reconciled by value, not only by state", () => {
  /** Run reconciliation with custody reporting `snapshot`. */
  async function reconcileWith(snapshot: EscrowSnapshot) {
    const { repository, gateway } = await confirmedOrder();
    const job = new ReconciliationJob(
      repository,
      new PublicLedgerGateway(gateway, snapshot),
      60_000,
    );
    return job.run();
  }

  const locked = (
    value: EscrowSnapshot["value"],
    deliveryConfirmed = true,
  ): EscrowSnapshot => ({
    state: EscrowState.Locked,
    orderId: null,
    deliveryConfirmed,
    value,
  });

  it("accepts custody holding exactly the order amount", async () => {
    const report = await reconcileWith(
      locked({ amount: "12500", currency: "USDC", tokenContractId: null }),
    );
    expect(report.status).toBe(ReconciliationStatus.Matched);
  });

  it("flags custody holding less than the order is worth", async () => {
    const report = await reconcileWith(
      locked({ amount: "125", currency: "USDC", tokenContractId: null }),
    );
    expect(report.status).toBe(ReconciliationStatus.Mismatch);
    expect(report.mismatches[0]?.reason).toMatch(
      /holds 125 USDC but the order is 12500 USDC/,
    );
  });

  it("flags custody holding the wrong asset", async () => {
    const report = await reconcileWith(
      locked({ amount: "12500", currency: "XLM", tokenContractId: null }),
    );
    expect(report.status).toBe(ReconciliationStatus.Mismatch);
    expect(report.mismatches[0]?.reason).toMatch(/12500 XLM/);
  });

  it("flags a token this deployment cannot express in ledger units", async () => {
    const report = await reconcileWith(
      locked({
        amount: null,
        currency: null,
        tokenContractId: "CUNKNOWNTOKEN",
      }),
    );
    expect(report.status).toBe(ReconciliationStatus.Mismatch);
    expect(report.mismatches[0]?.reason).toMatch(
      /cannot express in ledger units/,
    );
  });

  it("flags a confirmed order the contract never recorded a confirmation for", async () => {
    // The contract's `delivery_confirmed` is what gates a happy-path release.
    // Books saying "confirmed" against a contract that disagrees means the next
    // release fails on-chain.
    const report = await reconcileWith(
      locked(
        { amount: "12500", currency: "USDC", tokenContractId: null },
        false,
      ),
    );
    expect(report.status).toBe(ReconciliationStatus.Mismatch);
    expect(report.mismatches[0]?.reason).toMatch(
      /no delivery confirmation/,
    );
  });
});
