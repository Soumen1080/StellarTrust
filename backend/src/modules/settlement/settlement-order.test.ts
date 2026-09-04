/**
 * Settlement funding an escrow order (plane.md §2.1).
 *
 * Two domains that both moved money and had never heard of each other. A buyer
 * settling across a corridor to fund an escrow paid the corridor, watched the
 * money arrive, and then paid the escrow again — because nothing recorded that
 * the settlement was *for* the order.
 *
 * The link is a column plus one event: settlement publishes that it delivered,
 * and the payments subscriber drives the order's deposit. These tests exercise
 * the whole path, plus every way it is refused before money moves.
 */
import {
  PayoutRail,
  PaymentTransition,
  SettlementStatus,
  type PayoutDestinationInput,
} from "@stellartrust/shared";
import { describe, expect, it } from "vitest";
import { InMemoryAuditRepository } from "../audit/audit.repository.js";
import { DeterministicEscrowGateway } from "../escrow/escrow.gateway.js";
import { EventBus } from "../events/event.bus.js";
import { InMemoryEventRepository } from "../events/event.repository.js";
import { InMemoryLedgerRepository } from "../ledger/ledger.repository.js";
import { LedgerService } from "../ledger/ledger.service.js";
import { InMemoryPaymentRepository } from "../payments/payment.repository.js";
import { PaymentService } from "../payments/payment.service.js";
import { orderDepositOnSettlement } from "../payments/payment.subscribers.js";
import { SandboxAnchorGateway } from "./anchor.gateway.js";
import { DeterministicLiquidityGateway } from "./liquidity.gateway.js";
import { InMemorySettlementRepository } from "./settlement.repository.js";
import { SettlementService } from "./settlement.service.js";

const buyer = { userId: "buyer-1", roles: ["user"] };
const seller = { userId: "seller-1", roles: ["user"] };
const stranger = { userId: "stranger-1", roles: ["user"] };

const SEPA_DESTINATION: PayoutDestinationInput = {
  rail: PayoutRail.SepaInstant,
  fields: { iban: "DE89 3704 0044 0532 0130 00", accountHolder: "Lena Fischer" },
};

function setup() {
  const audit = new InMemoryAuditRepository();
  const bus = new EventBus(new InMemoryEventRepository(), undefined, {
    sleep: async () => {},
  });
  const paymentRepository = new InMemoryPaymentRepository();
  const payments = new PaymentService(
    paymentRepository,
    new DeterministicEscrowGateway(),
    audit,
    undefined,
    undefined,
    bus,
  );
  const settlementRepository = new InMemorySettlementRepository();
  const settlement = new SettlementService(
    settlementRepository,
    new DeterministicLiquidityGateway(),
    new SandboxAnchorGateway(),
    audit,
    { findOrder: (id: string) => paymentRepository.findOrder(id) },
    bus,
  );
  bus.subscribe(orderDepositOnSettlement(payments));

  // The ledger is not exercised here; settlement posts its own legs and the
  // escrow deposit posts through the payment repository.
  void new LedgerService(new InMemoryLedgerRepository());

  return {
    audit,
    bus,
    payments,
    paymentRepository,
    settlement,
    settlementRepository,
  };
}

/**
 * Quote a EUR corridor, then create an order for exactly what it will deliver.
 *
 * Quoting first is the only honest way to build the matching order: the net
 * amount is the route's output less the rail's flat fee, and hardcoding it here
 * would silently rot the moment either changes.
 */
async function quoteAndOrder(s: ReturnType<typeof setup>) {
  const quote = await s.settlement.quote(buyer, {
    sourceCurrency: "USD",
    destinationCurrency: "EUR",
    sourceAmount: "100000",
    payoutRail: PayoutRail.SepaInstant,
  });
  const created = await s.payments.createOrder(buyer.userId, {
    sellerId: seller.userId,
    amount: {
      amount: quote.netDestinationAmount.amount,
      currency: quote.netDestinationAmount.currency,
    },
  });
  await s.payments.transition(created.order.id, PaymentTransition.Accept, seller);
  return { quote, orderId: created.order.id };
}

