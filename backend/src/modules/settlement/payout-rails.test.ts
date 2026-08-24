/**
 * Beneficiary-handle validation for the country-wise payout rails.
 *
 * These checks are the difference between a payout that lands and one that is
 * returned days later: every scheme here has a checksum precisely so a typo in
 * an account number does not silently become someone else's account.
 */
import {
  isSepaEurIban,
  isValidAbaRouting,
  isValidIban,
  isValidIfsc,
  isValidNuban,
  isValidUpiId,
  maskAccountHolder,
  maskPayoutDestination,
  payoutFingerprintSource,
  PayoutRail,
  railsForCurrency,
  validatePayoutDestination,
} from "@stellartrust/shared";
import { describe, expect, it } from "vitest";

describe("UPI virtual payment addresses", () => {
  it("accepts the handles UPI actually issues", () => {
    expect(isValidUpiId("priya@okhdfcbank")).toBe(true);
    expect(isValidUpiId("9876543210@ybl")).toBe(true);
    expect(isValidUpiId("firm.name-01@oksbi")).toBe(true);
    // Payers copy VPAs with stray whitespace; that alone is not an error.
    expect(isValidUpiId("  priya@okaxis  ")).toBe(true);
  });

  it("rejects handles that are not addressable", () => {
    expect(isValidUpiId("priya")).toBe(false); // no PSP handle
    expect(isValidUpiId("@okhdfcbank")).toBe(false); // no identifier
    expect(isValidUpiId("priya@")).toBe(false);
    expect(isValidUpiId("priya@@okaxis")).toBe(false);
  });
});

describe("IFSC codes", () => {
  it("accepts a well-formed code regardless of case or spacing", () => {
    expect(isValidIfsc("HDFC0001234")).toBe(true);
    expect(isValidIfsc("hdfc0001234")).toBe(true);
    expect(isValidIfsc("SBIN 0 000 691")).toBe(true);
  });

  it("rejects codes missing the mandatory fifth-character zero", () => {
    expect(isValidIfsc("HDFC1001234")).toBe(false);
    expect(isValidIfsc("HDF0001234")).toBe(false); // too short
  });
});

describe("IBAN check digits", () => {
  it("accepts real IBANs after mod-97 validation", () => {
    expect(isValidIban("DE89 3704 0044 0532 0130 00")).toBe(true);
    expect(isValidIban("FR1420041010050500013M02606")).toBe(true);
    expect(isValidIban("GB82WEST12345698765432")).toBe(true);
  });

  it("rejects a single transposed digit", () => {
    // DE89… with two digits swapped: right length, wrong check digits.
    expect(isValidIban("DE89370400440532013000".replace("0532", "5032"))).toBe(
      false,
    );
  });

  it("rejects an IBAN whose length is wrong for its country", () => {
    expect(isValidIban("DE8937040044053201300")).toBe(false);
  });

  it("separates euro-area IBANs from other SEPA countries", () => {
    // A EUR payout cannot be delivered to a UK IBAN over SEPA even though the
    // IBAN itself is perfectly valid.
    expect(isValidIban("GB82WEST12345698765432")).toBe(true);
    expect(isSepaEurIban("GB82WEST12345698765432")).toBe(false);
    expect(isSepaEurIban("DE89370400440532013000")).toBe(true);
  });
});

describe("ABA routing numbers", () => {
  it("accepts routing numbers that satisfy the 3-7-1 checksum", () => {
    expect(isValidAbaRouting("021000021")).toBe(true); // JPMorgan Chase
    expect(isValidAbaRouting("121000248")).toBe(true); // Wells Fargo
  });

  it("rejects a mistyped digit and unassigned district prefixes", () => {
    expect(isValidAbaRouting("021000022")).toBe(false);
    expect(isValidAbaRouting("151000021")).toBe(false); // 13-20 unassigned
    expect(isValidAbaRouting("12100024")).toBe(false); // eight digits
  });
});

