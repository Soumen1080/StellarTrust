/**
 * Payout rails — country-wise fiat delivery for the destination leg of a
 * cross-border settlement (Phase 3).
 *
 * A corridor says WHICH currencies move; a rail says HOW the fiat actually
 * lands in the beneficiary's hands: UPI VPA in India, IMPS/NEFT to an IFSC
 * account, SEPA to an IBAN in the euro area, ACH/wire to a US ABA account,
 * NIBSS NIP to a Nigerian NUBAN. Each rail carries the scheme's real
 * per-transaction limits, clearing time, and flat fee, because those are what
 * make a payout succeed or bounce — the anchor cannot rescue an amount above
 * the scheme cap or a malformed account handle.
 *
 * Everything here is pure and data-only so the SAME rules validate in the
 * browser (instant feedback) and on the server (the authoritative check).
 * Handles are validated with the schemes' own checksum algorithms (IBAN
 * mod-97, ABA weighted checksum, CBN NUBAN check digit) rather than a length
 * guess, so a typo is caught before any money moves.
 *
 * Limits and fees are expressed in the destination currency's MINOR units
 * (integer strings) — no floats anywhere near money (Decision D12).
 */
import { CurrencyCode } from "../constants/index.js";

// ── Destinations ──────────────────────────────────────────────────────────────

/**
 * Payout destination: an ISO-3166 country, or the euro area treated as one
 * payment region because SEPA clears across all of it under a single scheme.
 */
export const PayoutCountry = {
  India: "IN",
  UnitedStates: "US",
  Nigeria: "NG",
  Eurozone: "EU",
} as const;
export type PayoutCountry = (typeof PayoutCountry)[keyof typeof PayoutCountry];

export const PAYOUT_COUNTRY_LABEL: Record<PayoutCountry, string> = {
  IN: "India",
  US: "United States",
  NG: "Nigeria",
  EU: "Euro area (SEPA)",
};

/** Emoji flag for a destination — display only, never used for logic. */
export const PAYOUT_COUNTRY_FLAG: Record<PayoutCountry, string> = {
  IN: "\u{1F1EE}\u{1F1F3}",
  US: "\u{1F1FA}\u{1F1F8}",
  NG: "\u{1F1F3}\u{1F1EC}",
  EU: "\u{1F1EA}\u{1F1FA}",
};

// ── Rails ─────────────────────────────────────────────────────────────────────

/** Supported fiat delivery rails, one per (country, scheme) pair. */
export const PayoutRail = {
  /** NPCI Unified Payments Interface — pay to a VPA / UPI ID. */
  Upi: "upi",
  /** NPCI Immediate Payment Service — instant credit to an IFSC account. */
  Imps: "imps",
  /** RBI National Electronic Funds Transfer — batched, no scheme cap. */
  Neft: "neft",
  /** SEPA Instant Credit Transfer (SCT Inst) — 10s credit, 100k cap. */
  SepaInstant: "sepa_instant",
  /** SEPA Credit Transfer (SCT) — next business day, large amounts. */
  SepaCredit: "sepa_credit",
  /** Same Day ACH credit (Nacha) — cheap, banking-hours cutoffs. */
  Ach: "ach",
  /** Fedwire funds transfer — same-day, high value, expensive. */
  Wire: "wire",
  /** NIBSS Instant Payment — instant credit to a NUBAN account. */
  Nip: "nip",
} as const;
export type PayoutRail = (typeof PayoutRail)[keyof typeof PayoutRail];

/** Beneficiary fields a rail needs. The union of these is small on purpose. */
export const PayoutFieldName = {
  UpiId: "upiId",
  AccountHolder: "accountHolder",
  AccountNumber: "accountNumber",
  Ifsc: "ifsc",
  Iban: "iban",
  RoutingNumber: "routingNumber",
  BankCode: "bankCode",
} as const;
export type PayoutFieldName =
  (typeof PayoutFieldName)[keyof typeof PayoutFieldName];

/**
 * How a raw input is normalized before validation. Bank handles are quoted to
 * humans with spaces and mixed case ("hdfc0001234", "GB82 WEST 1234"), so
 * normalizing first is what makes an otherwise-correct handle validate.
 */
