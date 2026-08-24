import {
  PayoutRail,
  ReconciliationStatus,
  RouteType,
  SettlementStatus,
  SettlementTransition,
  type PayoutDestinationInput,
  type SettlementTransitionDTO,
} from "@stellartrust/shared";
import { describe, expect, it } from "vitest";
import { InMemoryAuditRepository } from "../audit/audit.repository.js";
import { isBalanced } from "../ledger/ledger.balance.js";
import { SandboxAnchorGateway } from "./anchor.gateway.js";
import {
  convertMinorUnits,
  DeterministicLiquidityGateway,
} from "./liquidity.gateway.js";
import { RoutingService } from "./routing.service.js";
import { InMemorySettlementRepository } from "./settlement.repository.js";
import { SettlementReconciliationJob } from "./settlement.reconciliation.job.js";
import { SettlementService } from "./settlement.service.js";

function setup() {
  const repository = new InMemorySettlementRepository();
  const liquidity = new DeterministicLiquidityGateway();
  const anchor = new SandboxAnchorGateway();
  const audit = new InMemoryAuditRepository();
  const service = new SettlementService(repository, liquidity, anchor, audit);
  const reconciliation = new SettlementReconciliationJob(
    repository,
    anchor,
    60_000,
  );
  return { repository, liquidity, anchor, audit, service, reconciliation };
}

const actor = { userId: "user-1", roles: ["user"] };

/** Real-format beneficiary handles: each passes its scheme's own checksum. */
const UPI_DESTINATION: PayoutDestinationInput = {
  rail: PayoutRail.Upi,
  fields: { upiId: "priya@okhdfcbank", accountHolder: "Priya Sharma" },
  reference: "invoice-4471",
};

const SEPA_DESTINATION: PayoutDestinationInput = {
  rail: PayoutRail.SepaInstant,
  fields: { iban: "DE89 3704 0044 0532 0130 00", accountHolder: "Lena Fischer" },
};

function expectLinkedAndBalanced(transitions: SettlementTransitionDTO[]) {
  for (const transition of transitions) {
    expect(isBalanced(transition.ledgerTransaction.entries)).toBe(true);
    const external =
      transition.anchorTransfer?.reference ??
      transition.stellarTransaction?.hash;
    expect(external).toBeTruthy();
    if (transition.stellarTransaction) {
      expect(transition.stellarTransaction.ledgerTransactionId).toBe(
        transition.ledgerTransaction.id,
      );
    }
  }
}

describe("liquidity conversion math", () => {
  it("converts USD minor units to INR at the deterministic mid-market rate", () => {
    // 100.00 USD (10000 minor) -> INR at 1 USD = 83 INR -> 8300.00 INR (830000 minor).
    expect(convertMinorUnits(10_000n, "USD", "INR").toString()).toBe("830000");
  });

  it("accounts for differing minor-unit scales (USD 2dp -> USDC 7dp)", () => {
    // 1.00 USD -> 1.0000000 USDC.
    expect(convertMinorUnits(100n, "USD", "USDC").toString()).toBe("10000000");
  });
});

describe("routing", () => {
  it("selects the path-payment route over the AMM route on net output", async () => {
    const liquidity = new DeterministicLiquidityGateway();
    const routes = await liquidity.quoteRoutes("USD", "INR", "100000");
    const { best, ranked } = new RoutingService().select(routes, {
      maxSlippageBps: 100,
    });
    expect(best.type).toBe(RouteType.PathPayment);
    expect(ranked).toHaveLength(2);
    // Best route delivers at least as much as every other candidate.
    for (const route of ranked) {
      expect(BigInt(best.destinationAmount.amount)).toBeGreaterThanOrEqual(
        BigInt(route.destinationAmount.amount),
      );
    }
  });

  it("rejects when no route satisfies the slippage limit", async () => {
    const liquidity = new DeterministicLiquidityGateway();
    const routes = await liquidity.quoteRoutes("USD", "INR", "100000");
    expect(() =>
      new RoutingService().select(routes, { maxSlippageBps: 1 }),
    ).toThrowError(/slippage/i);
  });

  it("rejects when no route satisfies the fee limit", async () => {
    const liquidity = new DeterministicLiquidityGateway();
    const routes = await liquidity.quoteRoutes("USD", "INR", "100000");
    expect(() =>
      new RoutingService().select(routes, {
        maxSlippageBps: 100,
        maxFeeAmount: "1",
      }),
    ).toThrowError();
  });
});

