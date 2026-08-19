/**
 * XLM reserve-safety check: locking XLM into escrow must not strand the
 * buyer's wallet below Stellar's own minimum reserve + a fee buffer.
 */
import { describe, expect, it } from "vitest";
import { assertXlmReserveSafety } from "./escrow.gateway.js";
import type { AccountSummary } from "../stellar/stellar.client.js";

const FEE_BUFFER = 5_000_000n; // 0.5 XLM

function account(balanceXlm: string, subentryCount = 0): AccountSummary {
  return {
    accountId: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ",
    subentryCount,
    balances: [{ asset: "native", balance: balanceXlm }],
  };
}

describe("assertXlmReserveSafety", () => {
  it("allows a lock comfortably within reserve + buffer", () => {
    // 100 XLM balance, 0 subentries: min reserve 1 XLM + 0.5 buffer = 1.5 XLM
    // required beyond the lock. Locking 10 XLM leaves 90, well above 1.5.
    expect(() =>
      assertXlmReserveSafety(account("100.0000000"), 100_000_000n, FEE_BUFFER),
    ).not.toThrow();
  });

  it("allows a lock that leaves exactly the required reserve", () => {
    // balance = lock + minReserve(2 subentries -> 2 XLM) + buffer(0.5 XLM)
    const lock = 10_000_000n; // 1 XLM
    const minReserve = 20_000_000n; // (2 + 2) * 0.5 XLM
    const balance = lock + minReserve + FEE_BUFFER;
    expect(() =>
      assertXlmReserveSafety(
        account((Number(balance) / 10_000_000).toFixed(7), 2),
        lock,
        FEE_BUFFER,
      ),
    ).not.toThrow();
  });

  it("blocks a lock that would leave the wallet below the account reserve", () => {
    // 2 XLM balance, 0 subentries (1 XLM min reserve + 0.5 buffer required
    // beyond the lock). Locking 1.6 XLM only leaves 0.4, short of 1.5.
    expect(() =>
      assertXlmReserveSafety(account("2.0000000"), 16_000_000n, FEE_BUFFER),
    ).toThrow(/minimum reserve/);
  });

  it("accounts for subentries (trustlines/offers/signers) in the reserve", () => {
    // 12 XLM balance, locking 1 XLM. With 20 subentries the min reserve is
    // (2 + 20) * 0.5 = 11 XLM, so required (1 + 11 + 0.5 = 12.5) exceeds the
    // 12 XLM balance even though the lock amount alone looks affordable.
    expect(() =>
      assertXlmReserveSafety(account("12.0000000", 20), 10_000_000n, FEE_BUFFER),
    ).toThrow(/minimum reserve/);
  });

  it("treats a missing native balance entry as zero", () => {
    const noNative: AccountSummary = {
      accountId: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ",
      subentryCount: 0,
      balances: [],
    };
    expect(() =>
      assertXlmReserveSafety(noNative, 1n, FEE_BUFFER),
    ).toThrow(/minimum reserve/);
  });
});
