import { describe, expect, it, vi } from "vitest";
import { getWalletBalances } from "./wallet-balances.service.js";
import type { StellarClient } from "./stellar.client.js";

const ADDRESS = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ";

function stubClient(
  balances: Array<{ asset: string; balance: string }>,
): StellarClient {
  return {
    getAccount: vi.fn().mockResolvedValue({
      accountId: ADDRESS,
      subentryCount: 1,
      balances,
    }),
  } as unknown as StellarClient;
}

describe("getWalletBalances", () => {
  it("always reports native XLM regardless of token-contract config", async () => {
    const client = stubClient([{ asset: "native", balance: "128.5000000" }]);
    const response = await getWalletBalances(client, ADDRESS);
    expect(response.address).toBe(ADDRESS);
    expect(response.balances).toEqual([
      { currency: "XLM", balance: "128.5000000", rawUnits: "1285000000" },
    ]);
  });

  it("omits a trustline this deployment has no currency binding for", async () => {
    // EUR is a valid currency code but nothing binds a Soroban token contract
    // to it — exactly the case this filter must drop, regardless of which
    // Stellar-native currencies (like USDC) this deployment does bind.
    const client = stubClient([
      { asset: "native", balance: "50.0000000" },
      { asset: "EUR", balance: "5.0000000" },
    ]);
    const response = await getWalletBalances(client, ADDRESS);
    expect(response.balances.map((b) => b.currency)).toEqual(["XLM"]);
  });

  it("omits an asset code that is not a recognised currency at all", async () => {
    const client = stubClient([
      { asset: "native", balance: "50.0000000" },
      { asset: "SOMEJUNK", balance: "5.0000000" },
    ]);
    const response = await getWalletBalances(client, ADDRESS);
    expect(response.balances.map((b) => b.currency)).toEqual(["XLM"]);
  });

  it("handles precise fractional stroop amounts without float drift", async () => {
    const client = stubClient([
      { asset: "native", balance: "0.0000001" },
    ]);
    const response = await getWalletBalances(client, ADDRESS);
    expect(response.balances[0].rawUnits).toBe("1");
  });
});