describe("corridor catalog", () => {
  it("offers India's local rails on a USD -> INR corridor", async () => {
    const { service } = setup();
    const quote = await service.quote(actor, {
      sourceCurrency: "USD",
      destinationCurrency: "INR",
      sourceAmount: "10000",
    });
    // UPI is the fastest INR rail, so it is the default when none is chosen.
    expect(quote.payoutRail).toBe(PayoutRail.Upi);
  });

  it("prices the rail fee into the quote's net receivable", async () => {
    const { service } = setup();
    const quote = await service.quote(actor, {
      sourceCurrency: "USD",
      destinationCurrency: "INR",
      sourceAmount: "10000",
      payoutRail: PayoutRail.Imps,
    });
    // IMPS charges a flat INR 5.00; the beneficiary receives the remainder.
    expect(quote.payoutFee.amount).toBe("500");
    expect(BigInt(quote.netDestinationAmount.amount)).toBe(
      BigInt(quote.route.destinationAmount.amount) - 500n,
    );
    expect(quote.totalEstimatedSeconds).toBe(
      quote.route.estimatedSeconds + 30,
    );
  });

  it("rejects a rail that does not clear the destination currency", async () => {
    const { service } = setup();
    await expect(
      service.quote(actor, {
        sourceCurrency: "USD",
        destinationCurrency: "INR",
        sourceAmount: "10000",
        payoutRail: PayoutRail.SepaInstant,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("rail limits", () => {
  it("refuses a UPI payout above the NPCI per-transaction cap", async () => {
    const { service } = setup();
    // ~2,000 USD converts to ~1.66 lakh INR, over UPI's INR 1,00,000 cap.
    await expect(
      service.quote(actor, {
        sourceCurrency: "USD",
        destinationCurrency: "INR",
        sourceAmount: "200000",
        payoutRail: PayoutRail.Upi,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("names a rail on the same corridor that can carry the amount", async () => {
    const { service } = setup();
    await expect(
      service.quote(actor, {
        sourceCurrency: "USD",
        destinationCurrency: "INR",
        sourceAmount: "200000",
        payoutRail: PayoutRail.Upi,
      }),
    ).rejects.toMatchObject({
      details: [{ path: "payoutRail", message: expect.stringContaining("IMPS") }],
    });
  });

  it("accepts the same amount on IMPS, whose cap is five times higher", async () => {
    const { service } = setup();
    const quote = await service.quote(actor, {
      sourceCurrency: "USD",
      destinationCurrency: "INR",
      sourceAmount: "200000",
      payoutRail: PayoutRail.Imps,
    });
    expect(BigInt(quote.netDestinationAmount.amount)).toBeGreaterThan(
      10_000_000n,
    );
  });

  it("refuses an amount the rail fee would consume entirely", async () => {
    const { service } = setup();
    // 0.01 USD converts to well under the NGN 50.00 NIP fee.
    await expect(
      service.quote(actor, {
        sourceCurrency: "USD",
        destinationCurrency: "NGN",
        sourceAmount: "1",
        payoutRail: PayoutRail.Nip,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("cross-border settlement happy path", () => {
  async function runCorridor() {
    const context = setup();
    const quote = await context.service.quote(actor, {
      sourceCurrency: "USD",
      destinationCurrency: "INR",
      sourceAmount: "100000", // 1,000.00 USD
      payoutRail: PayoutRail.Imps,
    });
    const result = await context.service.execute(actor, {
      quoteId: quote.id,
      destination: {
        rail: PayoutRail.Imps,
        fields: {
          accountNumber: "50100123456789",
          ifsc: "hdfc0001234",
          accountHolder: "Priya Sharma",
        },
        reference: "invoice-4471",
      },
    });
    return { ...context, quote, result };
  }

  it("settles deposit -> convert -> payout with balanced, linked records", async () => {
    const { quote, result, repository } = await runCorridor();

    expect(result.settlement.status).toBe(SettlementStatus.Completed);
    expect(result.settlement.completedAt).not.toBeNull();
    expect(result.settlement.source.currency).toBe("USD");
    expect(result.settlement.destination.currency).toBe("INR");
    // Destination amount matches the quoted route.
    expect(result.settlement.destination.amount).toBe(
      quote.route.destinationAmount.amount,
    );

    const transitions = await repository.listTransitions(result.settlement.id);
    expect(transitions.map((item) => item.transition)).toEqual([
      SettlementTransition.Deposit,
      SettlementTransition.Convert,
      SettlementTransition.Payout,
    ]);
    expectLinkedAndBalanced(transitions);

    // Deposit + payout carry anchor transfers; convert carries a chain record.
    const [deposit, convert, payout] = transitions;
    expect(deposit?.anchorTransfer?.kind).toBe("deposit");
    expect(payout?.anchorTransfer?.kind).toBe("withdrawal");
    expect(convert?.stellarTransaction?.type).toContain("liquidity_");
  });

  it("pays the anchor the net amount and books the rail fee as revenue", async () => {
    const { result, repository } = await runCorridor();
    const payout = result.settlement.payout;

    const transitions = await repository.listTransitions(result.settlement.id);
    const payoutLeg = transitions.find(
      (item) => item.transition === SettlementTransition.Payout,
    );
    // The beneficiary is promised the net amount, so that is what the anchor
    // is instructed to pay — not the gross converted amount.
    expect(payoutLeg?.anchorTransfer?.amount).toBe(payout.netAmount.amount);
    expect(payoutLeg?.anchorTransfer?.payoutRail).toBe(PayoutRail.Imps);
    expect(payoutLeg?.anchorTransfer?.destinationFingerprint).toBe(
      payout.destination.fingerprint,
    );

    // The leg discharges the full liability: net out + fee retained.
    const entries = payoutLeg?.ledgerTransaction.entries ?? [];
    expect(entries).toHaveLength(3);
    const debit = entries.find((entry) => entry.direction === "debit");
    expect(BigInt(debit?.amount ?? "0")).toBe(
      BigInt(payout.netAmount.amount) + BigInt(payout.fee.amount),
    );
  });

  it("stores only a masked beneficiary, never the account number", async () => {
    const { result } = await runCorridor();
    const destination = result.settlement.payout.destination;

    expect(destination.masked).toContain("6789"); // last four only
    expect(destination.masked).not.toContain("50100123456789");
    expect(destination.masked).toContain("HDFC0001234"); // IFSC is not secret
    expect(destination.holderMasked).toBe("P. S.");
    expect(destination.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // The whole snapshot is checked, because the handle must not survive
    // anywhere in it — not in the memo, not in the route.
    expect(JSON.stringify(result.settlement)).not.toContain("50100123456789");
  });

  it("reports zero unresolved reconciliation mismatches", async () => {
    const { result, reconciliation } = await runCorridor();
    const report = await reconciliation.run();
    expect(report.status).toBe(ReconciliationStatus.Matched);
    expect(report.checked).toBe(3);
    expect(report.matched).toBe(3);
    expect(report.unresolved).toBe(0);
    expect(result.settlement.status).toBe(SettlementStatus.Completed);
  });

  it("is idempotent: re-executing a quote returns the same settlement", async () => {
    const context = setup();
    const quote = await context.service.quote(actor, {
      sourceCurrency: "USD",
      destinationCurrency: "EUR",
      sourceAmount: "50000",
      payoutRail: PayoutRail.SepaInstant,
    });
    const first = await context.service.execute(actor, {
      quoteId: quote.id,
      destination: SEPA_DESTINATION,
    });
    const second = await context.service.execute(actor, {
      quoteId: quote.id,
      destination: SEPA_DESTINATION,
    });
    expect(second.settlement.id).toBe(first.settlement.id);
    const transitions = await context.repository.listTransitions(
      first.settlement.id,
    );
    expect(transitions).toHaveLength(3);
  });

  it("persists the request before the legs run", async () => {
    const context = setup();
    const quote = await context.service.quote(actor, {
      sourceCurrency: "USD",
      destinationCurrency: "INR",
      sourceAmount: "10000",
    });
    const { settlement } = await context.service.execute(actor, {
      quoteId: quote.id,
      destination: UPI_DESTINATION,
    });
    // Both the audit trail and the store carry the request, not just the
    // completion — a settlement that dies mid-flight is still findable.
    const events = await context.audit.listForEntity(
      "settlement",
      settlement.id,
    );
    expect(events.map((event) => event.action)).toEqual(
      expect.arrayContaining(["settlement.requested", "settlement.completed"]),
    );
    const stored = await context.repository.listSettlements(actor.userId);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.quoteId).toBe(quote.id);
  });
});

describe("settlement guards", () => {
  it("rejects an unsupported corridor at quote time", async () => {
    const { service } = setup();
    await expect(
      service.quote(actor, {
        sourceCurrency: "NGN",
        destinationCurrency: "XLM",
        sourceAmount: "1000",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects same-currency quotes", async () => {
    const { service } = setup();
    await expect(
      service.quote(actor, {
        sourceCurrency: "USD",
        destinationCurrency: "USD",
        sourceAmount: "1000",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects executing an unknown quote", async () => {
    const { service } = setup();
    await expect(
      service.execute(actor, {
        quoteId: "00000000-0000-4000-8000-000000000000",
        destination: UPI_DESTINATION,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("forbids another user from executing someone else's quote", async () => {
    const context = setup();
    const quote = await context.service.quote(actor, {
      sourceCurrency: "USD",
      destinationCurrency: "INR",
      sourceAmount: "100000",
      payoutRail: PayoutRail.Imps,
    });
    // The intruder is refused before any settlement exists: a quote fixes a
    // rate for its requester alone.
    await expect(
      context.service.execute(
        { userId: "intruder", roles: ["user"] },
        {
          quoteId: quote.id,
          destination: {
            rail: PayoutRail.Imps,
            fields: {
              accountNumber: "50100123456789",
              ifsc: "HDFC0001234",
              accountHolder: "Someone Else",
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a beneficiary handle for a rail the quote was not priced for", async () => {
    const context = setup();
    const quote = await context.service.quote(actor, {
      sourceCurrency: "USD",
      destinationCurrency: "INR",
      sourceAmount: "10000",
      payoutRail: PayoutRail.Upi,
    });
    await expect(
      context.service.execute(actor, {
        quoteId: quote.id,
        destination: {
          rail: PayoutRail.Imps,
          fields: {
            accountNumber: "50100123456789",
            ifsc: "HDFC0001234",
            accountHolder: "Priya Sharma",
          },
        },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("refuses a malformed beneficiary handle before any money moves", async () => {
    const context = setup();
    const quote = await context.service.quote(actor, {
      sourceCurrency: "USD",
      destinationCurrency: "INR",
      sourceAmount: "10000",
    });
    await expect(
      context.service.execute(actor, {
        quoteId: quote.id,
        destination: {
          rail: PayoutRail.Upi,
          fields: { upiId: "not-a-vpa", accountHolder: "Priya Sharma" },
        },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    // Nothing was recorded: the guard runs before the first leg.
    expect(await context.repository.listSettlements(actor.userId)).toHaveLength(
      0,
    );
    expect(await context.repository.listTransitions()).toHaveLength(0);
  });
});