describe("settlement funds an escrow order (§2.1)", () => {
  it("drives the order's deposit when the settlement completes", async () => {
    const s = setup();
    const { quote, orderId } = await quoteAndOrder(s);

    // Before: accepted, awaiting a deposit the buyer has not made.
    expect((await s.paymentRepository.findOrder(orderId))?.status).toBe(
      "accepted",
    );

    const result = await s.settlement.execute(buyer, {
      quoteId: quote.id,
      destination: SEPA_DESTINATION,
      orderId,
    });

    expect(result.settlement.status).toBe(SettlementStatus.Completed);
    expect(result.settlement.orderId).toBe(orderId);

    // After: the corridor's delivery *is* the deposit. The buyer paid once.
    const order = await s.paymentRepository.findOrder(orderId);
    expect(order?.status).toBe("deposited");
  });

  it("records the link so the two records point at each other", async () => {
    const s = setup();
    const { quote, orderId } = await quoteAndOrder(s);
    await s.settlement.execute(buyer, {
      quoteId: quote.id,
      destination: SEPA_DESTINATION,
      orderId,
    });

    const linked = await s.settlementRepository.findSettlementByOrder(orderId);
    expect(linked?.orderId).toBe(orderId);
  });

  it("leaves an ordinary settlement with no order untouched", async () => {
    const s = setup();
    const quote = await s.settlement.quote(buyer, {
      sourceCurrency: "USD",
      destinationCurrency: "EUR",
      sourceAmount: "100000",
      payoutRail: PayoutRail.SepaInstant,
    });

    const result = await s.settlement.execute(buyer, {
      quoteId: quote.id,
      destination: SEPA_DESTINATION,
    });

    expect(result.settlement.status).toBe(SettlementStatus.Completed);
    expect(result.settlement.orderId).toBeNull();
  });
});

describe("settlement/order funding is refused before money moves (§2.1)", () => {
  it("refuses when the credited amount does not equal the order amount", async () => {
    const s = setup();
    const quote = await s.settlement.quote(buyer, {
      sourceCurrency: "USD",
      destinationCurrency: "EUR",
      sourceAmount: "100000",
      payoutRail: PayoutRail.SepaInstant,
    });
    // One minor unit short of what the corridor will deliver.
    const created = await s.payments.createOrder(buyer.userId, {
      sellerId: seller.userId,
      amount: {
        amount: (BigInt(quote.netDestinationAmount.amount) + 1n).toString(),
        currency: quote.netDestinationAmount.currency,
      },
    });
    await s.payments.transition(created.order.id, PaymentTransition.Accept, seller);

    await expect(
      s.settlement.execute(buyer, {
        quoteId: quote.id,
        destination: SEPA_DESTINATION,
        orderId: created.order.id,
      }),
    ).rejects.toThrow(/requires exactly/i);

    // Nothing ran: no settlement exists, so no corridor money moved.
    expect(
      await s.settlementRepository.findSettlementByOrder(created.order.id),
    ).toBeUndefined();
    expect((await s.paymentRepository.findOrder(created.order.id))?.status).toBe(
      "accepted",
    );
  });

  it("refuses when the corridor delivers a different currency", async () => {
    const s = setup();
    const quote = await s.settlement.quote(buyer, {
      sourceCurrency: "USD",
      destinationCurrency: "EUR",
      sourceAmount: "100000",
      payoutRail: PayoutRail.SepaInstant,
    });
    const created = await s.payments.createOrder(buyer.userId, {
      sellerId: seller.userId,
      amount: { amount: quote.netDestinationAmount.amount, currency: "USDC" },
    });
    await s.payments.transition(created.order.id, PaymentTransition.Accept, seller);

    await expect(
      s.settlement.execute(buyer, {
        quoteId: quote.id,
        destination: SEPA_DESTINATION,
        orderId: created.order.id,
      }),
    ).rejects.toThrow(/denominated in/i);
  });

  it("refuses anyone but the buyer funding the order", async () => {
    const s = setup();
    const { orderId } = await quoteAndOrder(s);
    // A stranger's own quote, aimed at someone else's order.
    const theirQuote = await s.settlement.quote(stranger, {
      sourceCurrency: "USD",
      destinationCurrency: "EUR",
      sourceAmount: "100000",
      payoutRail: PayoutRail.SepaInstant,
    });

    await expect(
      s.settlement.execute(stranger, {
        quoteId: theirQuote.id,
        destination: SEPA_DESTINATION,
        orderId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a second settlement against an already-funded order", async () => {
    const s = setup();
    const { quote, orderId } = await quoteAndOrder(s);
    await s.settlement.execute(buyer, {
      quoteId: quote.id,
      destination: SEPA_DESTINATION,
      orderId,
    });

    const second = await s.settlement.quote(buyer, {
      sourceCurrency: "USD",
      destinationCurrency: "EUR",
      sourceAmount: "100000",
      payoutRail: PayoutRail.SepaInstant,
    });
    await expect(
      s.settlement.execute(buyer, {
        quoteId: second.id,
        destination: SEPA_DESTINATION,
        orderId,
      }),
    ).rejects.toThrow(/already funded/i);
  });

  it("refuses an order that does not exist", async () => {
    const s = setup();
    const quote = await s.settlement.quote(buyer, {
      sourceCurrency: "USD",
      destinationCurrency: "EUR",
      sourceAmount: "100000",
      payoutRail: PayoutRail.SepaInstant,
    });

    await expect(
      s.settlement.execute(buyer, {
        quoteId: quote.id,
        destination: SEPA_DESTINATION,
        orderId: "00000000-0000-4000-8000-000000000999",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
