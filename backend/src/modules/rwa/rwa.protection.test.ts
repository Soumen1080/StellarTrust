/**
 * Investor protection and compliance (plane.md §3.2).
 *
 * These approximate the controls a regulator would require, so the
 * architecture is shaped correctly. They are **not** legal compliance and must
 * not be described as such (plane.md §7).
 *
 * The plan asks for a test at each limit's boundary, which is where the bugs
 * are: a cap enforced with `>` instead of `>=` passes every test that only
 * checks a clearly-over case.
 */

import { KycStatus, RwaCustodyMode, RwaTransition } from "@stellartrust/shared";
import { describe, expect, it } from "vitest";
import { InMemoryAuditRepository } from "../audit/audit.repository.js";
import { StaticWalletAddressResolver } from "../identity/wallet.resolver.js";
import { isBalanced } from "../ledger/ledger.balance.js";
import { InMemoryLedgerRepository } from "../ledger/ledger.repository.js";
import { LedgerService } from "../ledger/ledger.service.js";
import { DeterministicRwaGateway } from "./rwa.gateway.js";
import { InMemoryRwaRepository } from "./rwa.repository.js";
import {
  RwaService,
  UNRESTRICTED_INVESTOR_LIMITS,
  type InvestorLimits,
  type RwaActor,
} from "./rwa.service.js";
import { TokenizationStatus } from "./rwa.types.js";
import { createVerifiedAsset } from "./rwa.test-fixtures.js";

const ISSUER_ADDRESS = "GBUV3T3YDFD232LUXGADFZV2XCMNEHXBMVTQPBD7DKHTP4Q6ZLNOSMEX";
const INVESTOR1_ADDRESS = "GDYWVMFH5JDIISEZMLDFTN6A5NHPLZGKTTYAAKGB5Z6U7MHKUV6JPVS5";
const INVESTOR2_ADDRESS = "GBNPF7BZKNCAS32XWOBWGL7KD6NFHLZO5GQDIJA7Z73B7YISNM4MFZNL";

const FUTURE_MATURITY = new Date(
  Date.now() + 90 * 24 * 60 * 60 * 1000,
).toISOString();

const issuer: RwaActor = { userId: "issuer-1", roles: ["user"] };
const investor: RwaActor = { userId: "investor-1", roles: ["user"] };
const investor2: RwaActor = { userId: "investor-2", roles: ["user"] };

/** A KYC reader that answers the same status for everyone. */
function kycAlways(status: KycStatus) {
  return { getStatus: async () => ({ status }) };
}

function setup(options?: {
  limits?: Partial<InvestorLimits>;
  kycStatus?: KycStatus;
}) {
  const repository = new InMemoryRwaRepository();
  const audit = new InMemoryAuditRepository();
  const ledger = new LedgerService(new InMemoryLedgerRepository());
  const service = new RwaService(
    repository,
    new DeterministicRwaGateway(),
    audit,
    ledger,
    new StaticWalletAddressResolver(new Map([["issuer-1", ISSUER_ADDRESS]])),
    undefined,
    kycAlways(options?.kycStatus ?? KycStatus.Verified),
    { ...UNRESTRICTED_INVESTOR_LIMITS, ...options?.limits },
  );
  return { repository, audit, ledger, service };
}

/**
 * A deployed tokenization of 1000 units at 1000 minor units each — so the
 * whole issue is 1,000,000 and a single unit costs 1000. Round numbers, so a
 * limit expressed in either units or money lands on a boundary exactly.
 */
async function activeTokenization(service: RwaService) {
  const asset = await createVerifiedAsset(service, issuer.userId);
  const tokenization = await service.createTokenization(issuer.userId, {
    assetId: asset.id,
    totalUnits: "1000",
    faceValueAmount: "1000000",
    faceValueCurrency: "USDC",
    advanceRateBps: 10_000,
    discountRateBps: 0,
    maturityDate: FUTURE_MATURITY,
  });
  return service.deployTokenization(tokenization.id, issuer);
}

