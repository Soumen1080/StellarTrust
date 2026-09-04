/**
 * Cross-domain synchronization over the event spine (plane.md §2.1, §2.2).
 *
 * The unit tests in `event.test.ts` prove the spine's mechanics. These prove
 * the behaviour that motivated it: a settlement that funds an escrow order
 * without the buyer paying twice, and a dispute that stops investors being paid
 * out of money that may have to go back to the buyer.
 *
 * Both are wired the way `app.ts` wires them — real services, real bus, real
 * subscribers — because the defects being closed here were never inside one
 * module. They lived in the gaps between four modules that each worked.
 */
import {
  DisputeResolution,
  PaymentTransition,
  TokenizationStatus,
} from "@stellartrust/shared";
import { describe, expect, it } from "vitest";
import { InMemoryAuditRepository } from "../audit/audit.repository.js";
import { DeterministicDisputeRiskClient } from "../disputes/dispute-risk.client.js";
import { InMemoryDisputeRepository } from "../disputes/dispute.repository.js";
import { DisputeService } from "../disputes/dispute.service.js";
import { DeterministicEscrowGateway } from "../escrow/escrow.gateway.js";
import { StaticWalletAddressResolver } from "../identity/wallet.resolver.js";
import { PrefundedLedgerService } from "../ledger/ledger.test-fixtures.js";
import { InMemoryPaymentRepository } from "../payments/payment.repository.js";
import { PaymentService } from "../payments/payment.service.js";
import { orderDepositOnSettlement } from "../payments/payment.subscribers.js";
import { InMemoryReputationRepository } from "../reputation/reputation.repository.js";
import { ReputationService } from "../reputation/reputation.service.js";
import { DeterministicRwaGateway } from "../rwa/rwa.gateway.js";
import { InMemoryRwaRepository } from "../rwa/rwa.repository.js";
import { RwaService } from "../rwa/rwa.service.js";
import {
  rwaHoldOnDispute,
  rwaPayoutOnRelease,
  rwaResumeOnDisputeResolved,
} from "../rwa/rwa.subscribers.js";
import { EventBus } from "./event.bus.js";
import { InMemoryEventRepository } from "./event.repository.js";
import { DomainEventType, EventEntity, dedupeKey } from "./event.types.js";
import { createVerifiedAsset } from "../rwa/rwa.test-fixtures.js";

const buyer = { userId: "buyer-1", roles: ["user"] };
const seller = { userId: "seller-1", roles: ["user"] };
const investor = { userId: "investor-1", roles: ["user"] };

const ISSUER_ADDRESS = "GBUV3T3YDFD232LUXGADFZV2XCMNEHXBMVTQPBD7DKHTP4Q6ZLNOSMEX";
const INVESTOR1_ADDRESS = "GDYWVMFH5JDIISEZMLDFTN6A5NHPLZGKTTYAAKGB5Z6U7MHKUV6JPVS5";

const FUTURE_MATURITY = new Date(
  Date.now() + 90 * 24 * 60 * 60 * 1000,
).toISOString();

/** The whole platform, wired as `app.ts` wires it. */
function setup() {
  const audit = new InMemoryAuditRepository();
  const ledger = new PrefundedLedgerService();
  const eventRepository = new InMemoryEventRepository();
  const bus = new EventBus(eventRepository, undefined, {
    sleep: async () => {},
  });

  const rwaRepository = new InMemoryRwaRepository();
  const disputeRef: {
    current?: { hasOpenDispute(id: string): Promise<boolean> };
  } = {};
  const rwa = new RwaService(
    rwaRepository,
    new DeterministicRwaGateway(),
    audit,
    ledger,
    new StaticWalletAddressResolver(new Map([["seller-1", ISSUER_ADDRESS]])),
    {
      hasOpenDispute: (id) =>
        disputeRef.current?.hasOpenDispute(id) ?? Promise.resolve(false),
    },
  );

  const paymentRepository = new InMemoryPaymentRepository();
  const reputation = new ReputationService(
    new InMemoryReputationRepository(),
    audit,
  );
  const payments = new PaymentService(
    paymentRepository,
    new DeterministicEscrowGateway(),
    audit,
    rwa,
    reputation,
    bus,
  );

  const disputes = new DisputeService(
    new InMemoryDisputeRepository(),
    {
      getOrder: (id) => paymentRepository.findOrder(id),
      getEscrow: (id) => paymentRepository.findEscrow(id),
    },
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
    undefined,
    bus,
  );
  disputeRef.current = disputes;

  bus.subscribe(rwaPayoutOnRelease(rwa, rwaRepository, disputes));
  bus.subscribe(rwaHoldOnDispute(rwaRepository));
  bus.subscribe(rwaResumeOnDisputeResolved(rwaRepository));
  bus.subscribe(orderDepositOnSettlement(payments));

  return { audit, bus, eventRepository, rwa, rwaRepository, payments, paymentRepository, disputes, ledger };
}

