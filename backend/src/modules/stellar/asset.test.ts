/**
 * Ledger ↔ token amount conversion.
 *
 * An off-by-a-power-of-ten here locks or releases the wrong amount of real
 * value, and nothing downstream would notice: both numbers are valid integers.
 */
import { CurrencyCode } from "@stellartrust/shared";
import { describe, expect, it } from "vitest";
import {
  fromTokenAmount,
  toTokenAmount,
  tokenBindingByContractId,
  type TokenBinding,
} from "./asset.js";
import { isAccountAddress, isContractAddress, isStellarAddress } from "./address.js";

/** A classic Stellar asset contract: 7 decimals, ledger records cents. */
const USDC: TokenBinding = {
  currency: CurrencyCode.USDC,
  contractId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  decimals: 7,
};

/** XLM's ledger minor unit already is the stroop — no shift at all. */
const XLM: TokenBinding = { ...USDC, currency: CurrencyCode.XLM, decimals: 7 };

describe("toTokenAmount", () => {
  it("scales cents to stroops", () => {
    // 125.00 USDC → 1_250_000_000 stroops (2-dp ledger, 7-dp token).
    expect(toTokenAmount("12500", USDC)).toBe(1_250_000_000n);
  });

  it("does not shift a currency whose minor unit is already the token unit", () => {
    expect(toTokenAmount("12500", XLM)).toBe(12_500n);
  });

  it("handles amounts beyond Number.MAX_SAFE_INTEGER without drift", () => {
    // 10^15 cents is past the float boundary once scaled; bigint math must hold.
    expect(toTokenAmount("1000000000000000", USDC)).toBe(
      100_000_000_000_000_000_000n,
    );
  });

  it("rejects a non-integer amount", () => {
    expect(() => toTokenAmount("12.50", USDC)).toThrow(/minor-unit integer/);
  });

  it("rejects zero", () => {
    expect(() => toTokenAmount("0", USDC)).toThrow(/greater than zero/);
  });

  it("refuses to truncate when the token is coarser than the ledger", () => {
    const coarse: TokenBinding = { ...USDC, decimals: 0 };
    expect(() => toTokenAmount("12500", coarse)).toThrow(/truncate value/);
  });
});

describe("fromTokenAmount", () => {
  it("round-trips", () => {
    expect(fromTokenAmount(toTokenAmount("12500", USDC), USDC)).toBe("12500");
  });

  it("surfaces on-chain precision the ledger cannot hold", () => {
    // One stroop is finer than a cent: reconciliation must report this rather
    // than silently rounding a real balance to something the books like.
    expect(() => fromTokenAmount(1_250_000_001n, USDC)).toThrow(
      /without losing precision/,
    );
  });
});

describe("tokenBindingByContractId", () => {
  // Reading custody back yields a token address, not a currency. Without this
  // reverse lookup the amount in an escrow could not be expressed in ledger
  // units at all, and reconciliation would be left comparing state only.
  it("returns nothing for a token this deployment has no binding for", () => {
    // The test environment configures no token contracts, so every lookup is
    // an unrecognised one — which is itself the signal reconciliation acts on.
    expect(tokenBindingByContractId(USDC.contractId)).toBeUndefined();
  });
});

describe("address validation", () => {
  const account = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ";
  const contract = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

  it("separates accounts from contracts", () => {
    expect(isAccountAddress(account)).toBe(true);
    expect(isAccountAddress(contract)).toBe(false);
    expect(isContractAddress(contract)).toBe(true);
    expect(isContractAddress(account)).toBe(false);
    expect(isStellarAddress(account) && isStellarAddress(contract)).toBe(true);
  });

  it("rejects the values that actually reached contracts before", () => {
    // A DB user id and an empty string: both were previously passed straight
    // through to a Soroban `Address` argument.
    expect(isStellarAddress("8b1f0f2e-0b6e-4a1e-9f6b-1f2a3b4c5d6e")).toBe(false);
    expect(isStellarAddress("")).toBe(false);
  });
});
