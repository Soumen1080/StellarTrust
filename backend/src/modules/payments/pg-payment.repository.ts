/**
 * Postgres-backed payment/escrow/ledger persistence.
 *
 * Implements the same {@link PaymentRepository} contract as the in-memory
 * variant, writing to the schema from migrations 0001 (`orders`, `escrows`,
 * `ledger_*`, `stellar_transactions`) and 0004 (`payment_transitions`,
 * `reconciliation_mismatches`). Because orders and their balanced ledger
 * transactions live in Postgres, a wallet's full transaction history survives
 * logout/login and process restarts (and is shared across serverless
 * invocations, which the in-memory store cannot do).
 *
 * A financial transition is committed inside ONE database transaction so an
 * order state can never exist without its balanced ledger transaction and
 * linked Stellar transaction record. The database-level deferred constraint
 * triggers (`ledger_balance_check`, `payment_transition_link_check`) are the
 * final backstop and fire at COMMIT.
 *
 * Parameterized queries only (Rules.md §7).
 */
import type pg from "pg";
import {
  ChainTxStatus,
  type EntryDirection,
  type CurrencyCode,
  type EscrowDTO,
  type LedgerEntryDTO,
  type LedgerTransactionDTO,
  type OrderDTO,
  type OrderStatus,
  type PaymentTransition,
  type PaymentTransitionDTO,
  type ReconciliationMismatchDTO,
  type StellarTxRecord,
} from "@stellartrust/shared";
import { ConflictError } from "../../lib/errors.js";
import { assertBalanced } from "../ledger/ledger.balance.js";
import type {
  CustodyStateCommit,
  FinancialTransitionCommit,
  PaymentRepository,
} from "./payment.repository.js";

/**
 * The payment service posts ledger entries against fixed synthetic account
 * ids (one per account "role", currency-agnostic). The real chart of accounts
 * in Postgres is currency-specific (`ledger_accounts` is unique on
 * owner_ref+currency+name), so each synthetic id maps to a system account
 * NAME which is then resolved to the concrete per-currency account id at write
 * time. These names match the seeds in migrations 0002/0004.
 */
const SYNTHETIC_ACCOUNT_NAME: Readonly<Record<string, string>> = {
  "10000000-0000-4000-8000-000000000001": "commitment_asset",
  "20000000-0000-4000-8000-000000000002": "commitment_liability",
  "30000000-0000-4000-8000-000000000003": "cash_clearing",
  "40000000-0000-4000-8000-000000000004": "escrow_holding",
  "50000000-0000-4000-8000-000000000005": "contract_custody",
  "60000000-0000-4000-8000-000000000006": "delivery_confirmation_asset",
  "70000000-0000-4000-8000-000000000007": "delivery_confirmation_liability",
};

/** Postgres timestamptz columns arrive as Date; normalize to ISO strings. */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** bigint columns arrive as strings from node-pg; keep them as strings. */
function toAmount(value: string | number): string {
  return typeof value === "number" ? String(value) : value;
}

interface OrderRow {
  id: string;
  buyer_id: string;
  seller_id: string;
  amount: string;
  currency: string;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface EscrowRow {
  id: string;
  order_id: string;
  contract_id: string | null;
  state: string;
  created_at: Date | string;
  updated_at: Date | string;
}

export class PgPaymentRepository implements PaymentRepository {
  /** Cache of resolved `${name}:${currency}` → account id. */
  private readonly accountIdCache = new Map<string, string>();

  constructor(private readonly pool: pg.Pool) {}

