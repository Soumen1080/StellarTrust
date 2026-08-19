import { describe, expect, it } from "vitest";
import { decimalStringToBigInt } from "./decimal.js";

describe("decimalStringToBigInt", () => {
  it("converts a whole number", () => {
    expect(decimalStringToBigInt("128", 7)).toBe(1_280_000_000n);
  });

  it("converts a fractional Horizon balance to stroops", () => {
    expect(decimalStringToBigInt("128.5000000", 7)).toBe(1_285_000_000n);
  });

  it("pads a short fraction out to the target scale", () => {
    expect(decimalStringToBigInt("0.1", 7)).toBe(1_000_000n);
  });

  it("does not lose precision at the boundary", () => {
    // The finest possible XLM amount: one stroop.
    expect(decimalStringToBigInt("100.0000001", 7)).toBe(1_000_000_001n);
  });

  it("rejects more precision than the target scale can hold", () => {
    expect(() => decimalStringToBigInt("1.12345678", 7)).toThrow(/precision/);
  });

  it("rejects a non-decimal string", () => {
    expect(() => decimalStringToBigInt("abc", 7)).toThrow(/Not a plain decimal/);
  });
});
