/**
 * Shared RWA test fixtures.
 *
 * Only a *verified* asset may be tokenized (plane.md §3.1), and verification is
 * a three-step workflow: attach documents, submit for review, and have
 * compliance decide. Every test that needs a tokenization needs an asset that
 * has been through it.
 *
 * This helper walks the real workflow rather than reaching past it into the
 * repository. That is the whole point: a fixture that wrote
 * `verificationStatus: "verified"` directly would keep the tests green while
 * the gate itself rotted, and the suite's value is that it says something
 * about what production does.
 */

import { EntryDirection, type CurrencyCode } from "@stellartrust/shared";
import type { LedgerService } from "../ledger/ledger.service.js";
import { CASH_CLEARING } from "../ledger/system-accounts.js";
import type { RwaActor, RwaService } from "./rwa.service.js";
import { AssetType } from "./rwa.types.js";
import type { AssetDTO, CreateAssetInput } from "./rwa.types.js";

/** A compliance actor, since only compliance may decide a review. */
export const COMPLIANCE: RwaActor = {
  userId: "compliance-1",
  roles: ["user", "compliance"],
};

/**
 * Create an asset and carry it through to `Verified`.
 *
 * Defaults describe the ordinary case — an invoice with one supporting
 * document and a named debtor — because that is what the majority of tests
 * need in order to get to the behaviour they are actually asserting.
 */
export async function createVerifiedAsset(
  service: RwaService,
  ownerUserId: string,
  overrides?: Partial<CreateAssetInput>,
): Promise<AssetDTO> {
  const owner: RwaActor = { userId: ownerUserId, roles: ["user"] };

  const asset = await service.createAsset(ownerUserId, {
    assetType: AssetType.Invoice,
    // Unique by default: the double-pledge guard refuses a second live
    // tokenization of the same reference, so fixtures that shared one would
    // collide with each other rather than with the case under test.
    assetRef: `invoice:INV-${Math.random().toString(36).slice(2, 10)}`,
    description: "90-day receivable",
    valuationAmount: "1000000",
    valuationCurrency: "USDC",
    documents: [
      {
        docRef: "s3://docs/invoice.pdf",
        docType: "invoice",
        sha256: "a".repeat(64),
      },
    ],
    counterparty: { ref: "counterparty:ACME-LTD", name: "Acme Ltd" },
    ...overrides,
  });

  await service.submitAssetForReview(asset.id, owner);
  return service.reviewAsset(asset.id, COMPLIANCE, { decision: "verify" });
}

/**
 * Give an investor a spendable balance.
 *
 * Since plane.md §4.5, `purchaseUnits` refuses an investor who cannot pay —
 * which is the point, and which means every test that buys units needs the
 * buyer funded first. This posts the same two legs a real deposit posts
 * (`TreasuryService.claimDeposit`): debit the platform's cash clearing
 * account, credit the user's own account.
 *
 * It goes through `LedgerService.record` rather than writing a balance
 * directly, for the same reason `createVerifiedAsset` walks the real
 * verification workflow: a fixture that fabricated a balance would keep the
 * tests green while the funding path rotted, and the suite's value is that it
 * says something about what production does.
 *
 * The reference id carries a nonce because one test may fund the same investor
 * several times, and the ledger — correctly — refuses to post the same
 * reference twice.
 */
let fundingNonce = 0;
export async function fundInvestor(
  ledger: LedgerService,
  userId: string,
  amount: string,
  currency: CurrencyCode = "USDC" as CurrencyCode,
): Promise<void> {
  fundingNonce += 1;
  await ledger.record({
    referenceId: `test-funding:${userId}:${currency}:${fundingNonce}`,
    description: `Test funding for ${userId}`,
    entries: [
      {
        accountId: CASH_CLEARING,
        direction: EntryDirection.Debit,
        amount,
        currency,
      },
      {
        accountId: ledger.userAccount(userId),
        direction: EntryDirection.Credit,
        amount,
        currency,
      },
    ],
  });
}

/** A balance large enough that no fixture purchase is refused for want of funds. */
export const AMPLE_FUNDING = "1000000000";
