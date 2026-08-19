/**
 * Read a connected wallet's real Horizon balances (native XLM + any classic
 * trustline this deployment knows how to name — i.e. has a
 * `STELLAR_TOKEN_CONTRACTS` binding for). Read-only: no ledger/escrow state
 * is touched, so this cannot itself move or misrecord value.
 */
import {
  SUPPORTED_CURRENCIES,
  type CurrencyCode,
  type WalletBalanceEntry,
  type WalletBalancesResponse,
} from "@stellartrust/shared";
import { config } from "../../config/index.js";
import { decimalStringToBigInt } from "./decimal.js";
import type { StellarClient } from "./stellar.client.js";

const HORIZON_ASSET_DECIMALS = 7;

function isCurrencyCode(value: string): value is CurrencyCode {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

export async function getWalletBalances(
  client: StellarClient,
  address: string,
): Promise<WalletBalancesResponse> {
  const account = await client.getAccount(address);
  const knownAssetCodes = new Set(Object.keys(config.STELLAR_TOKEN_CONTRACTS));

  const balances: WalletBalanceEntry[] = [];
  for (const entry of account.balances) {
    const code = entry.asset === "native" ? "XLM" : entry.asset;
    if (!isCurrencyCode(code)) continue;
    // Only report an asset this deployment can actually name a currency for
    // (native XLM always qualifies; a classic trustline must be bound).
    if (code !== "XLM" && !knownAssetCodes.has(code)) continue;
    balances.push({
      currency: code,
      balance: entry.balance,
      rawUnits: decimalStringToBigInt(
        entry.balance,
        HORIZON_ASSET_DECIMALS,
      ).toString(),
    });
  }

  return { address, network: config.STELLAR_NETWORK, balances };
}
