/**
 * Postgres-backed settlement persistence (Phase 3, migration 0011).
 *
 * Implements the same {@link SettlementRepository} contract as the in-memory
 * variant. Settlement was the last money-moving module keeping its records in
 * a Map: a completed cross-border payout could not be proven after a restart,
 * and the "one settlement per quote" idempotency guard held only for as long
 * as one process stayed up. Both are now database facts — a unique constraint
 * on `settlements.quote_id` and a unique `ledger_transaction_id` per leg.
 *
 * Each financial leg is committed in ONE database transaction: ledger header,
 * ledger entries, the chain or anchor record, the settlement snapshot, and the
 * transition row land together or not at all. The deferred
 * `ledger_balance_check` trigger from migration 0001 validates the balancing
 * invariant at COMMIT, behind the service's own check.
 *
 * Beneficiary handles are never written here — only the masked display string
 * and the SHA-256 fingerprint the service derived (Rules.md §7).
 *
 * Parameterized queries only (Rules.md §7).
 */
import type pg from "pg";
import {
  ChainTxStatus,
  SettlementTransition,
  type AnchorTransferDTO,
  type CurrencyCode,
  type EntryDirection,
  type LedgerEntryDTO,
  type LedgerTransactionDTO,
  type SettlementDTO,
  type SettlementQuoteDTO,
  type SettlementReconciliationMismatchDTO,
  type SettlementTransitionDTO,
  type StellarTxRecord,
} from "@stellartrust/shared";
import { ConflictError } from "../../lib/errors.js";
import { assertBalanced } from "../ledger/ledger.balance.js";
import { systemAccountName } from "../ledger/system-accounts.js";
import type {
  SettlementRepository,
  SettlementTransitionCommit,
} from "./settlement.repository.js";

/** Postgres timestamptz columns arrive as Date; normalize to ISO strings. */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** 23505 = unique_violation. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23505"
  );
}

interface SnapshotRow<T> {
  data: T;
}

interface TransitionRow {
  id: string;
  settlement_id: string;
  transition: SettlementTransition;
  anchor_transfer: AnchorTransferDTO | null;
  stellar_transaction_id: string | null;
  ledger_transaction_id: string;
  ledger_reference_id: string;
  ledger_description: string;
  ledger_created_at: Date | string;
  chain_hash: string | null;
  chain_type: string | null;
  chain_status: ChainTxStatus | null;
  chain_created_at: Date | string | null;
  created_at: Date | string;
}

interface EntryRow {
  id: string;
  transaction_id: string;
  account_id: string;
  direction: string;
  amount: string;
  currency: string;
  created_at: Date | string;
}

interface MismatchRow {
  id: string;
  settlement_id: string;
  settlement_transition_id: string;
  reason: string;
  resolved_at: Date | string | null;
  detected_at: Date | string;
}

export class PgSettlementRepository implements SettlementRepository {
  /** Cache of resolved `${name}:${currency}` → account id. */
  private readonly accountIdCache = new Map<string, string>();

  constructor(private readonly pool: pg.Pool) {}

  // ── Quotes ─────────────────────────────────────────────────────────────────

  async saveQuote(quote: SettlementQuoteDTO): Promise<void> {
    // A quote id is generated per request, so a conflict can only be a retry of
    // the same quote; keeping the original is correct either way.
    await this.pool.query(
      `insert into settlement_quotes
         (id, user_id, corridor_id, source_currency, source_amount,
          destination_currency, destination_amount, payout_rail, payout_fee,
          net_destination_amount, route_type, expires_at, data, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)
       on conflict (id) do nothing`,
      [
        quote.id,
        quote.userId,
        quote.corridorId,
        quote.source.currency,
        quote.source.amount,
        quote.route.destinationAmount.currency,
        quote.route.destinationAmount.amount,
        quote.payoutRail,
        quote.payoutFee.amount,
        quote.netDestinationAmount.amount,
        quote.route.type,
        quote.expiresAt,
        JSON.stringify(quote),
        quote.createdAt,
      ],
    );
  }

