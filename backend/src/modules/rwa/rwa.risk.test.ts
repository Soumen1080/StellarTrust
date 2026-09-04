/**
 * Risk surfacing (plane.md §3.4).
 *
 * The marketplace card used to advertise a unit price and nothing else: no
 * yield, no maturity, no issuer reputation, and no hint that the underlying
 * invoice was in dispute. The portfolio showed "total invested", which reads
 * like a balance and hides whether a position is late or has lost money.
 *
 * These cover the server-side computation. Doing it here rather than in the
 * client is what gives one definition of "days remaining" instead of one per
 * screen.
 */

import { KycStatus } from "@stellartrust/shared";
import { describe, expect, it } from "vitest";
import { InMemoryAuditRepository } from "../audit/audit.repository.js";
import { StaticWalletAddressResolver } from "../identity/wallet.resolver.js";
import { PrefundedLedgerService } from "../ledger/ledger.test-fixtures.js";
import { DeterministicRwaGateway } from "./rwa.gateway.js";
import { InMemoryRwaRepository } from "./rwa.repository.js";
import {
  RwaService,
  UNRESTRICTED_INVESTOR_LIMITS,
  type CounterpartyReputationReader,
  type DisputeReader,
  type RwaActor,
} from "./rwa.service.js";
import { TokenizationStatus } from "./rwa.types.js";
import { createVerifiedAsset } from "./rwa.test-fixtures.js";

const ISSUER_ADDRESS = "GBUV3T3YDFD232LUXGADFZV2XCMNEHXBMVTQPBD7DKHTP4Q6ZLNOSMEX";
const INVESTOR1_ADDRESS = "GDYWVMFH5JDIISEZMLDFTN6A5NHPLZGKTTYAAKGB5Z6U7MHKUV6JPVS5";

const issuer: RwaActor = { userId: "issuer-1", roles: ["user"] };
const investor: RwaActor = { userId: "investor-1", roles: ["user"] };

const DAY = 24 * 60 * 60 * 1000;

function setup(options?: {
  disputes?: DisputeReader;
  reputation?: CounterpartyReputationReader;
}) {
  const repository = new InMemoryRwaRepository();
  const service = new RwaService(
    repository,
    new DeterministicRwaGateway(),
    new InMemoryAuditRepository(),
    new PrefundedLedgerService(),
    new StaticWalletAddressResolver(new Map([["issuer-1", ISSUER_ADDRESS]])),
    options?.disputes,
    { getStatus: async () => ({ status: KycStatus.Verified }) },
    UNRESTRICTED_INVESTOR_LIMITS,
    options?.reputation,
  );
  return { repository, service };
}

/**
 * A deployed tokenization maturing in `days`, with a 10% discount at a 90%
 * advance — a payable set of terms that produces a non-zero yield to assert on.
 */
async function tokenizationMaturingIn(
  service: RwaService,
  days: number,
  overrides?: { linkedOrderId?: string },
) {
  const asset = await createVerifiedAsset(service, issuer.userId);
  const created = await service.createTokenization(issuer.userId, {
    assetId: asset.id,
    totalUnits: "1000",
    faceValueAmount: "1000000",
    faceValueCurrency: "USDC",
    advanceRateBps: 9_000,
    discountRateBps: 1_000,
    maturityDate: new Date(Date.now() + days * DAY).toISOString(),
    ...(overrides?.linkedOrderId
      ? { linkedOrderId: overrides.linkedOrderId }
      : {}),
  });
  return service.deployTokenization(created.id, issuer);
}