describe("NUBAN check digit", () => {
  it("accepts an account number whose check digit matches its bank code", () => {
    expect(isValidNuban("0123456785", "058")).toBe(true);
  });

  it("rejects the same account number under a different bank", () => {
    // The check digit is computed over bank code + serial, so a NUBAN is only
    // valid at the bank that issued it.
    expect(isValidNuban("0123456785", "044")).toBe(false);
  });

  it("rejects a wrong check digit", () => {
    expect(isValidNuban("0123456789", "058")).toBe(false);
  });
});

describe("destination validation", () => {
  it("normalizes before validating, so human-formatted input passes", () => {
    const result = validatePayoutDestination({
      rail: PayoutRail.Imps,
      fields: {
        accountNumber: "5010 0123 4567 89",
        ifsc: "hdfc0001234",
        accountHolder: "  Priya   Sharma ",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields.accountNumber).toBe("50100123456789");
    expect(result.fields.ifsc).toBe("HDFC0001234");
    expect(result.fields.accountHolder).toBe("Priya Sharma");
  });

  it("reports every bad field at once rather than one per attempt", () => {
    const result = validatePayoutDestination({
      rail: PayoutRail.Ach,
      fields: {
        accountNumber: "12",
        routingNumber: "021000022",
        accountHolder: "",
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.field).sort()).toEqual([
      "accountHolder",
      "accountNumber",
      "routingNumber",
    ]);
  });

  it("refuses a non-euro IBAN on a EUR rail", () => {
    const result = validatePayoutDestination({
      rail: PayoutRail.SepaCredit,
      fields: { iban: "GB82WEST12345698765432", accountHolder: "Jane Doe" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toMatch(/euro area/i);
  });

  it("requires every field the rail declares", () => {
    const result = validatePayoutDestination({
      rail: PayoutRail.Nip,
      fields: { accountNumber: "0123456785", accountHolder: "Ade Bello" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.field)).toContain("bankCode");
  });
});

describe("masking and fingerprints", () => {
  it("keeps a handle recognizable without reproducing it", () => {
    const masked = maskPayoutDestination(PayoutRail.Upi, {
      upiId: "priyasharma@okhdfcbank",
    });
    expect(masked).toContain("@okhdfcbank"); // PSP is not sensitive
    expect(masked).not.toContain("priyasharma");
    expect(masked.startsWith("pr")).toBe(true);
  });

  it("shows only the last four digits of an account number", () => {
    const masked = maskPayoutDestination(PayoutRail.Ach, {
      accountNumber: "000123456789",
      routingNumber: "021000021",
    });
    expect(masked).toContain("6789");
    expect(masked).not.toContain("000123456789");
  });

  it("reduces a beneficiary name to initials", () => {
    expect(maskAccountHolder("Priya Sharma")).toBe("P. S.");
  });

  it("fingerprints the handle, not the name on it", () => {
    // The same account reached under a different spelling of the holder's name
    // is still the same account — duplicate detection must see that.
    const source = (holder: string) =>
      payoutFingerprintSource(PayoutRail.Imps, {
        accountNumber: "50100123456789",
        ifsc: "HDFC0001234",
        accountHolder: holder,
      });
    expect(source("Priya Sharma")).toBe(source("P Sharma"));
    expect(source("Priya Sharma")).not.toBe(
      payoutFingerprintSource(PayoutRail.Imps, {
        accountNumber: "50100123456780",
        ifsc: "HDFC0001234",
      }),
    );
  });
});

describe("rail catalog", () => {
  it("orders a currency's rails fastest first", () => {
    const inr = railsForCurrency("INR");
    expect(inr.map((spec) => spec.rail)).toEqual([
      PayoutRail.Upi, // 10s
      PayoutRail.Imps, // 30s
      PayoutRail.Neft, // half-hourly batch
    ]);
  });

  it("gives every rail a cap above its floor and a non-negative fee", () => {
    for (const spec of railsForCurrency("USD").concat(
      railsForCurrency("EUR"),
      railsForCurrency("NGN"),
      railsForCurrency("INR"),
    )) {
      expect(BigInt(spec.maxAmount)).toBeGreaterThan(BigInt(spec.minAmount));
      expect(BigInt(spec.flatFeeAmount)).toBeGreaterThanOrEqual(0n);
      expect(spec.fields.length).toBeGreaterThan(0);
    }
  });
});
