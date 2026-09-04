/**
 * Treasury chain gateway — reads and writes real Stellar payments.
 *
 * Two implementations behind one interface (Rules.md §2):
 *   - {@link HorizonTreasuryGateway} talks to Horizon. It is what a testnet or
 *     production deployment uses, and it is the only one that can prove a
 *     payment happened.
 *   - {@link DeterministicTreasuryGateway} is a local/test double. Rules.md §2
 *     is emphatic that a deterministic adapter must reject exactly what the
 *     real one rejects, so it enforces the same rules — a payment must exist,
 *     be successful, and be addressed to the platform — against an in-memory
 *     set of payments a test declares.
 *
 * Neither decides whether a payment entitles anyone to a credit. That is the
 * service's judgement, and a gateway that made it would be a gateway that
 * could authorize money.
 */
import {
  Asset,
  BASE_FEE,
  Horizon,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { config } from "../../config/index.js";
import { ChainError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import type { Signer } from "../stellar/signer.js";
import { networkPassphrase } from "../stellar/stellar.client.js";
import type { ObservedPayment } from "./treasury.types.js";

export interface TreasuryGateway {
  /** The platform's own Stellar address — where deposits are sent. */
  treasuryAddress(): Promise<string>;
  /**
   * Every payment operation in one transaction, as the chain reports it.
   *
   * Returns an empty array for a transaction that does not exist or carried no
   * payments — both mean "nothing here to credit", and distinguishing them
   * would leak whether an arbitrary hash exists.
   */
  findPayments(txHash: string): Promise<ObservedPayment[]>;
  /**
   * Send `amount` (decimal string, the chain's own scale) of `assetCode` from
   * the treasury to `destination`. Returns the transaction hash.
   */
  sendPayment(input: {
    destination: string;
    amount: string;
    assetCode: string;
  }): Promise<string>;
}

/** Horizon-backed gateway. The real one. */
export class HorizonTreasuryGateway implements TreasuryGateway {
  private readonly horizon: Horizon.Server;

  constructor(private readonly signer: Signer) {
    this.horizon = new Horizon.Server(config.HORIZON_URL);
  }

  async treasuryAddress(): Promise<string> {
    return this.signer.getPublicKey();
  }

  async findPayments(txHash: string): Promise<ObservedPayment[]> {
    try {
      const tx = await this.horizon.transactions().transaction(txHash).call();
      // A transaction that failed still exists on the ledger and still has
      // operations. Crediting one would credit a payment that moved nothing.
      if (!tx.successful) {
        return [];
      }

      const operations = await this.horizon
        .operations()
        .forTransaction(txHash)
        .limit(200)
        .call();

      const payments: ObservedPayment[] = [];
      for (const op of operations.records) {
        // `payment` is the ordinary case. `create_account` is included because
        // funding a brand-new account *is* how the first XLM reaches it, and
        // treating that as "not a payment" would make a user's first deposit
        // the one that cannot be claimed.
        if (op.type === "payment") {
          const payment = op as Horizon.ServerApi.PaymentOperationRecord;
          payments.push({
            txHash,
            from: payment.from,
            to: payment.to,
            assetCode:
              payment.asset_type === "native"
                ? "XLM"
                : String(payment.asset_code),
            amount: payment.amount,
            successful: true,
            createdAt: payment.created_at,
            ledgerSequence: Number(tx.ledger_attr ?? tx.ledger),
          });
        } else if (op.type === "create_account") {
          const created = op as Horizon.ServerApi.CreateAccountOperationRecord;
          payments.push({
            txHash,
            from: created.funder,
            to: created.account,
            assetCode: "XLM",
            amount: created.starting_balance,
            successful: true,
            createdAt: created.created_at,
            ledgerSequence: Number(tx.ledger_attr ?? tx.ledger),
          });
        }
      }
      return payments;
    } catch (err) {
      // A 404 is "no such transaction", which is a legitimate answer to a user
      // pasting a hash — not an outage. Anything else is a chain failure and
      // must not be reported to the caller as "nothing found", because that
      // would turn a Horizon outage into a silently refused deposit.
      const status = (err as { response?: { status?: number } })?.response
        ?.status;
      if (status === 404) return [];
      throw new ChainError(`Failed to read transaction ${txHash}`, err);
    }
  }

  async sendPayment(input: {
    destination: string;
    amount: string;
    assetCode: string;
  }): Promise<string> {
    const source = await this.signer.getPublicKey();
    const passphrase = networkPassphrase();

    try {
      const account = await this.horizon.loadAccount(source);
      const asset =
        input.assetCode === "XLM"
          ? Asset.native()
          : this.resolveIssuedAsset(input.assetCode);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: passphrase,
      })
        .addOperation(
          Operation.payment({
            destination: input.destination,
            asset,
            amount: input.amount,
          }),
        )
        // Short: a withdrawal is submitted immediately, and a long window is a
        // transaction that can land after the caller has given up and retried.
        .setTimeout(60)
        .build();

      const signedXdr = await this.signer.signTransactionXdr(
        tx.toXDR(),
        passphrase,
      );
      const signed = TransactionBuilder.fromXDR(signedXdr, passphrase);
      const result = await this.horizon.submitTransaction(
        signed as Parameters<Horizon.Server["submitTransaction"]>[0],
      );
      return result.hash;
    } catch (err) {
      const resultCodes = (
        err as {
          response?: { data?: { extras?: { result_codes?: unknown } } };
        }
      )?.response?.data?.extras?.result_codes;
      logger.error(
        { destination: input.destination, assetCode: input.assetCode, resultCodes },
        "treasury payment submission failed",
      );
      throw new ChainError("Failed to submit the payout transaction", err);
    }
  }

  /**
   * A non-native asset needs an issuer, which lives in the token binding for
   * that currency. Only classic assets are payable this way; a Soroban-only
   * token has no `Asset` representation and must not be silently substituted.
   */
  private resolveIssuedAsset(assetCode: string): Asset {
    const issuer = config.TREASURY_ASSET_ISSUERS[assetCode];
    if (!issuer) {
      throw new ChainError(
        `No issuer configured for ${assetCode}. Set TREASURY_ASSET_ISSUERS ` +
          "before enabling withdrawals in it.",
      );
    }
    return new Asset(assetCode, issuer);
  }
}