  private mapOrder(row: OrderRow): OrderDTO {
    return {
      id: row.id,
      buyerId: row.buyer_id,
      sellerId: row.seller_id,
      amount: {
        amount: toAmount(row.amount),
        currency: row.currency as CurrencyCode,
      },
      status: row.status as OrderStatus,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  private mapEscrow(row: EscrowRow): EscrowDTO {
    return {
      id: row.id,
      orderId: row.order_id,
      contractId: row.contract_id,
      state: row.state as EscrowDTO["state"],
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  async findOrder(orderId: string): Promise<OrderDTO | undefined> {
    const { rows } = await this.pool.query<OrderRow>(
      `select id, buyer_id, seller_id, amount, currency, status, created_at, updated_at
       from orders where id = $1`,
      [orderId],
    );
    return rows[0] ? this.mapOrder(rows[0]) : undefined;
  }

  async listOrders(userId: string): Promise<OrderDTO[]> {
    const { rows } = await this.pool.query<OrderRow>(
      `select id, buyer_id, seller_id, amount, currency, status, created_at, updated_at
       from orders
       where buyer_id = $1 or seller_id = $1
       order by created_at desc`,
      [userId],
    );
    return rows.map((row) => this.mapOrder(row));
  }

  async findEscrow(orderId: string): Promise<EscrowDTO | undefined> {
    const { rows } = await this.pool.query<EscrowRow>(
      `select id, order_id, contract_id, state, created_at, updated_at
       from escrows where order_id = $1`,
      [orderId],
    );
    return rows[0] ? this.mapEscrow(rows[0]) : undefined;
  }

  async saveCustodyState(input: CustodyStateCommit): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `update orders set status = $2, updated_at = $3 where id = $1`,
        [input.order.id, input.order.status, input.order.updatedAt],
      );
      if (input.escrow) {
        await client.query(
          `insert into escrows
             (id, order_id, contract_id, state, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (order_id) do update
             set contract_id = excluded.contract_id,
                 state = excluded.state,
                 updated_at = excluded.updated_at`,
          [
            input.escrow.id,
            input.escrow.orderId,
            input.escrow.contractId,
            input.escrow.state,
            input.escrow.createdAt,
            input.escrow.updatedAt,
          ],
        );
      }
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async listTransitions(orderId?: string): Promise<PaymentTransitionDTO[]> {
    const { rows } = await this.pool.query(
      `select
         pt.id, pt.order_id, pt.transition, pt.actor_id, pt.created_at,
         lt.id as ledger_id, lt.reference_id, lt.description,
         lt.created_at as ledger_created_at,
         st.id as stellar_id, st.hash, st.type, st.status,
         st.ledger_transaction_id, st.created_at as stellar_created_at
       from payment_transitions pt
       join ledger_transactions lt on lt.id = pt.ledger_transaction_id
       join stellar_transactions st on st.id = pt.stellar_transaction_id
       where ($1::uuid is null or pt.order_id = $1)
       order by pt.created_at asc`,
      [orderId ?? null],
    );
    if (rows.length === 0) return [];

    // Hydrate entries for every referenced ledger transaction in one query.
    const ledgerIds = [...new Set(rows.map((row) => row.ledger_id as string))];
    const { rows: entryRows } = await this.pool.query(
      `select id, transaction_id, account_id, direction, amount, currency, created_at
       from ledger_entries
       where transaction_id = any($1::uuid[])
       order by created_at asc`,
      [ledgerIds],
    );
    const entriesByLedger = new Map<string, LedgerEntryDTO[]>();
    for (const entry of entryRows) {
      const list = entriesByLedger.get(entry.transaction_id) ?? [];
      list.push({
        id: entry.id,
        transactionId: entry.transaction_id,
        accountId: entry.account_id,
        direction: entry.direction as EntryDirection,
        amount: toAmount(entry.amount),
        currency: entry.currency as CurrencyCode,
        createdAt: toIso(entry.created_at),
      });
      entriesByLedger.set(entry.transaction_id, list);
    }

    return rows.map((row) => {
      const ledgerTransaction: LedgerTransactionDTO = {
        id: row.ledger_id,
        referenceId: row.reference_id,
        description: row.description,
        createdAt: toIso(row.ledger_created_at),
        entries: entriesByLedger.get(row.ledger_id) ?? [],
      };
      const stellarTransaction: StellarTxRecord = {
        id: row.stellar_id,
        hash: row.hash,
        type: row.type,
        status: row.status as ChainTxStatus,
        ledgerTransactionId: row.ledger_transaction_id,
        createdAt: toIso(row.stellar_created_at),
      };
      return {
        id: row.id,
        orderId: row.order_id,
        transition: row.transition as PaymentTransition,
        actorId: row.actor_id,
        ledgerTransaction,
        stellarTransaction,
        createdAt: toIso(row.created_at),
      };
    });
  }

  /**
   * Resolve a synthetic (currency-agnostic) account id to the concrete system
   * account id for the given currency, caching the result. Runs on the same
   * client/transaction the caller is committing in.
   */
  private async resolveAccountId(
    client: pg.PoolClient,
    syntheticId: string,
    currency: string,
  ): Promise<string> {
    const name = SYNTHETIC_ACCOUNT_NAME[syntheticId];
    if (!name) {
      throw new Error(`Unknown ledger account id ${syntheticId}`);
    }
    const cacheKey = `${name}:${currency}`;
    const cached = this.accountIdCache.get(cacheKey);
    if (cached) return cached;

    const { rows } = await client.query<{ id: string }>(
      `select id from ledger_accounts
       where owner_ref = 'system' and currency = $1 and name = $2`,
      [currency, name],
    );
    const id = rows[0]?.id;
    if (!id) {
      throw new Error(
        `System ledger account '${name}' (${currency}) is not seeded`,
      );
    }
    this.accountIdCache.set(cacheKey, id);
    return id;
  }

  async commitTransition(
    input: FinancialTransitionCommit,
  ): Promise<PaymentTransitionDTO> {
    assertBalanced(input.ledger.entries);

    const client = await this.pool.connect();
    try {
      await client.query("begin");

      // 1) Order (insert on create, update status/updated_at on transition).
      await client.query(
        `insert into orders
           (id, buyer_id, seller_id, amount, currency, status, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (id) do update
           set status = excluded.status, updated_at = excluded.updated_at`,
        [
          input.order.id,
          input.order.buyerId,
          input.order.sellerId,
          input.order.amount.amount,
          input.order.amount.currency,
          input.order.status,
          input.order.createdAt,
          input.order.updatedAt,
        ],
      );

      // 2) Escrow (present from the lock transition onward).
      if (input.escrow) {
        await client.query(
          `insert into escrows
             (id, order_id, contract_id, state, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (order_id) do update
             set contract_id = excluded.contract_id,
                 state = excluded.state,
                 updated_at = excluded.updated_at`,
          [
            input.escrow.id,
            input.escrow.orderId,
            input.escrow.contractId,
            input.escrow.state,
            input.escrow.createdAt,
            input.escrow.updatedAt,
          ],
        );
      }

      // 3) Ledger transaction header. A duplicate reference id means this
      //    financial transition was already recorded.
      const ledgerInsert = await client.query<{ id: string; created_at: Date }>(
        `insert into ledger_transactions (reference_id, description)
         values ($1, $2)
         returning id, created_at`,
        [input.ledger.referenceId, input.ledger.description],
      );
      const ledgerRow = ledgerInsert.rows[0];
      if (!ledgerRow) throw new Error("Failed to create ledger transaction");
      const ledgerId = ledgerRow.id;
      const ledgerCreatedAt = toIso(ledgerRow.created_at);

      // 4) Ledger entries — the deferred balance trigger validates at commit.
      const entries: LedgerEntryDTO[] = [];
      for (const entry of input.ledger.entries) {
        const accountId = await this.resolveAccountId(
          client,
          entry.accountId,
          entry.currency,
        );
        const entryInsert = await client.query<{ id: string; created_at: Date }>(
          `insert into ledger_entries
             (transaction_id, account_id, direction, amount, currency)
           values ($1, $2, $3, $4, $5)
           returning id, created_at`,
          [ledgerId, accountId, entry.direction, entry.amount, entry.currency],
        );
        const entryRow = entryInsert.rows[0];
        if (!entryRow) throw new Error("Failed to create ledger entry");
        entries.push({
          id: entryRow.id,
          transactionId: ledgerId,
          accountId,
          direction: entry.direction,
          amount: entry.amount,
          currency: entry.currency,
          createdAt: toIso(entryRow.created_at),
        });
      }

      // 5) Stellar transaction, carrying the payment metadata group required by
      //    the `stellar_payment_metadata_complete` check + linkage trigger.
      const stellarInsert = await client.query<{ id: string; created_at: Date }>(
        `insert into stellar_transactions
           (hash, type, status, ledger_transaction_id, order_id, transition,
            amount, currency, contract_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning id, created_at`,
        [
          input.chain.hash,
          input.chain.type,
          input.chain.status ?? ChainTxStatus.Pending,
          ledgerId,
          input.order.id,
          input.chain.transition,
          input.chain.amount,
          input.chain.currency,
          input.chain.contractId,
        ],
      );
      const stellarRow = stellarInsert.rows[0];
      if (!stellarRow) throw new Error("Failed to create stellar transaction");

      // 6) Payment transition — the deferred link trigger validates at commit.
      const transitionInsert = await client.query<{ id: string; created_at: Date }>(
        `insert into payment_transitions
           (order_id, transition, actor_id, ledger_transaction_id,
            stellar_transaction_id)
         values ($1, $2, $3, $4, $5)
         returning id, created_at`,
        [
          input.order.id,
          input.chain.transition,
          input.actorId,
          ledgerId,
          stellarRow.id,
        ],
      );
      const transitionRow = transitionInsert.rows[0];
      if (!transitionRow) throw new Error("Failed to create payment transition");

      await client.query("commit");

      const ledgerTransaction: LedgerTransactionDTO = {
        id: ledgerId,
        referenceId: input.ledger.referenceId,
        description: input.ledger.description,
        createdAt: ledgerCreatedAt,
        entries,
      };
      const stellarTransaction: StellarTxRecord = {
        id: stellarRow.id,
        hash: input.chain.hash,
        type: input.chain.type,
        status: input.chain.status ?? ChainTxStatus.Pending,
        ledgerTransactionId: ledgerId,
        createdAt: toIso(stellarRow.created_at),
      };
      return {
        id: transitionRow.id,
        orderId: input.order.id,
        transition: input.chain.transition,
        actorId: input.actorId,
        ledgerTransaction,
        stellarTransaction,
        createdAt: toIso(transitionRow.created_at),
      };
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      // 23505 = unique_violation. The unique fields we write (ledger reference
      // id, (order_id, transition), stellar hash) all indicate the same money
      // movement was already recorded.
      if (isUniqueViolation(err)) {
        throw new ConflictError(
          "Financial transition has already been recorded",
        );
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async hasUnresolvedMismatch(orderId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `select 1 from reconciliation_mismatches
       where order_id = $1 and status = 'open' limit 1`,
      [orderId],
    );
    return rows.length > 0;
  }

  async replaceMismatches(
    mismatches: ReconciliationMismatchDTO[],
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");

      const activeTransitionIds = mismatches.map((item) => item.transitionId);

      // Resolve any currently-open mismatch that is no longer being reported.
      // The `reconciliation_block_sync` trigger clears the order block when the
      // last open mismatch for that order is resolved.
      await client.query(
        `update reconciliation_mismatches
         set status = 'resolved', resolved_at = now()
         where status = 'open'
           and not (payment_transition_id = any($1::uuid[]))`,
        [activeTransitionIds],
      );

      // Open a mismatch for each reported transition that has none open yet.
      // The partial unique index (one open row per transition) makes this a
      // no-op when an open row already exists.
      for (const mismatch of mismatches) {
        await client.query(
          `insert into reconciliation_mismatches
             (order_id, payment_transition_id, reason, status)
           values ($1, $2, $3, 'open')
           on conflict (payment_transition_id) where status = 'open'
             do nothing`,
          [mismatch.orderId, mismatch.transitionId, mismatch.reason],
        );
      }

      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async listUnresolvedMismatches(): Promise<ReconciliationMismatchDTO[]> {
    const { rows } = await this.pool.query(
      `select id, order_id, payment_transition_id, reason, detected_at, resolved_at
       from reconciliation_mismatches
       where status = 'open'
       order by detected_at asc`,
    );
    return rows.map((row) => ({
      id: row.id,
      orderId: row.order_id,
      transitionId: row.payment_transition_id,
      reason: row.reason,
      resolvedAt: row.resolved_at ? toIso(row.resolved_at) : null,
      createdAt: toIso(row.detected_at),
    }));
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23505"
  );
}