export const PayoutFieldTransform = {
  /** Uppercase and strip all whitespace/dashes (IFSC, IBAN, sort codes). */
  UpperCompact: "upper_compact",
  /** Keep digits only (account/routing numbers). */
  DigitsOnly: "digits_only",
  /** Trim and collapse internal whitespace (names, UPI IDs). */
  Trim: "trim",
} as const;
export type PayoutFieldTransform =
  (typeof PayoutFieldTransform)[keyof typeof PayoutFieldTransform];

export interface PayoutFieldSpec {
  name: PayoutFieldName;
  label: string;
  placeholder: string;
  /** Shown under the input; explains the format in the local vocabulary. */
  help: string;
  transform: PayoutFieldTransform;
  maxLength: number;
  /**
   * Shape check as a regex source (no flags, anchored). A field can pass this
   * and still fail {@link validatePayoutDestination}, which additionally runs
   * the scheme checksum — the regex exists for fast client-side feedback.
   */
  pattern: string;
  /** `inputmode` hint for mobile keyboards. */
  inputMode: "text" | "numeric" | "email";
}

export interface PayoutRailSpec {
  rail: PayoutRail;
  label: string;
  country: PayoutCountry;
  currency: CurrencyCode;
  /** Clearing scheme that actually moves the money. */
  network: string;
  /** True when the scheme credits within seconds, 24x7. */
  instant: boolean;
  /** Typical time to credit the beneficiary once the anchor releases funds. */
  estimatedSeconds: number;
  /** Scheme minimum per transaction, destination minor units. */
  minAmount: string;
  /** Scheme/regulatory maximum per transaction, destination minor units. */
  maxAmount: string;
  /** Flat rail fee deducted from the payout, destination minor units. */
  flatFeeAmount: string;
  /** One-line operational caveat (cutoffs, cap source) shown in the UI. */
  notes: string;
  fields: readonly PayoutFieldSpec[];
}

// ── Field specs (shared across rails that take the same handle) ───────────────

const HOLDER_FIELD: PayoutFieldSpec = {
  name: PayoutFieldName.AccountHolder,
  label: "Beneficiary name",
  placeholder: "Name as registered with the bank",
  help: "Must match the account record — banks return mismatched credits.",
  transform: PayoutFieldTransform.Trim,
  maxLength: 140,
  pattern: "^[\\p{L}][\\p{L}\\p{M} .'-]{1,139}$",
  inputMode: "text",
};

const UPI_FIELD: PayoutFieldSpec = {
  name: PayoutFieldName.UpiId,
  label: "UPI ID (VPA)",
  placeholder: "name@okhdfcbank",
  help: "Virtual Payment Address, e.g. 9876543210@ybl or name@oksbi.",
  transform: PayoutFieldTransform.Trim,
  maxLength: 100,
  // NPCI VPA: <identifier>@<handle>. Identifier allows . _ - and digits.
  pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$",
  inputMode: "email",
};

const IFSC_FIELD: PayoutFieldSpec = {
  name: PayoutFieldName.Ifsc,
  label: "IFSC code",
  placeholder: "HDFC0001234",
  help: "11 characters: 4 bank letters, a 0, then the 6-character branch code.",
  transform: PayoutFieldTransform.UpperCompact,
  maxLength: 11,
  pattern: "^[A-Z]{4}0[A-Z0-9]{6}$",
  inputMode: "text",
};

const INDIAN_ACCOUNT_FIELD: PayoutFieldSpec = {
  name: PayoutFieldName.AccountNumber,
  label: "Account number",
  placeholder: "50100123456789",
  help: "9-18 digits, exactly as printed on the passbook or cheque.",
  transform: PayoutFieldTransform.DigitsOnly,
  maxLength: 18,
  pattern: "^\\d{9,18}$",
  inputMode: "numeric",
};

