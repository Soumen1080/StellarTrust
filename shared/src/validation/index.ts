/**
 * Shared validation schemas (Zod) — contracts of record.
 * Validate all input at the boundary (Rules.md §2). These schemas are the
 * canonical shapes; backend routes and the AI service mirror them.
 */
import { z } from "zod";
import {
  AiRecommendation,
  ApplicantType,
  CurrencyCode,
  DisputeResolution,
  EntryDirection,
  FEEDBACK_RATING_MAX,
  FEEDBACK_RATING_MIN,
  EvidenceKind,
  HumanKycDecision,
  PaymentTransition,
  SUPPORTED_CURRENCIES,
} from "../constants/index.js";
import {
  PAYOUT_RAILS,
  PayoutFieldName,
  PayoutRail,
} from "../payouts/index.js";

/** Positive integer minor-unit amount, as a string (no floats for money). */
export const minorUnitAmountSchema = z
  .string()
  .regex(/^\d+$/, "amount must be a non-negative integer string (minor units)");

export const currencySchema = z.enum(
  SUPPORTED_CURRENCIES as [CurrencyCode, ...CurrencyCode[]],
);

export const payoutRailSchema = z.enum(
  Object.values(PayoutRail) as [PayoutRail, ...PayoutRail[]],
);

export const moneySchema = z.object({
  amount: minorUnitAmountSchema,
  currency: currencySchema,
});

export const ledgerEntryInputSchema = z.object({
  accountId: z.string().uuid(),
  direction: z.enum([EntryDirection.Debit, EntryDirection.Credit]),
  amount: minorUnitAmountSchema.refine((v) => v !== "0", {
    message: "entry amount must be greater than zero",
  }),
  currency: currencySchema,
});

export const ledgerTransactionInputSchema = z.object({
  referenceId: z.string().min(1).max(128),
  description: z.string().min(1).max(512),
  entries: z
    .array(ledgerEntryInputSchema)
    .min(2, "a balanced transaction needs at least two entries"),
});

export const aiAdvisorySchema = z.object({
  recommendation: z.enum([
    AiRecommendation.Release,
    AiRecommendation.Refund,
    AiRecommendation.ManualReview,
  ]),
  confidence: z.number().min(0).max(1),
  explanation: z.string().min(1),
  signals: z.array(z.string()),
});

export const idempotencyKeySchema = z
  .string()
  .min(8, "idempotency key too short")
  .max(200);

// ── Phase 2: Core Payment + Escrow ───────────────────────────────────────────

export const createOrderInputSchema = z.object({
  sellerId: z.string().min(1).max(128),
  amount: moneySchema.extend({
    amount: minorUnitAmountSchema.refine((value) => value !== "0", {
      message: "order amount must be greater than zero",
    }),
  }),
});

export const paymentTransitionSchema = z.enum([
  PaymentTransition.Create,
  PaymentTransition.Accept,
  PaymentTransition.Deposit,
  PaymentTransition.Lock,
  PaymentTransition.Confirm,
  PaymentTransition.Release,
  PaymentTransition.Refund,
  PaymentTransition.Dispute,
]);

/**
 * A signed transaction envelope handed back for submission. Bounded because an
 * escrow envelope is a few kB at most and the body is parsed before any chain
 * call — an unbounded string here is an easy memory-pressure vector.
 */
export const submitSignedTransitionInputSchema = z.object({
  signedXdr: z
    .string()
    .min(1, "signedXdr is required")
    .max(64_000, "signedXdr is too large to be a transaction envelope")
    .regex(/^[A-Za-z0-9+/=]+$/, "signedXdr must be base64"),
});

// ── Phase 1: Identity & Wallet ────────────────────────────────────────────────

/** Stellar ed25519 public account (G...). */
export const stellarAccountSchema = z
  .string()
  .regex(/^G[A-Z2-7]{55}$/, "invalid Stellar public account");

