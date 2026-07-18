/**
 * Shared validation schemas (Zod) — contracts of record.
 * Validate all input at the boundary (Rules.md §2). These schemas are the
 * canonical shapes; backend routes and the AI service mirror them.
 */
import { z } from "zod";
import {
  AiRecommendation,
  CurrencyCode,
  EntryDirection,
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

export type LedgerTransactionInputParsed = z.infer<
  typeof ledgerTransactionInputSchema
>;