const IBAN_FIELD: PayoutFieldSpec = {
  name: PayoutFieldName.Iban,
  label: "IBAN",
  placeholder: "DE89 3704 0044 0532 0130 00",
  help: "Country code, 2 check digits, then the account identifier.",
  transform: PayoutFieldTransform.UpperCompact,
  maxLength: 34,
  pattern: "^[A-Z]{2}\\d{2}[A-Z0-9]{11,30}$",
  inputMode: "text",
};

const ABA_FIELD: PayoutFieldSpec = {
  name: PayoutFieldName.RoutingNumber,
  label: "Routing number (ABA)",
  placeholder: "021000021",
  help: "9-digit ABA routing transit number for the receiving bank.",
  transform: PayoutFieldTransform.DigitsOnly,
  maxLength: 9,
  pattern: "^\\d{9}$",
  inputMode: "numeric",
};

const US_ACCOUNT_FIELD: PayoutFieldSpec = {
  name: PayoutFieldName.AccountNumber,
  label: "Account number",
  placeholder: "000123456789",
  help: "4-17 digits, checking or savings.",
  transform: PayoutFieldTransform.DigitsOnly,
  maxLength: 17,
  pattern: "^\\d{4,17}$",
  inputMode: "numeric",
};

const NUBAN_FIELD: PayoutFieldSpec = {
  name: PayoutFieldName.AccountNumber,
  label: "NUBAN account number",
  placeholder: "0123456789",
  help: "10-digit NUBAN issued by the beneficiary's Nigerian bank.",
  transform: PayoutFieldTransform.DigitsOnly,
  maxLength: 10,
  pattern: "^\\d{10}$",
  inputMode: "numeric",
};

const NG_BANK_CODE_FIELD: PayoutFieldSpec = {
  name: PayoutFieldName.BankCode,
  label: "Bank code",
  placeholder: "058",
  help: "3-digit CBN institution code (e.g. 058 GTBank, 044 Access).",
  transform: PayoutFieldTransform.DigitsOnly,
  maxLength: 3,
  pattern: "^\\d{3}$",
  inputMode: "numeric",
};

// ── Rail catalog ──────────────────────────────────────────────────────────────

/**
 * Limits are the published scheme/regulator caps at time of writing; a live
 * deployment reads them per anchor because banks apply their own lower ones.
 */