export const sep10ChallengeRequestSchema = z.object({
  account: stellarAccountSchema,
  memo: z.string().max(64).optional(),
});

export const sep10VerifyRequestSchema = z.object({
  challengeId: z.string().uuid(),
  signedTransactionXdr: z.string().min(32).max(100_000),
});

const imageReferenceSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      value.startsWith("sandbox://") ||
      value.startsWith("storage://") ||
      value.startsWith("https://"),
    "image must be an opaque sandbox/storage reference or HTTPS URL",
  );

export const kycDocumentInputSchema = z.object({
  kind: z.enum(["passport", "national_id", "drivers_license"]),
  issuingCountry: z.string().length(2).transform((value) => value.toUpperCase()),
  number: z.string().min(4).max(64),
  expiryDate: z.string().date(),
  frontImageRef: imageReferenceSchema,
  backImageRef: imageReferenceSchema.optional(),
});

export const kycApplicationInputSchema = z
  .object({
    applicantType: z.enum([
      ApplicantType.Individual,
      ApplicantType.Business,
    ]),
    email: z.string().email().max(320),
    legalName: z.string().min(2).max(200),
    country: z.string().length(2).transform((value) => value.toUpperCase()),
    dateOfBirth: z.string().date().optional(),
    registrationNumber: z.string().min(2).max(100).optional(),
    document: kycDocumentInputSchema,
    faceImageRef: imageReferenceSchema,
    businessName: z.string().min(2).max(200).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.applicantType === ApplicantType.Individual && !value.dateOfBirth) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dateOfBirth"],
        message: "dateOfBirth is required for an individual",
      });
    }
    if (value.applicantType === ApplicantType.Business) {
      if (!value.businessName) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["businessName"],
          message: "businessName is required for a business",
        });
      }
      if (!value.registrationNumber) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["registrationNumber"],
          message: "registrationNumber is required for a business",
        });
      }
    }
  });

export const kycReviewDecisionInputSchema = z.object({
  decision: z.enum([
    HumanKycDecision.Approve,
    HumanKycDecision.Reject,
  ]),
  reason: z.string().min(5).max(1_000),
});

// ── Phase 3: Cross-Border Settlement ──────────────────────────────────────────

export const settlementQuoteInputSchema = z
  .object({
    sourceCurrency: currencySchema,
    destinationCurrency: currencySchema,
    sourceAmount: minorUnitAmountSchema.refine((value) => value !== "0", {
      message: "sourceAmount must be greater than zero",
    }),
    // Basis points (1% = 100 bps). 0..10000.
    maxSlippageBps: z.number().int().min(0).max(10_000).optional(),
    maxFeeAmount: minorUnitAmountSchema.optional(),
    payoutRail: payoutRailSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.sourceCurrency === value.destinationCurrency) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["destinationCurrency"],
        message: "source and destination currencies must differ",
      });
    }
    // A rail only exists for the currency it clears in; catching the mismatch
    // here keeps the quote from being priced against the wrong scheme's fee.
    const rail = value.payoutRail ? PAYOUT_RAILS[value.payoutRail] : undefined;
    if (rail && rail.currency !== value.destinationCurrency) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payoutRail"],
        message: `${rail.label} settles in ${rail.currency}, not ${value.destinationCurrency}`,
      });
    }
  });

/**
 * Beneficiary handle. The schema enforces presence and length; the scheme
 * checksums (IBAN mod-97, ABA, NUBAN, IFSC, VPA shape) run in
 * {@link validatePayoutDestination}, which the service calls next — keeping
 * one implementation of those rules shared with the browser.
 */
export const payoutDestinationInputSchema = z.object({
  rail: payoutRailSchema,
  fields: z
    .record(
      z.enum(
        Object.values(PayoutFieldName) as [PayoutFieldName, ...PayoutFieldName[]],
      ),
      z.string().min(1).max(140),
    )
    .refine((value) => Object.keys(value).length > 0, {
      message: "beneficiary details are required",
    }),
  // Remittance memo: reaches the beneficiary's statement, so it must never be
  // used to smuggle an account number past the masking rules.
  reference: z.string().min(3).max(140).optional(),
});