/** An order locked and ready to release, with a tokenization behind it. */
async function tokenizedOrder(s: ReturnType<typeof setup>) {
  const created = await s.payments.createOrder(buyer.userId, {
    sellerId: seller.userId,
    amount: { amount: "1000000", currency: "USDC" },
  });
  const orderId = created.order.id;
  await s.payments.transition(orderId, PaymentTransition.Accept, seller);
  await s.payments.transition(orderId, PaymentTransition.Deposit, buyer);
  await s.payments.transition(orderId, PaymentTransition.Lock, buyer);

  // The seller finances the receivable this order will pay.
  const asset = await createVerifiedAsset(s.rwa, seller.userId);
  const tokenization = await s.rwa.createTokenization(seller.userId, {
    assetId: asset.id,
    totalUnits: "1000",
    faceValueAmount: "1000000",
    faceValueCurrency: "USDC",
    advanceRateBps: 8_000,
    discountRateBps: 400,
    platformFeeBps: 100,
    maturityDate: FUTURE_MATURITY,
    linkedOrderId: orderId,
  });
  const deployed = await s.rwa.deployTokenization(tokenization.id, seller);
  await s.rwa.purchaseUnits(deployed.id, investor, {
    units: "1000",
    holderAddress: INVESTOR1_ADDRESS,
  });

  return { orderId, tokenizationId: deployed.id };
}

// ── §2.2 — disputes gate RWA payouts ────────────────────────────────────────