export const PAYOUT_RAILS: Readonly<Record<PayoutRail, PayoutRailSpec>> =
  Object.freeze({
    [PayoutRail.Upi]: {
      rail: PayoutRail.Upi,
      label: "UPI",
      country: PayoutCountry.India,
      currency: CurrencyCode.INR,
      network: "NPCI UPI",
      instant: true,
      estimatedSeconds: 10,
      minAmount: "100", // INR 1.00
      maxAmount: "10000000", // INR 1,00,000 — NPCI per-transaction P2P/P2M cap.
      flatFeeAmount: "0", // UPI credits are free to the beneficiary.
      notes: "Instant, 24x7. NPCI caps a single UPI transfer at INR 1,00,000.",
      fields: [UPI_FIELD, HOLDER_FIELD],
    },
    [PayoutRail.Imps]: {
      rail: PayoutRail.Imps,
      label: "IMPS (bank account)",
      country: PayoutCountry.India,
      currency: CurrencyCode.INR,
      network: "NPCI IMPS",
      instant: true,
      estimatedSeconds: 30,
      minAmount: "100",
      maxAmount: "50000000", // INR 5,00,000 per IMPS transaction.
      flatFeeAmount: "500", // INR 5.00 typical IMPS charge.
      notes: "Instant, 24x7. IMPS caps a single transfer at INR 5,00,000.",
      fields: [INDIAN_ACCOUNT_FIELD, IFSC_FIELD, HOLDER_FIELD],
    },
    [PayoutRail.Neft]: {
      rail: PayoutRail.Neft,
      label: "NEFT (bank account)",
      country: PayoutCountry.India,
      currency: CurrencyCode.INR,
      network: "RBI NEFT",
      instant: false,
      // Settles in half-hourly batches; ~30 min is the realistic expectation.
      estimatedSeconds: 1800,
      minAmount: "100",
      maxAmount: "1000000000", // INR 1,00,00,000 platform ceiling; NEFT has no scheme cap.
      flatFeeAmount: "0", // RBI mandates no charge on inward NEFT credits.
      notes:
        "Batched every 30 minutes, 24x7. Use for amounts above the IMPS cap.",
      fields: [INDIAN_ACCOUNT_FIELD, IFSC_FIELD, HOLDER_FIELD],
    },
    [PayoutRail.SepaInstant]: {
      rail: PayoutRail.SepaInstant,
      label: "SEPA Instant",
      country: PayoutCountry.Eurozone,
      currency: CurrencyCode.EUR,
      network: "SEPA SCT Inst",
      instant: true,
      estimatedSeconds: 10,
      minAmount: "1",
      maxAmount: "10000000", // EUR 100,000 SCT Inst scheme cap.
      flatFeeAmount: "20", // EUR 0.20
      notes:
        "Credits within 10 seconds, 24x7. Scheme cap EUR 100,000 per transfer.",
      fields: [IBAN_FIELD, HOLDER_FIELD],
    },
    [PayoutRail.SepaCredit]: {
      rail: PayoutRail.SepaCredit,
      label: "SEPA Credit Transfer",
      country: PayoutCountry.Eurozone,
      currency: CurrencyCode.EUR,
      network: "SEPA SCT",
      instant: false,
      // Next TARGET2 business day.
      estimatedSeconds: 86400,
      minAmount: "1",
      maxAmount: "100000000", // EUR 1,000,000 platform ceiling.
      flatFeeAmount: "0",
      notes: "Next business day. Use above the SEPA Instant EUR 100,000 cap.",
      fields: [IBAN_FIELD, HOLDER_FIELD],
    },
    [PayoutRail.Ach]: {
      rail: PayoutRail.Ach,
      label: "ACH (Same Day)",
      country: PayoutCountry.UnitedStates,
      currency: CurrencyCode.USD,
      network: "Nacha Same Day ACH",
      instant: false,
      // Same-day window if submitted before the cutoff, else next banking day.
      estimatedSeconds: 21600,
      minAmount: "1",
      maxAmount: "100000000", // USD 1,000,000 Nacha per-payment Same Day limit.
      flatFeeAmount: "25", // USD 0.25
      notes:
        "Banking days only; same-day if submitted before the 16:45 ET cutoff.",
      fields: [US_ACCOUNT_FIELD, ABA_FIELD, HOLDER_FIELD],
    },
    [PayoutRail.Wire]: {
      rail: PayoutRail.Wire,
      label: "Wire (Fedwire)",
      country: PayoutCountry.UnitedStates,
      currency: CurrencyCode.USD,
      network: "Fedwire Funds Service",
      instant: false,
      estimatedSeconds: 7200,
      minAmount: "1",
      maxAmount: "1000000000", // USD 10,000,000 platform ceiling; Fedwire has no cap.
      flatFeeAmount: "1500", // USD 15.00
      notes: "Same-day on banking days. Use above the Same Day ACH USD 1M limit.",
      fields: [US_ACCOUNT_FIELD, ABA_FIELD, HOLDER_FIELD],
    },
    [PayoutRail.Nip]: {
      rail: PayoutRail.Nip,
      label: "NIP (bank transfer)",
      country: PayoutCountry.Nigeria,
      currency: CurrencyCode.NGN,
      network: "NIBSS Instant Payment",
      instant: true,
      estimatedSeconds: 30,
      minAmount: "100", // NGN 1.00
      maxAmount: "500000000", // NGN 5,000,000 typical NIP per-transaction limit.
      flatFeeAmount: "5000", // NGN 50.00 — top NIP transfer-fee tier.
      notes: "Instant, 24x7. Banks apply a NGN 5,000,000 per-transfer limit.",
      fields: [NUBAN_FIELD, NG_BANK_CODE_FIELD, HOLDER_FIELD],
    },
  });

export const ALL_PAYOUT_RAILS: readonly PayoutRailSpec[] =
  Object.values(PAYOUT_RAILS);