export const settlementExecuteInputSchema = z.object({
  quoteId: z.string().uuid(),
  destination: payoutDestinationInputSchema,
  /**
   * Escrow order this settlement funds (plane.md §2.1).
   *
   * When present, completing the settlement drives the order's `Deposit`
   * transition instead of the buyer funding the escrow a second time. The
   * credited amount must match the order amount exactly, or the settlement is
   * refused before any money moves.
   */
  orderId: z.string().uuid().optional(),
});

// ── Phase 4: Disputes + AI (advisory) ─────────────────────────────────────────

const evidenceReferenceSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      value.startsWith("sandbox://") ||
      value.startsWith("storage://") ||
      value.startsWith("https://"),
    "evidence must be an opaque sandbox/storage reference or HTTPS URL",
  );

export const openDisputeInputSchema = z.object({
  orderId: z.string().uuid(),
  reason: z.string().min(5).max(1_000),
});

export const disputeEvidenceInputSchema = z.object({
  kind: z.enum([
    EvidenceKind.Invoice,
    EvidenceKind.Tracking,
    EvidenceKind.Otp,
    EvidenceKind.Courier,
    EvidenceKind.Image,
  ]),
  supports: z.enum([DisputeResolution.Release, DisputeResolution.Refund]),
  weight: z.number().min(0).max(1),
  reference: evidenceReferenceSchema,
  description: z.string().max(500).optional(),
});

export const disputeDecisionInputSchema = z.object({
  decision: z.enum([DisputeResolution.Release, DisputeResolution.Refund]),
  reason: z.string().min(5).max(1_000),
});

// ── Phase 6: Product feedback ─────────────────────────────────────────────────

/**
 * A feedback submission.
 *
 * `email` and `walletAddress` are validated as strictly as any other contact
 * detail even though they are never published: a wall entry is only useful as
 * evidence of a real testnet participant if the wallet on it is a real account.
 */
export const feedbackInputSchema = z.object({
  name: z.string().trim().min(2, "name must be at least 2 characters").max(80),
  email: z.string().trim().toLowerCase().email("invalid email address").max(254),
  walletAddress: stellarAccountSchema,
  message: z
    .string()
    .trim()
    .min(10, "feedback must be at least 10 characters")
    .max(1_000),
  rating: z
    .number()
    .int("rating must be a whole number of stars")
    .min(FEEDBACK_RATING_MIN)
    .max(FEEDBACK_RATING_MAX),
});

export type LedgerTransactionInputParsed = z.infer<
  typeof ledgerTransactionInputSchema
>;
export type CreateOrderInputParsed = z.infer<typeof createOrderInputSchema>;
export type Sep10ChallengeRequestParsed = z.infer<
  typeof sep10ChallengeRequestSchema
>;
export type Sep10VerifyRequestParsed = z.infer<typeof sep10VerifyRequestSchema>;
export type KycApplicationInputParsed = z.infer<
  typeof kycApplicationInputSchema
>;
export type KycReviewDecisionInputParsed = z.infer<
  typeof kycReviewDecisionInputSchema
>;
export type SettlementQuoteInputParsed = z.infer<
  typeof settlementQuoteInputSchema
>;
export type SettlementExecuteInputParsed = z.infer<
  typeof settlementExecuteInputSchema
>;
export type OpenDisputeInputParsed = z.infer<typeof openDisputeInputSchema>;
export type DisputeEvidenceInputParsed = z.infer<
  typeof disputeEvidenceInputSchema
>;
export type DisputeDecisionInputParsed = z.infer<
  typeof disputeDecisionInputSchema
>;

export type FeedbackInputParsed = z.infer<typeof feedbackInputSchema>;