/**
 * Deterministic gateway for local development and tests.
 *
 * Rules.md §2: a deterministic adapter must reject exactly what the real one
 * rejects. So it refuses an unknown hash and a failed transaction in the same
 * way Horizon's does, rather than accepting anything a test hands it.
 */
export class DeterministicTreasuryGateway implements TreasuryGateway {
  private readonly payments = new Map<string, ObservedPayment[]>();
  private readonly sent: Array<{
    destination: string;
    amount: string;
    assetCode: string;
    hash: string;
  }> = [];
  private sequence = 0;

  constructor(
    private readonly address = "GTREASURYDETERMINISTICADDRESSFORLOCALTESTSXXXXXXXXXXXXXXX",
  ) {}

  async treasuryAddress(): Promise<string> {
    return this.address;
  }

  /** Declare a payment the "chain" will report. Test-only. */
  declarePayment(payment: Partial<ObservedPayment> & { txHash: string }): void {
    const full: ObservedPayment = {
      from: "GDEPOSITORDETERMINISTICADDRESSFORLOCALTESTSXXXXXXXXXXXXXX",
      to: this.address,
      assetCode: "XLM",
      amount: "100.0000000",
      successful: true,
      createdAt: new Date().toISOString(),
      ledgerSequence: (this.sequence += 1),
      ...payment,
    };
    const existing = this.payments.get(full.txHash) ?? [];
    this.payments.set(full.txHash, [...existing, full]);
  }

  async findPayments(txHash: string): Promise<ObservedPayment[]> {
    const found = this.payments.get(txHash) ?? [];
    // Same rule as Horizon's: a failed transaction yields nothing creditable.
    return found.filter((payment) => payment.successful);
  }

  async sendPayment(input: {
    destination: string;
    amount: string;
    assetCode: string;
  }): Promise<string> {
    const hash = `det-payout-${(this.sequence += 1)
      .toString()
      .padStart(4, "0")}`;
    this.sent.push({ ...input, hash });
    return hash;
  }

  /** What this gateway was asked to send. Test-only. */
  sentPayments(): ReadonlyArray<{
    destination: string;
    amount: string;
    assetCode: string;
    hash: string;
  }> {
    return this.sent;
  }
}

/**
 * Choose the gateway for this deployment.
 *
 * The deterministic one is refused outside local/test for the same reason the
 * stub signer is: it cannot prove a payment happened, so a deployment using it
 * would credit balances against nothing.
 */
export function createTreasuryGateway(signer: Signer): TreasuryGateway {
  if (config.TREASURY_GATEWAY === "horizon") {
    return new HorizonTreasuryGateway(signer);
  }
  if (config.isProduction || config.NODE_ENV === "staging") {
    throw new Error(
      "TREASURY_GATEWAY=deterministic is local/test only; it cannot verify a " +
        "real payment. Set TREASURY_GATEWAY=horizon.",
    );
  }
  return new DeterministicTreasuryGateway();
}
