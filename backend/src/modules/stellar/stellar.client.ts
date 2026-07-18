/**
 * Stellar SDK wrappers (Phase 0).
 *
 * Thin adapter around @stellar/stellar-sdk so the rest of the backend depends on
 * our interface, not the SDK directly (Rules.md §2: wrap external systems behind
 * adapters). Classic Stellar (Horizon) handles payments/liquidity; Soroban RPC
 * handles contract calls (escrow/RWA). The double-entry ledger — not the chain —
 * remains the system of record.
 */
import { Horizon, Networks, rpc } from "@stellar/stellar-sdk";
import { config } from "../../config/index.js";
import { ChainError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";

export function networkPassphrase(): string {
  return config.STELLAR_NETWORK === "public"
    ? Networks.PUBLIC
    : Networks.TESTNET;
}

export interface AccountSummary {
  accountId: string;
  balances: Array<{ asset: string; balance: string }>;
}

export class StellarClient {
  private readonly horizon: Horizon.Server;
  private readonly soroban: rpc.Server;

  constructor() {
    this.horizon = new Horizon.Server(config.HORIZON_URL);
    this.soroban = new rpc.Server(config.SOROBAN_RPC_URL, {
      allowHttp: config.HORIZON_URL.startsWith("http://"),
    });
  }

  /** Liveness check against Horizon; used by /health/deep and reconciliation. */
  async horizonHealthy(): Promise<boolean> {
    try {
      await this.horizon.ledgers().order("desc").limit(1).call();
      return true;
    } catch (err) {
      logger.warn({ err }, "horizon health check failed");
      return false;
    }
  }

  /** Fetch account balances (read-only). */
  async getAccount(accountId: string): Promise<AccountSummary> {
    try {
      const account = await this.horizon.loadAccount(accountId);
      return {
        accountId,
        balances: account.balances.map((b) => ({
          asset: "asset_code" in b ? String(b.asset_code) : b.asset_type,
          balance: b.balance,
        })),
      };
    } catch (err) {
      throw new ChainError(`Failed to load account ${accountId}`, err);
    }
  }

  /** Soroban RPC health probe. */
  async sorobanHealthy(): Promise<boolean> {
    try {
      await this.soroban.getHealth();
      return true;
    } catch (err) {
      logger.warn({ err }, "soroban rpc health check failed");
      return false;
    }
  }
}
