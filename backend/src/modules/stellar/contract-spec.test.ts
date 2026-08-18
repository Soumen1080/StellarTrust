/**
 * The hand-written contract clients still describe the deployed contracts.
 *
 * `contract.Client` builds its methods from the on-chain spec at runtime, and
 * the gateways type that dynamic object with a structural `interface` plus an
 * `as unknown as` cast. TypeScript therefore checks the gateways against those
 * interfaces and never against the contracts — a renamed Rust argument stays
 * green through `tsc`, through `cargo test`, and fails for the first time
 * against a real network.
 *
 * This test asserts the surface the gateways actually invoke against
 * `contracts/contract-spec.json`, which `contracts/scripts/check-bindings.mjs`
 * regenerates from the built WASM in CI. Rust drifts → the manifest check
 * fails; the manifest is updated → this test fails until the TypeScript
 * follows.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface SpecFunction {
  name: string;
  args: string[];
}

const MANIFEST = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../contracts/contract-spec.json",
);

const spec = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<
  string,
  SpecFunction[]
>;

function signature(pkg: string, name: string): SpecFunction {
  const fn = spec[pkg]?.find((entry) => entry.name === name);
  if (!fn) {
    throw new Error(
      `${pkg} has no '${name}' function in contracts/contract-spec.json`,
    );
  }
  return fn;
}

/**
 * Calls made by {@link SorobanRpcEscrowGateway}, with the argument names it
 * passes. Keep in step with `EscrowContractClient`.
 */
const ESCROW_CALLS: SpecFunction[] = [
  {
    name: "initialize",
    args: ["buyer", "seller", "arbiter", "token_id", "amount", "order_ref"],
  },
  { name: "confirm_delivery", args: [] },
  { name: "release", args: [] },
  { name: "refund", args: [] },
  { name: "dispute", args: ["by"] },
  { name: "get", args: [] },
];

/**
 * Calls made by {@link SorobanRpcRwaGateway}. Keep in step with
 * `RwaContractClient`.
 */
const RWA_CALLS: SpecFunction[] = [
  {
    name: "initialize",
    args: [
      "issuer",
      "asset_ref",
      "asset_type",
      "description",
      "total_units",
      "require_authorization",
    ],
  },
  { name: "transfer", args: ["from", "to", "units"] },
  { name: "balance_of", args: ["holder"] },
  { name: "authorize", args: ["address"] },
  { name: "revoke_authorization", args: ["address"] },
  { name: "freeze", args: [] },
  { name: "unfreeze", args: [] },
  { name: "is_authorized", args: ["address"] },
  { name: "get_holders", args: [] },
  { name: "mark_distributed", args: [] },
  { name: "all_payout_shares", args: ["payout"] },
  { name: "get_meta", args: [] },
];

describe("escrow gateway matches the escrow contract spec", () => {
  it.each(ESCROW_CALLS)("$name", (call) => {
    // Argument ORDER matters as much as the names: the SDK converts positional
    // Rust inputs from a named object, so a reordered contract signature binds
    // the wrong values without any type error.
    expect(signature("escrow", call.name)).toEqual(call);
  });
});

describe("RWA gateway matches the rwa_token contract spec", () => {
  it.each(RWA_CALLS)("$name", (call) => {
    expect(signature("rwa_token", call.name)).toEqual(call);
  });
});

describe("contract functions the backend deliberately does not call", () => {
  // Named rather than ignored, so removing one from Rust is a decision someone
  // makes here instead of a silent capability loss.
  it("escrow.state is superseded by get()", () => {
    expect(signature("escrow", "state")).toEqual({ name: "state", args: [] });
  });

  it("rwa_token.payout_share is superseded by all_payout_shares()", () => {
    expect(signature("rwa_token", "payout_share")).toEqual({
      name: "payout_share",
      args: ["holder", "payout"],
    });
  });
});