describe("KYC gates an investment", () => {
  it("refuses a purchase from an unverified investor", async () => {
    const { service } = setup({ kycStatus: KycStatus.Pending });
    const tokenization = await activeTokenization(service);

    await expect(
      service.purchaseUnits(tokenization.id, investor, {
        units: "10",
        holderAddress: INVESTOR1_ADDRESS,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a purchase from an investor still under review", async () => {
    const { service } = setup({ kycStatus: KycStatus.UnderReview });
    const tokenization = await activeTokenization(service);

    await expect(
      service.purchaseUnits(tokenization.id, investor, {
        units: "10",
        holderAddress: INVESTOR1_ADDRESS,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("charges nobody when KYC refuses the purchase", async () => {
    const { service, ledger } = setup({ kycStatus: KycStatus.Rejected });
    const tokenization = await activeTokenization(service);

    await service
      .purchaseUnits(tokenization.id, investor, {
        units: "10",
        holderAddress: INVESTOR1_ADDRESS,
      })
      .catch(() => undefined);

    // Every limit runs before the ledger posting, so a refused purchase leaves
    // nothing to unwind.
    const posted = await ledger.getByReference(
      `rwa-subscription:${tokenization.id}:${investor.userId}:10`,
    );
    expect(posted).toBeUndefined();
  });

  it("lets a verified investor through", async () => {
    const { service } = setup({ kycStatus: KycStatus.Verified });
    const tokenization = await activeTokenization(service);

    const details = await service.purchaseUnits(tokenization.id, investor, {
      units: "10",
      holderAddress: INVESTOR1_ADDRESS,
    });
    expect(details.tokenization.unitsSold).toBe("10");
  });
});

describe("concentration limit", () => {
  it("allows a purchase exactly at the limit", async () => {
    const { service } = setup({ limits: { maxConcentrationBps: 2_500 } });
    const tokenization = await activeTokenization(service);

    // 250 of 1000 units is exactly 25%.
    const details = await service.purchaseUnits(tokenization.id, investor, {
      units: "250",
      holderAddress: INVESTOR1_ADDRESS,
    });
    expect(details.tokenization.unitsSold).toBe("250");
  });

  it("refuses the first unit over the limit", async () => {
    const { service } = setup({ limits: { maxConcentrationBps: 2_500 } });
    const tokenization = await activeTokenization(service);

    await expect(
      service.purchaseUnits(tokenization.id, investor, {
        units: "251",
        holderAddress: INVESTOR1_ADDRESS,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("applies a limit that does not divide evenly without rounding in the investor's favour", async () => {
    // 3333 bps of 1000 units is 333.3 units. The cap is 333, and 334 must be
    // refused — an integer division done in the wrong order would allow it.
    const { service } = setup({ limits: { maxConcentrationBps: 3_333 } });
    const tokenization = await activeTokenization(service);

    await expect(
      service.purchaseUnits(tokenization.id, investor, {
        units: "334",
        holderAddress: INVESTOR1_ADDRESS,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    const details = await service.purchaseUnits(tokenization.id, investor, {
      units: "333",
      holderAddress: INVESTOR1_ADDRESS,
    });
    expect(details.tokenization.unitsSold).toBe("333");
  });

  it("limits each investor separately rather than in aggregate", async () => {
    const { service } = setup({ limits: { maxConcentrationBps: 2_500 } });
    const tokenization = await activeTokenization(service);

    await service.purchaseUnits(tokenization.id, investor, {
      units: "250",
      holderAddress: INVESTOR1_ADDRESS,
    });
    // A concentration limit caps one holder's share, not the issue's take-up.
    const details = await service.purchaseUnits(tokenization.id, investor2, {
      units: "250",
      holderAddress: INVESTOR2_ADDRESS,
    });
    expect(details.tokenization.unitsSold).toBe("500");
  });
});

describe("exposure cap", () => {
  it("allows a purchase that lands exactly on the cap", async () => {
    // Two 100-unit purchases at 1000 each: 200,000 in total.
    const { service } = setup({ limits: { maxExposure: 200_000n } });
    const first = await activeTokenization(service);
    const second = await activeTokenization(service);

    await service.purchaseUnits(first.id, investor, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });
    const details = await service.purchaseUnits(second.id, investor, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });
    expect(details.tokenization.unitsSold).toBe("100");
  });

  it("refuses the purchase that would cross the cap", async () => {
    const { service } = setup({ limits: { maxExposure: 200_000n } });
    const first = await activeTokenization(service);
    const second = await activeTokenization(service);

    await service.purchaseUnits(first.id, investor, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });
    await expect(
      service.purchaseUnits(second.id, investor, {
        units: "101",
        holderAddress: INVESTOR1_ADDRESS,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("counts exposure per investor, not across the platform", async () => {
    const { service } = setup({ limits: { maxExposure: 100_000n } });
    const tokenization = await activeTokenization(service);

    await service.purchaseUnits(tokenization.id, investor, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });
    // The first investor is now at their cap; the second is unaffected.
    const details = await service.purchaseUnits(tokenization.id, investor2, {
      units: "100",
      holderAddress: INVESTOR2_ADDRESS,
    });
    expect(details.tokenization.unitsSold).toBe("200");
  });
});

describe("minimum ticket and unit granularity", () => {
  it("allows a purchase exactly at the minimum ticket", async () => {
    // 10 units at 1000 each = 10,000.
    const { service } = setup({ limits: { minTicketAmount: 10_000n } });
    const tokenization = await activeTokenization(service);

    const details = await service.purchaseUnits(tokenization.id, investor, {
      units: "10",
      holderAddress: INVESTOR1_ADDRESS,
    });
    expect(details.tokenization.unitsSold).toBe("10");
  });

  it("refuses a purchase one minor unit below the minimum", async () => {
    const { service } = setup({ limits: { minTicketAmount: 10_001n } });
    const tokenization = await activeTokenization(service);

    await expect(
      service.purchaseUnits(tokenization.id, investor, {
        units: "10",
        holderAddress: INVESTOR1_ADDRESS,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("refuses units that are not a whole multiple of the granularity", async () => {
    const { service } = setup({ limits: { unitGranularity: 25n } });
    const tokenization = await activeTokenization(service);

    await expect(
      service.purchaseUnits(tokenization.id, investor, {
        units: "30",
        holderAddress: INVESTOR1_ADDRESS,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    const details = await service.purchaseUnits(tokenization.id, investor, {
      units: "50",
      holderAddress: INVESTOR1_ADDRESS,
    });
    expect(details.tokenization.unitsSold).toBe("50");
  });
});

/**
 * The cooling-off window (plane.md §3.2).
 *
 * Run under ISSUER custody, because that is the arrangement in which a
 * cancellation is reachable at all. The token contract's `transfer` calls
 * `from.require_auth()`, so units already delivered to an investor can only be
 * moved back by that investor — no custody mode gives the platform their key.
 * Under issuer custody a purchase writes the holding and waits for the
 * issuer's signature before delivering, so the window covers exactly the
 * period in which the units have not yet moved.
 */
describe("cooling-off cancellation", () => {
  function issuerCustodySetup(limits?: Partial<InvestorLimits>) {
    const repository = new InMemoryRwaRepository();
    const addresses = new StaticWalletAddressResolver(
      new Map([["issuer-1", ISSUER_ADDRESS]]),
    );
    const ledger = new LedgerService(new InMemoryLedgerRepository());
    const service = new RwaService(
      repository,
      new DeterministicRwaGateway(RwaCustodyMode.Issuer, addresses),
      new InMemoryAuditRepository(),
      ledger,
      addresses,
      undefined,
      kycAlways(KycStatus.Verified),
      { ...UNRESTRICTED_INVESTOR_LIMITS, coolingOffHours: 24, ...limits },
    );
    return { repository, ledger, service };
  }

  /** A deployed tokenization, via the issuer's wallet round-trip. */
  async function deployed(service: RwaService, totalUnits = "1000") {
    const asset = await createVerifiedAsset(service, issuer.userId);
    const draft = await service.createTokenization(issuer.userId, {
      assetId: asset.id,
      totalUnits,
      faceValueAmount: String(BigInt(totalUnits) * 1000n),
      faceValueCurrency: "USDC",
      advanceRateBps: 10_000,
      discountRateBps: 0,
      maturityDate: FUTURE_MATURITY,
    });
    const prepared = await service.prepareOperation(
      draft.id,
      RwaTransition.Deploy,
      issuer,
    );
    await service.submitSignedOperation(
      draft.id,
      RwaTransition.Deploy,
      issuer,
      `signed:${prepared.unsignedXdr}`,
    );
    return draft;
  }

  it("unwinds a purchase inside the window and returns the units", async () => {
    const { service, repository } = issuerCustodySetup();
    const tokenization = await deployed(service);
    await service.purchaseUnits(tokenization.id, investor, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });

    const details = await service.cancelPurchase(tokenization.id, investor);

    expect(details.tokenization.unitsSold).toBe("0");
    expect(
      await repository.findHolding(tokenization.id, investor.userId),
    ).toBeUndefined();
  });

  it("posts a balanced reversal rather than deleting the original posting", async () => {
    const { service, ledger } = issuerCustodySetup();
    const tokenization = await deployed(service);
    await service.purchaseUnits(tokenization.id, investor, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });

    await service.cancelPurchase(tokenization.id, investor);

    // The ledger is append-only and is the system of record (Golden Rule #1):
    // an unwound subscription is two facts, not the absence of one.
    const subscription = await ledger.getByReference(
      `rwa-subscription:${tokenization.id}:${investor.userId}:100`,
    );
    const reversal = await ledger.getByReference(
      `rwa-cancellation:${tokenization.id}:${investor.userId}:100`,
    );
    expect(subscription).toBeDefined();
    expect(reversal).toBeDefined();
  });

  it("nets the two postings to nothing on every account they touch", async () => {
    // A non-zero discount, so the three-leg posting is exercised rather than
    // the degenerate two-leg one.
    const { service, ledger } = issuerCustodySetup();
    const asset = await createVerifiedAsset(service, issuer.userId);
    const draft = await service.createTokenization(issuer.userId, {
      assetId: asset.id,
      totalUnits: "1000",
      faceValueAmount: "1000000",
      faceValueCurrency: "USDC",
      // 90% advance leaves room for the 5% discount inside the face value;
      // a 100% advance plus a yield is refused as unpayable, which is the
      // financing model doing its job.
      advanceRateBps: 9_000,
      discountRateBps: 500,
      maturityDate: FUTURE_MATURITY,
    });
    const prepared = await service.prepareOperation(
      draft.id,
      RwaTransition.Deploy,
      issuer,
    );
    await service.submitSignedOperation(
      draft.id,
      RwaTransition.Deploy,
      issuer,
      `signed:${prepared.unsignedXdr}`,
    );

    await service.purchaseUnits(draft.id, investor, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });
    await service.cancelPurchase(draft.id, investor);

    const subscription = await ledger.getByReference(
      `rwa-subscription:${draft.id}:${investor.userId}:100`,
    );
    const reversal = await ledger.getByReference(
      `rwa-cancellation:${draft.id}:${investor.userId}:100`,
    );

    expect(isBalanced(subscription!.entries)).toBe(true);
    expect(isBalanced(reversal!.entries)).toBe(true);

    // Sum every entry across both transactions per account, a credit counting
    // negative. Any account left moved would mean money stranded in the
    // platform after a cancellation that is supposed to be a no-op.
    const net = new Map<string, bigint>();
    for (const entry of [...subscription!.entries, ...reversal!.entries]) {
      const signed =
        entry.direction === "debit"
          ? BigInt(entry.amount)
          : -BigInt(entry.amount);
      net.set(entry.accountId, (net.get(entry.accountId) ?? 0n) + signed);
    }
    expect(net.size).toBe(3);
    for (const [, amount] of net) {
      expect(amount).toBe(0n);
    }
  });

  it("refuses a cancellation after the window has closed", async () => {
    const { service } = issuerCustodySetup();
    const tokenization = await deployed(service);
    await service.purchaseUnits(tokenization.id, investor, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });

    // 24h and one second later. After the window the position is a real
    // investment; the exit is the secondary market, not a refund.
    const after = new Date(Date.now() + 24 * 60 * 60 * 1000 + 1000);
    await expect(
      service.cancelPurchase(tokenization.id, investor, after),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("allows a cancellation at the last moment of the window", async () => {
    const { service } = issuerCustodySetup();
    const tokenization = await deployed(service);
    await service.purchaseUnits(tokenization.id, investor, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });

    const atDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000 - 1000);
    const details = await service.cancelPurchase(
      tokenization.id,
      investor,
      atDeadline,
    );
    expect(details.tokenization.unitsSold).toBe("0");
  });

  it("refuses when the window is disabled", async () => {
    const { service } = issuerCustodySetup({ coolingOffHours: 0 });
    const tokenization = await deployed(service);
    await service.purchaseUnits(tokenization.id, investor, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });

    await expect(
      service.cancelPurchase(tokenization.id, investor),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses once the units have been delivered on-chain", async () => {
    // Platform custody settles the transfer inline, so the units are already
    // the investor's and only they can send them back. The refusal is the
    // contract's `from.require_auth()`, not a policy choice.
    const { service } = setup({ limits: { coolingOffHours: 24 } });
    const tokenization = await activeTokenization(service);
    await service.purchaseUnits(tokenization.id, investor, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });

    await expect(
      service.cancelPurchase(tokenization.id, investor),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a cancellation once the position has collected", async () => {
    const { service, repository } = issuerCustodySetup();
    const tokenization = await deployed(service);
    await service.purchaseUnits(tokenization.id, investor, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });

    const current = await repository.findTokenization(tokenization.id);
    await repository.updateTokenization({
      ...current!,
      status: TokenizationStatus.Distributed,
    });

    // The money has left. Refunding the subscription as well would pay the
    // investor twice.
    await expect(
      service.cancelPurchase(tokenization.id, investor),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("re-opens a fully funded tokenization when units come back", async () => {
    const { service, repository } = issuerCustodySetup();
    const tokenization = await deployed(service, "100");

    // Buying the whole issue funds it.
    await service.purchaseUnits(tokenization.id, investor, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });
    expect((await repository.findTokenization(tokenization.id))?.status).toBe(
      TokenizationStatus.Funded,
    );

    await service.cancelPurchase(tokenization.id, investor);

    // A tokenization left `funded` with units unsold could never be bought
    // into again: `purchaseUnits` refuses anything that is not `active`.
    expect((await repository.findTokenization(tokenization.id))?.status).toBe(
      TokenizationStatus.Active,
    );
  });

  it("refuses to cancel when there is nothing held", async () => {
    const { service } = issuerCustodySetup();
    const tokenization = await deployed(service);

    await expect(
      service.cancelPurchase(tokenization.id, investor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("unrestricted defaults", () => {
  it("applies no limits when none are wired", async () => {
    const { service } = setup();
    const tokenization = await activeTokenization(service);

    // The whole issue to one investor: every limit off, which is what keeps
    // the constructions that predate §3.2 behaving as their tests assert.
    const details = await service.purchaseUnits(tokenization.id, investor, {
      units: "1000",
      holderAddress: INVESTOR1_ADDRESS,
    });
    expect(details.tokenization.unitsSold).toBe("1000");
  });
});