describe("tokenization risk on the details response", () => {
  it("carries the financing terms an investor is buying into", async () => {
    const { service } = setup();
    const tokenization = await tokenizationMaturingIn(service, 90);

    const { risk } = await service.getTokenizationDetails(tokenization.id);

    expect(risk.advanceRateBps).toBe(9_000);
    expect(risk.discountRateBps).toBe(1_000);
    expect(risk.maturityDate).toBe(tokenization.maturityDate);
    // 90 days out, allowing for the clock ticking between creation and read.
    expect(risk.daysRemaining).toBeGreaterThanOrEqual(89);
    expect(risk.daysRemaining).toBeLessThanOrEqual(90);
    expect(risk.overdue).toBe(false);
  });

  it("reports a projected yield the waterfall would actually pay", async () => {
    const { service } = setup();
    const tokenization = await tokenizationMaturingIn(service, 90);

    const { risk } = await service.getTokenizationDetails(tokenization.id);

    // Principal is 90% of 1,000,000 = 900,000; a 10% discount on that is
    // 90,000. Derived through the same function the waterfall uses, so the
    // number shown is the number that gets paid.
    expect(risk.projectedYieldAmount).toBe("90000");
  });

  it("goes negative and overdue once maturity passes", async () => {
    const { service, repository } = setup();
    const tokenization = await tokenizationMaturingIn(service, 90);

    // Backdate maturity rather than waiting: the sign of `daysRemaining` is
    // the signal, so it must not be clamped at zero.
    await repository.updateTokenization({
      ...tokenization,
      maturityDate: new Date(Date.now() - 5 * DAY).toISOString(),
    });

    const { risk } = await service.getTokenizationDetails(tokenization.id);
    expect(risk.daysRemaining).toBeLessThan(0);
    expect(risk.overdue).toBe(true);
  });

  it("is not overdue once collection has arrived, however late", async () => {
    const { service, repository } = setup();
    const tokenization = await tokenizationMaturingIn(service, 90);

    await repository.updateTokenization({
      ...tokenization,
      maturityDate: new Date(Date.now() - 30 * DAY).toISOString(),
      collectedAt: new Date(Date.now() - 1 * DAY).toISOString(),
    });

    // A position that collected late is closed, not outstanding.
    const { risk } = await service.getTokenizationDetails(tokenization.id);
    expect(risk.overdue).toBe(false);
  });

  it("surfaces a live dispute, not just the durable held status", async () => {
    const { service } = setup({
      disputes: { hasOpenDispute: async () => true },
    });
    const tokenization = await tokenizationMaturingIn(service, 90, {
      linkedOrderId: "order-1",
    });

    // The status is still Active — the dispute event has not been handled yet.
    // An investor about to buy needs to know about a dispute filed a moment
    // ago, not only one already processed.
    const { risk, tokenization: t } = await service.getTokenizationDetails(
      tokenization.id,
    );
    expect(t.status).toBe(TokenizationStatus.Active);
    expect(risk.disputed).toBe(true);
  });

  it("reports the held status as disputed even with no dispute reader", async () => {
    const { service, repository } = setup();
    const tokenization = await tokenizationMaturingIn(service, 90);
    await repository.updateTokenization({
      ...tokenization,
      status: TokenizationStatus.PayoutHeld,
    });

    const { risk } = await service.getTokenizationDetails(tokenization.id);
    expect(risk.disputed).toBe(true);
  });

  it("still answers when the dispute reader is down", async () => {
    const { service } = setup({
      disputes: {
        hasOpenDispute: async () => {
          throw new Error("dispute service unavailable");
        },
      },
    });
    const tokenization = await tokenizationMaturingIn(service, 90, {
      linkedOrderId: "order-1",
    });

    // A reader outage must not take down the marketplace; the payout path has
    // its own two independent checks (§2.2), and this one is for display.
    const { risk } = await service.getTokenizationDetails(tokenization.id);
    expect(risk.disputed).toBe(false);
  });

  it("carries the issuer's reputation and the asset's counterparty", async () => {
    const { service } = setup({ reputation: { getScore: async () => 81 } });
    const tokenization = await tokenizationMaturingIn(service, 90);

    const { risk } = await service.getTokenizationDetails(tokenization.id);
    expect(risk.issuerReputationScore).toBe(81);
    expect(risk.counterparty?.ref).toBe("counterparty:ACME-LTD");
  });

  it("leaves reputation null when nothing scores it", async () => {
    const { service } = setup();
    const tokenization = await tokenizationMaturingIn(service, 90);

    const { risk } = await service.getTokenizationDetails(tokenization.id);
    expect(risk.issuerReputationScore).toBeNull();
  });
});

