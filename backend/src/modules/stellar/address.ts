/**
 * Stellar address validation at the boundary (Rules.md §2).
 *
 * Anything typed `Address` in a Soroban contract must be a real strkey before
 * it reaches an adapter. Passing an internal user id (a UUID) or an empty
 * string through to a contract call produces an opaque host error at simulation
 * time — or, worse, silently binds custody to the wrong account. These helpers
 * make the failure a 400 at the edge with the offending field named.
 */
import { StrKey } from "@stellar/stellar-sdk";
import { ValidationError } from "../../lib/errors.js";

/** True for a `G…` ed25519 account address. */
export function isAccountAddress(value: string): boolean {
  return StrKey.isValidEd25519PublicKey(value);
}

/** True for a `C…` contract address. */
export function isContractAddress(value: string): boolean {
  return StrKey.isValidContract(value);
}

/**
 * True for any address a Soroban `Address` argument accepts — an account or a
 * contract. Contracts can hold token balances, so a holder is not necessarily
 * an account.
 */
export function isStellarAddress(value: string): boolean {
  return isAccountAddress(value) || isContractAddress(value);
}

/** Narrow a `G…` account address or fail with a named-field 400. */
export function assertAccountAddress(value: unknown, field: string): string {
  if (typeof value !== "string" || !isAccountAddress(value)) {
    throw new ValidationError(`${field} must be a Stellar account address`, [
      { path: field, message: "expected a G… ed25519 public key" },
    ]);
  }
  return value;
}

/** Narrow a `C…` contract address or fail with a named-field 400. */
export function assertContractAddress(value: unknown, field: string): string {
  if (typeof value !== "string" || !isContractAddress(value)) {
    throw new ValidationError(`${field} must be a Stellar contract address`, [
      { path: field, message: "expected a C… contract id" },
    ]);
  }
  return value;
}

/** Narrow any Soroban-addressable value (account or contract). */
export function assertStellarAddress(value: unknown, field: string): string {
  if (typeof value !== "string" || !isStellarAddress(value)) {
    throw new ValidationError(`${field} must be a Stellar address`, [
      { path: field, message: "expected a G… account or C… contract address" },
    ]);
  }
  return value;
}
