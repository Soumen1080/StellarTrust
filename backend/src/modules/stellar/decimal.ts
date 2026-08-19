/**
 * Exact decimal-string ↔ integer conversion for on-chain amounts.
 *
 * Horizon reports balances as fixed-point decimal strings ("128.5000000").
 * `Number()` loses precision above 2^53 and drifts on repeating fractions —
 * unacceptable for money — so this parses the string directly into a BigInt
 * at a given scale.
 */
export function decimalStringToBigInt(value: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) {
    throw new Error(`Not a plain decimal amount: ${value}`);
  }
  const [, whole, fraction = ""] = match;
  if (fraction.length > decimals) {
    throw new Error(
      `${value} has more precision than ${decimals} decimals can hold`,
    );
  }
  const paddedFraction = fraction.padEnd(decimals, "0");
  return BigInt(whole + paddedFraction);
}
