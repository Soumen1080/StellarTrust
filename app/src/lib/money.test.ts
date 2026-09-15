/**
 * Money conversion tests.
 *
 * This is the code most able to quietly corrupt a number a user acts on, so
 * the cases here are the ones that break naive implementations: XLM's 7dp
 * scale against the 2dp fiat/USDC scale, trailing zeros, and precision the
 * currency cannot represent.
 *
 * Note the scales deliberately: USDC is 2dp on the *ledger*
 * (LEDGER_CURRENCY_DECIMALS), even though the Stellar asset itself carries 7.
 * Using the wrong one is a 10^5 error, which is exactly what these pin down.
 */
import {
  formatAmount,
  formatMoney,
  fromMinorUnits,
  shortenAddress,
  toMinorUnits,
} from "./money";

describe("toMinorUnits", () => {
  it("scales a whole amount to the currency's ledger decimals", () => {
    expect(toMinorUnits("10", "USDC")).toBe("1000");
    expect(toMinorUnits("10", "XLM")).toBe("100000000");
  });

  it("pads a short fraction rather than truncating it", () => {
    // "12.5" is 12.50, not 12.5 — a missing pad is a factor-of-ten error.
    expect(toMinorUnits("12.5", "USDC")).toBe("1250");
    expect(toMinorUnits("12.5", "XLM")).toBe("125000000");
  });

  it("rejects more precision than the currency can represent", () => {
    // Accepting these would silently drop the trailing digits.
    expect(toMinorUnits("1.123", "USDC")).toBeNull();
    expect(toMinorUnits("1.12345678", "XLM")).toBeNull();
  });

  it("accepts precision exactly at the currency's scale", () => {
    expect(toMinorUnits("1.12", "USDC")).toBe("112");
    expect(toMinorUnits("1.1234567", "XLM")).toBe("11234567");
  });

  it("rejects anything that is not a plain positive decimal", () => {
    for (const bad of ["", "-1", "1e3", "1,000", "abc", "1.2.3", " ", "."]) {
      expect(toMinorUnits(bad, "USDC")).toBeNull();
    }
  });

  it("normalizes leading zeros without destroying a zero amount", () => {
    expect(toMinorUnits("007", "USDC")).toBe("700");
    expect(toMinorUnits("0", "USDC")).toBe("0");
    expect(toMinorUnits("0.00", "USDC")).toBe("0");
  });

  it("round-trips through fromMinorUnits", () => {
    for (const value of ["0.01", "1", "999.99", "12.5"]) {
      const minor = toMinorUnits(value, "USDC");
      expect(minor).not.toBeNull();
      expect(fromMinorUnits(minor as string, "USDC")).toBe(Number(value));
    }
    // The 7dp scale is where float math would drift.
    const xlm = toMinorUnits("1.2345678", "XLM");
    expect(fromMinorUnits(xlm as string, "XLM")).toBe(1.2345678);
  });
});

describe("formatAmount", () => {
  it("shows two decimals for a whole amount", () => {
    expect(formatAmount("1000", "USDC")).toBe("10.00");
  });

  it("groups thousands", () => {
    expect(formatAmount("125000", "USDC")).toBe("1,250.00");
  });

  it("keeps significant decimals beyond two at a wider scale", () => {
    // 0.125 XLM must not be rounded to 0.13 in a display of someone's balance.
    expect(formatAmount("1250000", "XLM")).toBe("0.125");
  });

  it("compacts only large values, and only when asked", () => {
    expect(formatAmount("5000000", "USDC", { compact: true })).toBe("50K");
    expect(formatAmount("100", "USDC", { compact: true })).toBe("1.00");
  });

  it("appends the currency in formatMoney", () => {
    expect(formatMoney("1000", "USDC")).toBe("10.00 USDC");
  });
});

describe("shortenAddress", () => {
  const address = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

  it("keeps both ends so the value stays checkable", () => {
    const short = shortenAddress(address);
    expect(short.startsWith("GA5Z")).toBe(true);
    expect(short.endsWith("KZVN")).toBe(true);
  });

  it("leaves a short value alone rather than adding an ellipsis", () => {
    expect(shortenAddress("GABC")).toBe("GABC");
  });
});