  async findQuote(quoteId: string): Promise<SettlementQuoteDTO | undefined> {
    const { rows } = await this.pool.query<SnapshotRow<SettlementQuoteDTO>>(
      `select data from settlement_quotes where id = $1`,
      [quoteId],
    );
    return rows[0]?.data;
  }

  // ── Settlements ────────────────────────────────────────────────────────────

  async saveSettlement(settlement: SettlementDTO): Promise<void> {
    await this.upsertSettlement(this.pool, settlement);
  }

  async findSettlement(
    settlementId: string,
  ): Promise<SettlementDTO | undefined> {
    const { rows } = await this.pool.query<SnapshotRow<SettlementDTO>>(
      `select data from settlements where id = $1`,
      [settlementId],
    );
    return rows[0]?.data;
  }

  async findSettlementByQuote(
    quoteId: string,
  ): Promise<SettlementDTO | undefined> {
    const { rows } = await this.pool.query<SnapshotRow<SettlementDTO>>(
      `select data from settlements where quote_id = $1`,
      [quoteId],
    );
    return rows[0]?.data;
  }

  async listSettlements(userId: string): Promise<SettlementDTO[]> {
    const { rows } = await this.pool.query<SnapshotRow<SettlementDTO>>(
      `select data from settlements
       where user_id = $1
       order by created_at desc`,
      [userId],
    );
    return rows.map((row) => row.data);
  }

  // ── Transitions ────────────────────────────────────────────────────────────

  async listTransitions(
    settlementId?: string,
  ): Promise<SettlementTransitionDTO[]> {
    const { rows } = await this.pool.query<TransitionRow>(
      `select t.id,
              t.settlement_id,
              t.transition,
              t.anchor_transfer,
              t.stellar_transaction_id,
              t.created_at,
              l.id           as ledger_transaction_id,
              l.reference_id as ledger_reference_id,
              l.description  as ledger_description,
              l.created_at   as ledger_created_at,
              s.hash         as chain_hash,
              s.type         as chain_type,
              s.status       as chain_status,
              s.created_at   as chain_created_at
       from settlement_transitions t
       join ledger_transactions l on l.id = t.ledger_transaction_id
       left join stellar_transactions s on s.id = t.stellar_transaction_id
       where $1::uuid is null or t.settlement_id = $1::uuid
       order by t.created_at asc, t.id asc`,
      [settlementId ?? null],
    );
    if (rows.length === 0) return [];

    // One query for every leg's entries, rather than one per leg: the
    // reconciliation job reads the whole table on each run.
    const entriesByTransaction = await this.loadEntries(
      rows.map((row) => row.ledger_transaction_id),
    );

    return rows.map((row) => {
      const ledgerTransaction: LedgerTransactionDTO = {
        id: row.ledger_transaction_id,
        referenceId: row.ledger_reference_id,
        description: row.ledger_description,
        createdAt: toIso(row.ledger_created_at),
        entries: entriesByTransaction.get(row.ledger_transaction_id) ?? [],
      };
      const stellarTransaction: StellarTxRecord | null =
        row.stellar_transaction_id && row.chain_type
          ? {
              id: row.stellar_transaction_id,
              hash: row.chain_hash ?? "",
              type: row.chain_type,
              status: row.chain_status ?? ChainTxStatus.Pending,
              ledgerTransactionId: row.ledger_transaction_id,
              createdAt: toIso(row.chain_created_at ?? row.created_at),
            }
          : null;
      return {
        id: row.id,
        settlementId: row.settlement_id,
        transition: row.transition,
        ledgerTransaction,
        anchorTransfer: row.anchor_transfer,
        stellarTransaction,
        createdAt: toIso(row.created_at),
      };
    });
  }