/** Rails that deliver a given currency, fastest first. */
export function railsForCurrency(
  currency: CurrencyCode,
): readonly PayoutRailSpec[] {
  return ALL_PAYOUT_RAILS.filter((spec) => spec.currency === currency).sort(
    (left, right) => left.estimatedSeconds - right.estimatedSeconds,
  );
}

/** The destination country a currency pays out into, if any rail serves it. */
export function payoutCountryForCurrency(
  currency: CurrencyCode,
): PayoutCountry | undefined {
  return railsForCurrency(currency)[0]?.country;
}

export function findPayoutRail(rail: string): PayoutRailSpec | undefined {
  return (PAYOUT_RAILS as Record<string, PayoutRailSpec | undefined>)[rail];
}

// ── Normalization ─────────────────────────────────────────────────────────────

export function normalizePayoutField(
  value: string,
  transform: PayoutFieldTransform,
): string {
  switch (transform) {
    case PayoutFieldTransform.UpperCompact:
      return value.replace(/[\s-]/g, "").toUpperCase();
    case PayoutFieldTransform.DigitsOnly:
      return value.replace(/\D/g, "");
    case PayoutFieldTransform.Trim:
      return value.trim().replace(/\s+/g, " ");
  }
}

// ── Scheme checksums ──────────────────────────────────────────────────────────

/** Published IBAN lengths per country. An unknown country fails closed. */
const IBAN_LENGTHS: Readonly<Record<string, number>> = Object.freeze({
  AD: 24, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18,
  EE: 20, ES: 24, FI: 18, FR: 27, GB: 22, GR: 27, HR: 21, HU: 28, IE: 22,
  IS: 26, IT: 27, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31, NL: 18,
  NO: 15, PL: 28, PT: 25, RO: 24, SE: 24, SI: 19, SK: 24, SM: 27,
});

/** Euro-area countries whose IBANs a EUR SEPA payout may target. */
const SEPA_EUR_COUNTRIES: ReadonlySet<string> = new Set([
  "AT", "BE", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE", "IT",
  "LT", "LU", "LV", "MT", "NL", "PT", "SI", "SK", "AD", "MC", "SM",
]);

/**
 * ISO 13616 / ISO 7064 MOD-97-10 check. Rotates the first four characters to
 * the back, maps letters to numbers, and requires the remainder to be 1.
 */
