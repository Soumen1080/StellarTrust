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
  EvidenceKind,
  HumanKycDecision,
  PaymentTransition,
  SUPPORTED_CURRENCIES,
} from "../constants/index.js";

/** Positive integer minor-unit amount, as a string (no floats for money). */
export const minorUnitAmountSchema = z
  .string()
  .regex(/^\d+$/, "amount must be a non-negative integer string (minor units)");

export const currencySchema = z.enum(
  SUPPORTED_CURRENCIES as [CurrencyCode, ...CurrencyCode[]],
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
]);

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
  })
  .superRefine((value, ctx) => {
    if (value.sourceCurrency === value.destinationCurrency) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["destinationCurrency"],
        message: "source and destination currencies must differ",
      });
    }
  });

export const settlementExecuteInputSchema = z.object({
  quoteId: z.string().uuid(),
  destinationReference: z.string().min(3).max(256),
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