  async commitTransition(
    input: SettlementTransitionCommit,
  ): Promise<SettlementTransitionDTO> {
    // Belt and braces: the service checks this, and the deferred database
    // trigger checks it again at COMMIT. Money is worth three checks.
    assertBalanced(input.ledger.entries);

    const client = await this.pool.connect();
    try {
      await client.query("begin");

      // 1) Settlement snapshot at this leg (status advances with the leg).
      await this.upsertSettlement(client, input.settlement);

      // 2) Ledger header. A duplicate reference id means this leg is posted.
      const ledgerInsert = await client.query<{ id: string; created_at: Date }>(
        `insert into ledger_transactions (reference_id, description)
         values ($1, $2)
         returning id, created_at`,
        [input.ledger.referenceId, input.ledger.description],
      );
      const ledgerRow = ledgerInsert.rows[0];
      if (!ledgerRow) throw new Error("Failed to create ledger transaction");
      const ledgerId = ledgerRow.id;

      // 3) Entries — the deferred balance trigger validates them at commit.
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

      // 4) Chain record for the conversion leg. The anchor legs carry a
      //    transfer instead; the table's check constraint enforces exactly one.
      let stellarTransaction: StellarTxRecord | null = null;
      if (input.chain) {
        const chainInsert = await client.query<{ id: string; created_at: Date }>(
          `insert into stellar_transactions
             (hash, type, status, ledger_transaction_id)
           values ($1, $2, $3, $4)
           returning id, created_at`,
          [
            input.chain.hash,
            input.chain.type,
            input.chain.status ?? ChainTxStatus.Pending,
            ledgerId,
          ],
        );
        const chainRow = chainInsert.rows[0];
        if (!chainRow) throw new Error("Failed to create stellar transaction");
        stellarTransaction = {
          id: chainRow.id,
          hash: input.chain.hash,
          type: input.chain.type,
          status: input.chain.status ?? ChainTxStatus.Pending,
          ledgerTransactionId: ledgerId,
          createdAt: toIso(chainRow.created_at),
        };
      }

      // 5) The transition itself.
      const transitionInsert = await client.query<{
        id: string;
        created_at: Date;
      }>(
        `insert into settlement_transitions
           (settlement_id, transition, actor_id, ledger_transaction_id,
            anchor_reference, anchor_transfer, stellar_transaction_id)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7)
         returning id, created_at`,
        [
          input.settlement.id,
          input.transition,
          input.actorId,
          ledgerId,
          input.anchorTransfer?.reference ?? null,
          input.anchorTransfer ? JSON.stringify(input.anchorTransfer) : null,
          stellarTransaction?.id ?? null,
        ],
      );
      const transitionRow = transitionInsert.rows[0];
      if (!transitionRow) throw new Error("Failed to create settlement transition");

      await client.query("commit");

      return {
        id: transitionRow.id,
        settlementId: input.settlement.id,
        transition: input.transition,
        ledgerTransaction: {
          id: ledgerId,
          referenceId: input.ledger.referenceId,
          description: input.ledger.description,
          createdAt: toIso(ledgerRow.created_at),
          entries,
        },
        anchorTransfer: input.anchorTransfer,
        stellarTransaction,
        createdAt: toIso(transitionRow.created_at),
      };
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      if (isUniqueViolation(err)) {
        // Either the ledger reference id or the (settlement, transition) pair —
        // both mean this money movement is already recorded.
        throw new ConflictError(
          "Settlement transition has already been recorded",
        );
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Reconciliation ─────────────────────────────────────────────────────────

  async hasUnresolvedMismatch(settlementId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `select 1 from settlement_reconciliation_mismatches
       where settlement_id = $1 and status = 'open' limit 1`,
      [settlementId],
    );
    return rows.length > 0;
  }

  async replaceMismatches(
    mismatches: SettlementReconciliationMismatchDTO[],
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");

      const activeTransitionIds = mismatches.map((item) => item.transitionId);

      // Anything open that this run no longer reports has been fixed.
      await client.query(
        `update settlement_reconciliation_mismatches
         set status = 'resolved', resolved_at = now()
         where status = 'open'
           and not (settlement_transition_id = any($1::uuid[]))`,
        [activeTransitionIds],
      );

      // Re-reporting the same problem must not stack duplicates: the partial
      // unique index allows one open row per leg, so a repeat is a no-op.
      for (const mismatch of mismatches) {
        await client.query(
          `insert into settlement_reconciliation_mismatches
             (id, settlement_id, settlement_transition_id, reason, status,
              detected_at)
           values ($1, $2, $3, $4, 'open', $5)
           on conflict (settlement_transition_id) where status = 'open'
             do update set reason = excluded.reason`,
          [
            mismatch.id,
            mismatch.settlementId,
            mismatch.transitionId,
            mismatch.reason,
            mismatch.createdAt,
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

  async listUnresolvedMismatches(): Promise<
    SettlementReconciliationMismatchDTO[]
  > {
    const { rows } = await this.pool.query<MismatchRow>(
      `select id, settlement_id, settlement_transition_id, reason, resolved_at,
              detected_at
       from settlement_reconciliation_mismatches
       where status = 'open'
       order by detected_at asc`,
    );
    return rows.map((row) => ({
      id: row.id,
      settlementId: row.settlement_id,
      transitionId: row.settlement_transition_id,
      reason: row.reason,
      resolvedAt: row.resolved_at ? toIso(row.resolved_at) : null,
      createdAt: toIso(row.detected_at),
    }));
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Upsert the settlement snapshot. Columns the queries filter on are
   * denormalized out of the DTO; `data` stays the contract of record. Works
   * against a pool or a client so it can join an open leg transaction.
   */
  private async upsertSettlement(
    executor: pg.Pool | pg.PoolClient,
    settlement: SettlementDTO,
  ): Promise<void> {
    const payout = settlement.payout;
    await executor.query(
      `insert into settlements
         (id, user_id, quote_id, corridor_id, status, source_currency,
          source_amount, destination_currency, destination_amount,
          payout_rail, payout_country, payout_fee, payout_net_amount,
          payout_destination_masked, payout_destination_fingerprint,
          data, completed_at, failure_reason, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               $15, $16::jsonb, $17, $18, $19, $20)
       on conflict (id) do update
         set status = excluded.status,
             data = excluded.data,
             completed_at = excluded.completed_at,
             failure_reason = excluded.failure_reason,
             updated_at = excluded.updated_at`,
      [
        settlement.id,
        settlement.userId,
        settlement.quoteId,
        settlement.corridorId,
        settlement.status,
        settlement.source.currency,
        settlement.source.amount,
        settlement.destination.currency,
        settlement.destination.amount,
        payout.rail,
        payout.destination.country,
        payout.fee.amount,
        payout.netAmount.amount,
        payout.destination.masked,
        payout.destination.fingerprint,
        JSON.stringify(settlement),
        settlement.completedAt,
        settlement.failureReason,
        settlement.createdAt,
        settlement.updatedAt,
      ],
    );
  }

  private async loadEntries(
    transactionIds: string[],
  ): Promise<Map<string, LedgerEntryDTO[]>> {
    const { rows } = await this.pool.query<EntryRow>(
      `select id, transaction_id, account_id, direction, amount, currency,
              created_at
       from ledger_entries
       where transaction_id = any($1::uuid[])
       order by created_at asc, id asc`,
      [transactionIds],
    );
    const byTransaction = new Map<string, LedgerEntryDTO[]>();
    for (const row of rows) {
      const entry: LedgerEntryDTO = {
        id: row.id,
        transactionId: row.transaction_id,
        accountId: row.account_id,
        direction: row.direction as EntryDirection,
        amount: String(row.amount),
        currency: row.currency as CurrencyCode,
        createdAt: toIso(row.created_at),
      };
      const bucket = byTransaction.get(row.transaction_id);
      if (bucket) bucket.push(entry);
      else byTransaction.set(row.transaction_id, [entry]);
    }
    return byTransaction;
  }

  /** Synthetic role id + currency → the seeded system account's real id. */
  private async resolveAccountId(
    client: pg.PoolClient,
    syntheticId: string,
    currency: string,
  ): Promise<string> {
    const name = systemAccountName(syntheticId);
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
}