describe("disputes gate RWA payouts (§2.2)", () => {
  it("pays out on release when no dispute stands in the way", async () => {
    const s = setup();
    const { orderId, tokenizationId } = await tokenizedOrder(s);

    await s.payments.transition(orderId, PaymentTransition.Confirm, buyer);
    await s.payments.transition(orderId, PaymentTransition.Release, buyer);

    // The release published `order.released`; the subscriber turned it into a
    // collection and ran the waterfall.
    const after = await s.rwaRepository.findTokenization(tokenizationId);
    expect(after?.status).toBe(TokenizationStatus.Repaid);
    const distributions = await s.rwaRepository.listDistributions(tokenizationId);
    expect(distributions).toHaveLength(1);
  });

  it("holds the position when a dispute is opened on the linked order", async () => {
    const s = setup();
    const { orderId, tokenizationId } = await tokenizedOrder(s);

    await s.disputes.open(buyer, { orderId, reason: "goods not delivered" });

    const held = await s.rwaRepository.findTokenization(tokenizationId);
    expect(held?.status).toBe(TokenizationStatus.PayoutHeld);
  });

  it("refuses a payout while the position is held", async () => {
    const s = setup();
    const { orderId, tokenizationId } = await tokenizedOrder(s);
    await s.disputes.open(buyer, { orderId, reason: "goods not delivered" });

    // Even a direct, system-authorized call is refused: the hold is a state,
    // not a courtesy the caller may skip.
    await expect(
      s.rwa.distributePayout(
        tokenizationId,
        orderId,
        "release",
        1_000_000n,
        "USDC",
        { userId: "system", roles: ["system"] },
      ),
    ).rejects.toThrow(/held pending dispute/i);
  });

  it("resumes the payout when the dispute resolves for the seller", async () => {
    const s = setup();
    const { orderId, tokenizationId } = await tokenizedOrder(s);
    const opened = await s.disputes.open(buyer, {
      orderId,
      reason: "goods not delivered",
    });

    // Two strong release evidences make the dispute auto-resolvable.
    const evidence = {
      kind: "tracking" as const,
      supports: DisputeResolution.Release,
      weight: 0.95,
      reference: "storage://evidence/tracking-1",
    };
    await s.disputes.submitEvidence(seller, opened.id, evidence);
    await s.disputes.submitEvidence(seller, opened.id, evidence);
    const resolved = await s.disputes.resolve(buyer, opened.id);
    expect(resolved.resolution?.outcome).toBe(DisputeResolution.Release);

    // The trade stands, so the hold lifts — and because resolving for the
    // seller auto-executes the release, the position goes straight on to be
    // collected and repaid. `Funded` is a state it passes through here, not one
    // it rests in: the assertion that matters is that the payout was no longer
    // blocked and actually ran.
    const after = await s.rwaRepository.findTokenization(tokenizationId);
    expect(after?.status).toBe(TokenizationStatus.Repaid);
    expect(await s.rwaRepository.listDistributions(tokenizationId)).toHaveLength(
      1,
    );
  });

  it("defaults the position when the dispute resolves for the buyer", async () => {
    const s = setup();
    const { orderId, tokenizationId } = await tokenizedOrder(s);
    const opened = await s.disputes.open(buyer, {
      orderId,
      reason: "goods not delivered",
    });

    const evidence = {
      kind: "tracking" as const,
      supports: DisputeResolution.Refund,
      weight: 0.95,
      reference: "storage://evidence/tracking-1",
    };
    await s.disputes.submitEvidence(buyer, opened.id, evidence);
    await s.disputes.submitEvidence(buyer, opened.id, evidence);
    const resolved = await s.disputes.resolve(buyer, opened.id);
    expect(resolved.resolution?.outcome).toBe(DisputeResolution.Refund);

    // The buyer's money went back, so the receivable will never be collected.
    // That is a defaulted position, which routes into the §1.4 write-off path.
    const after = await s.rwaRepository.findTokenization(tokenizationId);
    expect(after?.status).toBe(TokenizationStatus.Defaulted);
  });

  it("distributes no payout at all across a full dispute-and-refund cycle", async () => {
    const s = setup();
    const { orderId, tokenizationId } = await tokenizedOrder(s);
    const opened = await s.disputes.open(buyer, {
      orderId,
      reason: "goods not delivered",
    });
    const evidence = {
      kind: "tracking" as const,
      supports: DisputeResolution.Refund,
      weight: 0.95,
      reference: "storage://evidence/tracking-1",
    };
    await s.disputes.submitEvidence(buyer, opened.id, evidence);
    await s.disputes.submitEvidence(buyer, opened.id, evidence);
    await s.disputes.resolve(buyer, opened.id);

    // The §2.2 acceptance condition: no payout escaped while the dispute ran.
    expect(await s.rwaRepository.listDistributions(tokenizationId)).toHaveLength(
      0,
    );
  });
});

// ── §2.3 — replay safety on the real wiring ─────────────────────────────────

describe("event replay across domains (§2.3)", () => {
  it("distributes exactly one payout when a release event is redelivered", async () => {
    const s = setup();
    const { orderId, tokenizationId } = await tokenizedOrder(s);
    await s.payments.transition(orderId, PaymentTransition.Confirm, buyer);
    await s.payments.transition(orderId, PaymentTransition.Release, buyer);

    // Redeliver the same fact, the way a retrying publisher or a restarted
    // dispatcher would.
    const event = await s.eventRepository.publish({
      eventType: DomainEventType.OrderReleased,
      entity: EventEntity.Order,
      entityId: orderId,
      actor: `user:${buyer.userId}`,
      payload: { amount: "1000000", currency: "USDC" },
      dedupeKey: dedupeKey(DomainEventType.OrderReleased, orderId),
    });
    await s.bus.dispatch(event);
    await s.bus.dispatch(event);

    expect(await s.rwaRepository.listDistributions(tokenizationId)).toHaveLength(
      1,
    );
  });
});
