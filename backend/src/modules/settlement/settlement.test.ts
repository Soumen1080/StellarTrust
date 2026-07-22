import {
  ReconciliationStatus,
  RouteType,
  SettlementStatus,
  SettlementTransition,
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

describe("cross-border settlement happy path", () => {
  async function runCorridor() {
    const context = setup();
    const quote = await context.service.quote({
      sourceCurrency: "USD",
      destinationCurrency: "INR",
      sourceAmount: "100000", // 1,000.00 USD
    });
    const result = await context.service.execute(actor, {
      quoteId: quote.id,
      destinationReference: "beneficiary-abc-123",
    });
    return { ...context, quote, result };
  }

  it("settles deposit -> convert -> payout with balanced, linked records", async () => {
    const { quote, result, repository } = await runCorridor();

    expect(result.settlement.status).toBe(SettlementStatus.Completed);
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
    expect(deposit.anchorTransfer?.kind).toBe("deposit");
    expect(payout.anchorTransfer?.kind).toBe("withdrawal");
    expect(convert.stellarTransaction?.type).toContain("liquidity_");
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
    const quote = await context.service.quote({
      sourceCurrency: "USD",
      destinationCurrency: "EUR",
      sourceAmount: "50000",
    });
    const first = await context.service.execute(actor, {
      quoteId: quote.id,
      destinationReference: "beneficiary-1",
    });
    const second = await context.service.execute(actor, {
      quoteId: quote.id,
      destinationReference: "beneficiary-1",
    });
    expect(second.settlement.id).toBe(first.settlement.id);
    const transitions = await context.repository.listTransitions(
      first.settlement.id,
    );
    expect(transitions).toHaveLength(3);
  });
});

describe("settlement guards", () => {
  it("rejects an unsupported corridor at quote time", async () => {
    const { service } = setup();
    await expect(
      service.quote({
        sourceCurrency: "NGN",
        destinationCurrency: "XLM",
        sourceAmount: "1000",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects same-currency quotes", async () => {
    const { service } = setup();
    await expect(
      service.quote({
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
        destinationReference: "beneficiary-x",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("forbids another user from executing someone else's quote", async () => {
    const context = setup();
    const quote = await context.service.quote({
      sourceCurrency: "USD",
      destinationCurrency: "INR",
      sourceAmount: "100000",
    });
    await context.service.execute(actor, {
      quoteId: quote.id,
      destinationReference: "beneficiary-1",
    });
    await expect(
      context.service.execute(
        { userId: "intruder", roles: ["user"] },
        { quoteId: quote.id, destinationReference: "beneficiary-1" },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