describe("portfolio economics", () => {
  it("accrues yield pro-rata to units held", async () => {
    const { service } = setup();
    const tokenization = await tokenizationMaturingIn(service, 90);
    await service.purchaseUnits(tokenization.id, investor, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });

    const portfolio = await service.getInvestorPortfolio(investor.userId);

    // The whole issue yields 90,000; 100 of 1000 units is a tenth of it.
    expect(portfolio.holdings[0]?.position.accruedYield).toBe("9000");
    expect(portfolio.totalAccruedYield).toBe("9000");
  });

  it("stops accruing once the position has paid out", async () => {
    const { service, repository } = setup();
    const tokenization = await tokenizationMaturingIn(service, 90);
    await service.purchaseUnits(tokenization.id, investor, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });

    const current = await repository.findTokenization(tokenization.id);
    await repository.updateTokenization({
      ...current!,
      status: TokenizationStatus.Repaid,
    });

    // Once the payout has run, the payout record is the truth. Continuing to
    // show an accrual would double-count it.
    const portfolio = await service.getInvestorPortfolio(investor.userId);
    expect(portfolio.holdings[0]?.position.accruedYield).toBe("0");
  });

  it("counts overdue positions", async () => {
    const { service, repository } = setup();
    const tokenization = await tokenizationMaturingIn(service, 90);
    await service.purchaseUnits(tokenization.id, investor, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });

    const current = await repository.findTokenization(tokenization.id);
    await repository.updateTokenization({
      ...current!,
      maturityDate: new Date(Date.now() - 10 * DAY).toISOString(),
    });

    const portfolio = await service.getInvestorPortfolio(investor.userId);
    expect(portfolio.overdueCount).toBe(1);
    expect(portfolio.holdings[0]?.position.overdue).toBe(true);
  });

  it("reports a realized loss only once a position is written off", async () => {
    const { service, repository } = setup();
    const tokenization = await tokenizationMaturingIn(service, 90);
    await service.purchaseUnits(tokenization.id, investor, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });

    const current = await repository.findTokenization(tokenization.id);

    // Defaulted but not yet written off: the shortfall is a risk, not a loss,
    // and putting a number on the screen for it would not yet be true.
    await repository.updateTokenization({
      ...current!,
      status: TokenizationStatus.Defaulted,
    });
    let portfolio = await service.getInvestorPortfolio(investor.userId);
    expect(portfolio.totalRealizedLoss).toBe("0");

    await repository.updateTokenization({
      ...current!,
      status: TokenizationStatus.WrittenOff,
    });
    portfolio = await service.getInvestorPortfolio(investor.userId);

    // 100 units cost 90,000 (900,000 principal / 1000 units × 100), and
    // nothing came back.
    expect(portfolio.totalRealizedLoss).toBe("90000");
    expect(portfolio.holdings[0]?.position.realizedLoss).toBe("90000");
  });

  it("nets recovery against the loss", async () => {
    const { service, repository } = setup();
    const tokenization = await tokenizationMaturingIn(service, 90);
    await service.purchaseUnits(tokenization.id, investor, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });

    const current = await repository.findTokenization(tokenization.id);
    await repository.updateTokenization({
      ...current!,
      status: TokenizationStatus.Defaulted,
    });
    // A partial recovery, distributed through the real write-off path.
    await service.writeOffTokenization(tokenization.id, 30_000n, {
      userId: "compliance-1",
      roles: ["compliance"],
    });

    const portfolio = await service.getInvestorPortfolio(investor.userId);
    // Invested 90,000, recovered 30,000: the loss is what did not come back.
    expect(portfolio.holdings[0]?.position.payoutsReceived).toBe("30000");
    expect(portfolio.totalRealizedLoss).toBe("60000");
  });

  it("attributes payouts to the position that earned them", async () => {
    const { service } = setup();
    const first = await tokenizationMaturingIn(service, 90);
    const second = await tokenizationMaturingIn(service, 90);
    await service.purchaseUnits(first.id, investor, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });
    await service.purchaseUnits(second.id, investor, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });

    const portfolio = await service.getInvestorPortfolio(investor.userId);

    // A payout record points at a distribution, not a tokenization. Getting
    // that link wrong would credit one position with another's payouts.
    expect(portfolio.holdings).toHaveLength(2);
    for (const { position } of portfolio.holdings) {
      expect(position.payoutsReceived).toBe("0");
    }
  });
});