export function isValidIban(value: string): boolean {
  const iban = normalizePayoutField(value, PayoutFieldTransform.UpperCompact);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const expected = IBAN_LENGTHS[iban.slice(0, 2)];
  if (expected === undefined || iban.length !== expected) return false;

  const rearranged = iban.slice(4) + iban.slice(0, 4);
  // Reduce digit-by-digit: the full number overflows every JS integer type.
  let remainder = 0;
  for (const char of rearranged) {
    const mapped =
      char >= "A" && char <= "Z"
        ? String(char.charCodeAt(0) - 55) // A -> 10 ... Z -> 35
        : char;
    for (const digit of mapped) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

export function isSepaEurIban(value: string): boolean {
  const iban = normalizePayoutField(value, PayoutFieldTransform.UpperCompact);
  return isValidIban(iban) && SEPA_EUR_COUNTRIES.has(iban.slice(0, 2));
}

/** ABA routing transit number checksum (weights 3-7-1, sum congruent 0 mod 10). */
export function isValidAbaRouting(value: string): boolean {
  const digits = normalizePayoutField(value, PayoutFieldTransform.DigitsOnly);
  if (!/^\d{9}$/.test(digits)) return false;
  // First two digits are the Federal Reserve district; 13-20 are unassigned.
  const prefix = Number(digits.slice(0, 2));
  if (prefix > 12 && prefix < 21) return false;
  if (prefix > 32) return false;
  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  const sum = weights.reduce(
    (total, weight, index) => total + weight * Number(digits[index]),
    0,
  );
  return sum % 10 === 0;
}

/**
 * CBN NUBAN check digit: weight the 3-digit bank code plus the 9-digit serial
 * with the repeating 3-7-3 pattern; the 10th digit must close the sum mod 10.
 */
export function isValidNuban(accountNumber: string, bankCode: string): boolean {
  const account = normalizePayoutField(
    accountNumber,
    PayoutFieldTransform.DigitsOnly,
  );
  const bank = normalizePayoutField(bankCode, PayoutFieldTransform.DigitsOnly);
  if (!/^\d{10}$/.test(account) || !/^\d{3}$/.test(bank)) return false;

  const weights = [3, 7, 3, 3, 7, 3, 3, 7, 3, 3, 7, 3];
  const body = `${bank}${account.slice(0, 9)}`;
  const sum = weights.reduce(
    (total, weight, index) => total + weight * Number(body[index]),
    0,
  );
  const check = (10 - (sum % 10)) % 10;
  return check === Number(account[9]);
}

/** NPCI VPA shape. Handles are issued by PSPs, so only the form is checkable. */
export function isValidUpiId(value: string): boolean {
  const vpa = normalizePayoutField(value, PayoutFieldTransform.Trim);
  return new RegExp(UPI_FIELD.pattern).test(vpa);
}

export function isValidIfsc(value: string): boolean {
  const ifsc = normalizePayoutField(value, PayoutFieldTransform.UpperCompact);
  return new RegExp(IFSC_FIELD.pattern).test(ifsc);
}

// ── Destination validation ────────────────────────────────────────────────────

/** Beneficiary handle as captured from the payer, before normalization. */
export interface PayoutDestinationInput {
  rail: PayoutRail;
  /** Rail-specific fields, keyed by {@link PayoutFieldName}. */
  fields: Partial<Record<PayoutFieldName, string>>;
  /** Optional remittance memo carried to the beneficiary's statement. */
  reference?: string;
}

export interface PayoutFieldIssue {
  field: PayoutFieldName;
  message: string;
}

export type PayoutValidationResult =
  | {
      ok: true;
      rail: PayoutRailSpec;
      /** Normalized field values, safe to hand to the anchor. */
      fields: Record<string, string>;
    }
  | { ok: false; issues: PayoutFieldIssue[] };

/**
 * Validate a beneficiary handle against its rail: presence, shape, and the
 * scheme's own checksum. Returns every issue at once so the form can highlight
 * all bad fields in a single pass instead of one per submit.
 */
export function validatePayoutDestination(
  input: PayoutDestinationInput,
): PayoutValidationResult {
  const spec = findPayoutRail(input.rail);
  if (!spec) {
    return {
      ok: false,
      issues: [
        {
          field: PayoutFieldName.AccountNumber,
          message: "Unsupported payout rail",
        },
      ],
    };
  }

  const issues: PayoutFieldIssue[] = [];
  const fields: Record<string, string> = {};

  for (const field of spec.fields) {
    const raw = input.fields[field.name] ?? "";
    const value = normalizePayoutField(raw, field.transform);
    if (value.length === 0) {
      issues.push({ field: field.name, message: `${field.label} is required` });
      continue;
    }
    if (value.length > field.maxLength) {
      issues.push({
        field: field.name,
        message: `${field.label} must be at most ${field.maxLength} characters`,
      });
      continue;
    }
    if (!new RegExp(field.pattern, "u").test(value)) {
      issues.push({
        field: field.name,
        message: `${field.label} format is invalid`,
      });
      continue;
    }
    fields[field.name] = value;
  }

  // Scheme checksums run only on fields that already passed their shape check.
  const value = (name: PayoutFieldName): string | undefined => fields[name];

  const ifsc = value(PayoutFieldName.Ifsc);
  if (ifsc !== undefined && !isValidIfsc(ifsc)) {
    issues.push({
      field: PayoutFieldName.Ifsc,
      message: "IFSC code is not valid",
    });
  }

  const upiId = value(PayoutFieldName.UpiId);
  if (upiId !== undefined && !isValidUpiId(upiId)) {
    issues.push({ field: PayoutFieldName.UpiId, message: "UPI ID is not valid" });
  }

  const iban = value(PayoutFieldName.Iban);
  if (iban !== undefined) {
    if (!isValidIban(iban)) {
      issues.push({
        field: PayoutFieldName.Iban,
        message: "IBAN failed its check-digit validation",
      });
    } else if (spec.currency === CurrencyCode.EUR && !isSepaEurIban(iban)) {
      issues.push({
        field: PayoutFieldName.Iban,
        message: "IBAN is outside the euro area — SEPA cannot deliver EUR to it",
      });
    }
  }

  const routing = value(PayoutFieldName.RoutingNumber);
  if (routing !== undefined && !isValidAbaRouting(routing)) {
    issues.push({
      field: PayoutFieldName.RoutingNumber,
      message: "Routing number failed its ABA checksum",
    });
  }

  const nubanAccount = value(PayoutFieldName.AccountNumber);
  const nubanBank = value(PayoutFieldName.BankCode);
  if (
    spec.rail === PayoutRail.Nip &&
    nubanAccount !== undefined &&
    nubanBank !== undefined &&
    !isValidNuban(nubanAccount, nubanBank)
  ) {
    issues.push({
      field: PayoutFieldName.AccountNumber,
      message: "NUBAN check digit does not match this bank code",
    });
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, rail: spec, fields };
}

// ── Masking ───────────────────────────────────────────────────────────────────

/** Keep the last `visible` characters, mask the rest with a bounded run. */
function maskTail(value: string, visible: number): string {
  if (value.length <= visible) return "•".repeat(value.length);
  return `${"•".repeat(Math.min(6, value.length - visible))}${value.slice(
    -visible,
  )}`;
}

/** `soumen@okhdfcbank` -> `so***@okhdfcbank`; the PSP handle stays readable. */
function maskUpiId(value: string): string {
  const [name = "", handle = ""] = value.split("@");
  const head = name.slice(0, 2);
  const hidden = "•".repeat(Math.max(1, Math.min(6, name.length - 2)));
  return `${head}${hidden}@${handle}`;
}

/**
 * Human-readable, non-reversible summary of a beneficiary handle — the ONLY
 * form persisted or logged. Full account numbers, IBANs, and VPAs are used for
 * the anchor call and then dropped (Rules.md §7: no raw PII at rest).
 */
export function maskPayoutDestination(
  rail: PayoutRail,
  fields: Record<string, string>,
): string {
  switch (rail) {
    case PayoutRail.Upi:
      return maskUpiId(fields[PayoutFieldName.UpiId] ?? "");
    case PayoutRail.Imps:
    case PayoutRail.Neft:
      return `${maskTail(fields[PayoutFieldName.AccountNumber] ?? "", 4)} · ${
        fields[PayoutFieldName.Ifsc] ?? ""
      }`;
    case PayoutRail.SepaInstant:
    case PayoutRail.SepaCredit: {
      const iban = fields[PayoutFieldName.Iban] ?? "";
      return `${iban.slice(0, 4)} ${maskTail(iban.slice(4), 4)}`;
    }
    case PayoutRail.Ach:
    case PayoutRail.Wire:
      return `${maskTail(
        fields[PayoutFieldName.AccountNumber] ?? "",
        4,
      )} · ABA ${fields[PayoutFieldName.RoutingNumber] ?? ""}`;
    case PayoutRail.Nip:
      return `${maskTail(
        fields[PayoutFieldName.AccountNumber] ?? "",
        4,
      )} · bank ${fields[PayoutFieldName.BankCode] ?? ""}`;
  }
}

/** Initials only — enough to recognize a beneficiary, not to identify them. */
export function maskAccountHolder(value: string): string {
  return (
    value
      .split(" ")
      .filter(Boolean)
      .map((part) => `${part[0]?.toUpperCase() ?? ""}.`)
      .join(" ") || "—"
  );
}

/** Stable, order-independent string a fingerprint hash is computed over. */
export function payoutFingerprintSource(
  rail: PayoutRail,
  fields: Record<string, string>,
): string {
  const parts = Object.keys(fields)
    .filter((key) => key !== PayoutFieldName.AccountHolder)
    .sort()
    .map((key) => `${key}=${fields[key]}`);
  return `${rail}|${parts.join("&")}`;
}
