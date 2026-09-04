/**
 * Postgres-backed RWA persistence (Phase 5).
 *
 * Implements the same {@link RwaRepository} contract as the in-memory variant,
 * writing to the schema from migration 0006 (`assets`, `tokenizations`,
 * `token_holdings`, `payout_distributions`, `payout_records`). Because RWA data
 * lives in Postgres, a wallet's assets, tokenizations, holdings, and payout
 * history survive logout/login and process restarts.
 *
 * Two 0006 behaviours are respected here rather than duplicated:
 *   - `units_sold` and `updated_at` are maintained by DB triggers
 *     (`sync_units_sold`, `auto_fund_tokenization`, `*_updated_at`); this repo
 *     never writes `units_sold` and re-reads trigger-updated rows via RETURNING.
 *   - `payout_distributions.ledger_transaction_id` has an FK to
 *     `ledger_transactions` and a completed-status CHECK. The service assigns a
 *     placeholder id and does not persist the payout ledger, so on completion
 *     this repo posts a real balanced RWA payout transaction
 *     (rwa_payout_reserve → rwa_payout_payable) and links its id.
 *
 * Parameterized queries only (Rules.md §7).
 */
import type pg from "pg";
import type { CurrencyCode } from "@stellartrust/shared";
import { ConflictError, NotFoundError } from "../../lib/errors.js";
import {
  LIVE_PLEDGE_STATUSES,
  type PersistTokenizationInput,
  type RwaRepository,
} from "./rwa.repository.js";
import {
  AssetVerificationStatus,
  PayoutStatus,
  TokenizationStatus,
  type AssetDTO,
  type AssetCounterpartyDTO,
  type AssetDocumentDTO,
  type CreateAssetInput,
  type PayoutDistributionDTO,
  type PayoutRecordDTO,
  type TokenHoldingDTO,
  type TokenizationDTO,
} from "./rwa.types.js";

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function toAmount(value: string | number): string {
  return typeof value === "number" ? String(value) : value;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23505"
  );
}

interface AssetRow {
  id: string;
  owner_user_id: string;
  asset_type: AssetDTO["assetType"];
  asset_ref: string;
  description: string;
  valuation_amount: string;
  valuation_currency: string;
  metadata: Record<string, unknown> | null;
  verification_status: AssetVerificationStatus;
  documents: AssetDocumentDTO[] | null;
  counterparty: AssetCounterpartyDTO | null;
  verified_by_user_id: string | null;
  verified_at: Date | string | null;
  verification_note: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * The asset columns every read selects.
 *
 * One constant rather than six copies of the list: a column added to `assets`
 * and forgotten in one query is a field that is silently `undefined` in
 * exactly one code path, which is the kind of bug that surfaces months later
 * in the one endpoint nobody exercised.
 */
const ASSET_COLUMNS = `id, owner_user_id, asset_type, asset_ref, description,
              valuation_amount, valuation_currency, metadata,
              verification_status, documents, counterparty,
              verified_by_user_id, verified_at, verification_note,
              created_at, updated_at`;

interface TokenizationRow {
  id: string;
  asset_id: string;
  issuer_user_id: string;
  contract_id: string | null;
  contract_deployed_at: Date | string | null;
  total_units: string;
  units_sold: string;
  price_per_unit_amount: string;
  price_per_unit_currency: string;
  face_value_amount: string | number;
  face_value_currency: string;
  advance_rate_bps: number;
  discount_rate_bps: number;
  platform_fee_bps: number;
  maturity_date: Date | string;
  collected_at: Date | string | null;
  require_authorization: boolean;
  frozen: boolean;
  linked_order_id: string | null;
  status: TokenizationStatus;
  created_at: Date | string;
  updated_at: Date | string;
}

interface HoldingRow {
  id: string;
  tokenization_id: string;
  holder_user_id: string;
  holder_address: string;
  units: string;
  purchase_amount: string;
  purchase_currency: string;
  purchased_at: Date | string;
  authorized: boolean;
  status: string;
  updated_at: Date | string;
}

interface DistributionRow {
  id: string;
  tokenization_id: string;
  triggered_by_order_id: string | null;
  triggered_by_transition: string | null;
  total_amount: string;
  total_currency: string;
  status: PayoutStatus;
  ledger_transaction_id: string | null;
  initiated_at: Date | string;
  completed_at: Date | string | null;
}

interface PayoutRecordRow {
  id: string;
  distribution_id: string;
  holder_user_id: string;
  units_held: string;
  share_amount: string;
  share_currency: string;
  ledger_entry_id: string | null;
  created_at: Date | string;
}

export class PgRwaRepository implements RwaRepository {
  constructor(private readonly pool: pg.Pool) {}

  // ── Mappers ────────────────────────────────────────────────────────────────

  private mapAsset(row: AssetRow): AssetDTO {
    return {
      id: row.id,
      ownerUserId: row.owner_user_id,
      assetType: row.asset_type,
      assetRef: row.asset_ref,
      description: row.description,
      valuationAmount: toAmount(row.valuation_amount),
      valuationCurrency: row.valuation_currency as CurrencyCode,
      ...(row.metadata ? { metadata: row.metadata } : {}),
      verificationStatus: row.verification_status,
      // `documents` is a jsonb array with a `[]` default, but a row written
      // before migration 0018 backfilled can still read null.
      documents: row.documents ?? [],
      counterparty: row.counterparty,
      verifiedByUserId: row.verified_by_user_id,
      verifiedAt: toIsoOrNull(row.verified_at),
      verificationNote: row.verification_note,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  private mapTokenization(row: TokenizationRow): TokenizationDTO {
    return {
      id: row.id,
      assetId: row.asset_id,
      issuerUserId: row.issuer_user_id,
      contractId: row.contract_id,
      contractDeployedAt: toIsoOrNull(row.contract_deployed_at),
      totalUnits: toAmount(row.total_units),
      unitsSold: toAmount(row.units_sold),
      pricePerUnitAmount: toAmount(row.price_per_unit_amount),
      pricePerUnitCurrency: row.price_per_unit_currency as CurrencyCode,
      faceValueAmount: toAmount(row.face_value_amount),
      faceValueCurrency: row.face_value_currency as CurrencyCode,
      advanceRateBps: Number(row.advance_rate_bps),
      discountRateBps: Number(row.discount_rate_bps),
      platformFeeBps: Number(row.platform_fee_bps),
      maturityDate: toIso(row.maturity_date),
      collectedAt: toIsoOrNull(row.collected_at),
      requireAuthorization: row.require_authorization,
      frozen: row.frozen,
      linkedOrderId: row.linked_order_id,
      status: row.status,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  private mapHolding(row: HoldingRow): TokenHoldingDTO {
    return {
      id: row.id,
      tokenizationId: row.tokenization_id,
      holderUserId: row.holder_user_id,
      holderAddress: row.holder_address,
      units: toAmount(row.units),
      purchaseAmount: toAmount(row.purchase_amount),
      purchaseCurrency: row.purchase_currency as CurrencyCode,
      purchasedAt: toIso(row.purchased_at),
      authorized: row.authorized,
      status: row.status as TokenHoldingDTO["status"],
      updatedAt: toIso(row.updated_at),
    };
  }

  private mapDistribution(row: DistributionRow): PayoutDistributionDTO {
    return {
      id: row.id,
      tokenizationId: row.tokenization_id,
      triggeredByOrderId: row.triggered_by_order_id,
      triggeredByTransition: row.triggered_by_transition,
      totalAmount: toAmount(row.total_amount),
      totalCurrency: row.total_currency as CurrencyCode,
      status: row.status,
      ledgerTransactionId: row.ledger_transaction_id,
      initiatedAt: toIso(row.initiated_at),
      completedAt: toIsoOrNull(row.completed_at),
    };
  }

  private mapPayoutRecord(row: PayoutRecordRow): PayoutRecordDTO {
    return {
      id: row.id,
      distributionId: row.distribution_id,
      holderUserId: row.holder_user_id,
      unitsHeld: toAmount(row.units_held),
      shareAmount: toAmount(row.share_amount),
      shareCurrency: row.share_currency as CurrencyCode,
      ledgerEntryId: row.ledger_entry_id,
      createdAt: toIso(row.created_at),
    };
  }

  // ── Assets ───────────────────────────────────────────────────────────────

  async createAsset(
    ownerUserId: string,
    input: CreateAssetInput,
  ): Promise<AssetDTO> {
    try {
      const now = new Date().toISOString();
      const documents: AssetDocumentDTO[] = (input.documents ?? []).map(
        (doc) => ({
          docRef: doc.docRef,
          docType: doc.docType,
          sha256: doc.sha256 ?? null,
          uploadedAt: now,
        }),
      );
      const counterparty: AssetCounterpartyDTO | null = input.counterparty
        ? {
            ref: input.counterparty.ref,
            name: input.counterparty.name,
            reputationScore: null,
          }
        : null;

      // `verification_status` is not in the column list: it defaults to
      // `unverified` in the schema, and accepting one here would let an issuer
      // declare their own evidence acceptable.
      const { rows } = await this.pool.query<AssetRow>(
        `insert into assets
           (owner_user_id, asset_type, asset_ref, description,
            valuation_amount, valuation_currency, metadata,
            documents, counterparty)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb)
         returning ${ASSET_COLUMNS}`,
        [
          ownerUserId,
          input.assetType,
          input.assetRef,
          input.description,
          input.valuationAmount,
          input.valuationCurrency,
          input.metadata ? JSON.stringify(input.metadata) : null,
          JSON.stringify(documents),
          counterparty ? JSON.stringify(counterparty) : null,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error("Failed to create asset");
      return this.mapAsset(row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError(
          `Asset with ref ${input.assetRef} already exists for this owner`,
        );
      }
      throw err;
    }
  }

  async findAsset(assetId: string): Promise<AssetDTO | undefined> {
    const { rows } = await this.pool.query<AssetRow>(
      `select ${ASSET_COLUMNS} from assets where id = $1`,
      [assetId],
    );
    return rows[0] ? this.mapAsset(rows[0]) : undefined;
  }

  async listAssets(ownerUserId: string): Promise<AssetDTO[]> {
    const { rows } = await this.pool.query<AssetRow>(
      `select ${ASSET_COLUMNS}
       from assets where owner_user_id = $1
       order by created_at desc`,
      [ownerUserId],
    );
    return rows.map((row) => this.mapAsset(row));
  }

  /**
   * Persist a verification decision (plane.md §3.1).
   *
   * Only the verification columns are writable here. The valuation, the asset
   * reference and the owner are deliberately absent: this is the method
   * compliance calls, and letting a review edit the thing being reviewed would
   * make the approval meaningless. `updated_at` is maintained by the 0006
   * trigger, so it is re-read via RETURNING rather than written.
   */
  async updateAsset(asset: AssetDTO): Promise<AssetDTO> {
    const { rows } = await this.pool.query<AssetRow>(
      `update assets
          set verification_status = $2,
              documents           = $3::jsonb,
              counterparty        = $4::jsonb,
              verified_by_user_id = $5,
              verified_at         = $6,
              verification_note   = $7
        where id = $1
        returning ${ASSET_COLUMNS}`,
      [
        asset.id,
        asset.verificationStatus,
        JSON.stringify(asset.documents),
        asset.counterparty ? JSON.stringify(asset.counterparty) : null,
        asset.verifiedByUserId,
        asset.verifiedAt,
        asset.verificationNote,
      ],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError("Asset not found");
    return this.mapAsset(row);
  }

  async listAssetsForReview(): Promise<AssetDTO[]> {
    const { rows } = await this.pool.query<AssetRow>(
      `select ${ASSET_COLUMNS}
       from assets where verification_status = $1
       order by updated_at asc`,
      [AssetVerificationStatus.UnderReview],
    );
    return rows.map((row) => this.mapAsset(row));
  }

  /**
   * Find a live tokenization backed by another asset with the same reference.
   *
   * The join is across owners on purpose — the double-pledge this catches is
   * the same receivable filed under a second account, which the unique
   * constraint on `(owner_user_id, asset_ref)` cannot see.
   */
  async findActivePledge(
    assetRef: string,
    excludeAssetId: string,
  ): Promise<TokenizationDTO | undefined> {
    const { rows } = await this.pool.query<TokenizationRow>(
      `select t.*
         from tokenizations t
         join assets a on a.id = t.asset_id
        where a.asset_ref = $1
          and a.id <> $2
          and t.status = any($3::tokenization_status[])
        order by t.created_at asc
        limit 1`,
      [assetRef, excludeAssetId, LIVE_PLEDGE_STATUSES],
    );
    return rows[0] ? this.mapTokenization(rows[0]) : undefined;
  }

  // ── Tokenizations ──────────────────────────────────────────────────────────

  async createTokenization(
    issuerUserId: string,
    input: PersistTokenizationInput,
  ): Promise<TokenizationDTO> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");

      const asset = await client.query<{ owner_user_id: string }>(
        `select owner_user_id from assets where id = $1`,
        [input.assetId],
      );
      if (!asset.rows[0]) throw new NotFoundError("Asset not found");
      if (asset.rows[0].owner_user_id !== issuerUserId) {
        throw new ConflictError("Only the asset owner can tokenize it");
      }

      const existing = await client.query(
        `select 1 from tokenizations
         where asset_id = $1 and status <> 'cancelled' limit 1`,
        [input.assetId],
      );
      if (existing.rows.length > 0) {
        throw new ConflictError("This asset is already tokenized");
      }

      const { rows } = await client.query<TokenizationRow>(
        `insert into tokenizations
           (asset_id, issuer_user_id, total_units, price_per_unit_amount,
            price_per_unit_currency, require_authorization, linked_order_id,
            face_value_amount, face_value_currency, advance_rate_bps,
            discount_rate_bps, platform_fee_bps, maturity_date, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'draft')
         returning *`,
        [
          input.assetId,
          issuerUserId,
          input.totalUnits,
          input.pricePerUnitAmount,
          input.pricePerUnitCurrency,
          input.requireAuthorization ?? false,
          input.linkedOrderId ?? null,
          input.faceValueAmount,
          input.faceValueCurrency,
          input.advanceRateBps,
          input.discountRateBps,
          input.platformFeeBps,
          input.maturityDate,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error("Failed to create tokenization");

      await client.query("commit");
      return this.mapTokenization(row);
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async updateTokenization(
    tokenization: TokenizationDTO,
  ): Promise<TokenizationDTO> {
    // `units_sold` and `updated_at` are trigger-owned; never written here.
    const { rows } = await this.pool.query<TokenizationRow>(
      `update tokenizations set
         contract_id = $2,
         contract_deployed_at = $3,
         price_per_unit_amount = $4,
         price_per_unit_currency = $5,
         require_authorization = $6,
         frozen = $7,
         linked_order_id = $8,
         status = $9
       where id = $1
       returning *`,
      [
        tokenization.id,
        tokenization.contractId,
        tokenization.contractDeployedAt,
        tokenization.pricePerUnitAmount,
        tokenization.pricePerUnitCurrency,
        tokenization.requireAuthorization,
        tokenization.frozen,
        tokenization.linkedOrderId,
        tokenization.status,
      ],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError("Tokenization not found");
    return this.mapTokenization(row);
  }

  async findTokenization(
    tokenizationId: string,
  ): Promise<TokenizationDTO | undefined> {
    const { rows } = await this.pool.query<TokenizationRow>(
      `select * from tokenizations where id = $1`,
      [tokenizationId],
    );
    return rows[0] ? this.mapTokenization(rows[0]) : undefined;
  }

  async listTokenizations(filters?: {
    issuerUserId?: string;
    status?: TokenizationStatus;
    linkedOrderId?: string;
  }): Promise<TokenizationDTO[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters?.issuerUserId) {
      params.push(filters.issuerUserId);
      clauses.push(`issuer_user_id = $${params.length}`);
    }
    if (filters?.status) {
      params.push(filters.status);
      clauses.push(`status = $${params.length}`);
    }
    if (filters?.linkedOrderId) {
      params.push(filters.linkedOrderId);
      clauses.push(`linked_order_id = $${params.length}`);
    }
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    const { rows } = await this.pool.query<TokenizationRow>(
      `select * from tokenizations ${where} order by created_at desc`,
      params,
    );
    return rows.map((row) => this.mapTokenization(row));
  }

  // ── Holdings ───────────────────────────────────────────────────────────────

  async createHolding(
    holding: Omit<TokenHoldingDTO, "id">,
  ): Promise<TokenHoldingDTO> {
    // The `sync_units_sold` / `auto_fund_tokenization` triggers maintain the
    // tokenization counters; this insert only writes the holding.
    try {
      const { rows } = await this.pool.query<HoldingRow>(
        `insert into token_holdings
           (tokenization_id, holder_user_id, holder_address, units,
            purchase_amount, purchase_currency, purchased_at, authorized,
            status, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning *`,
        [
          holding.tokenizationId,
          holding.holderUserId,
          holding.holderAddress,
          holding.units,
          holding.purchaseAmount,
          holding.purchaseCurrency,
          holding.purchasedAt,
          holding.authorized,
          holding.status,
          holding.updatedAt,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error("Failed to create holding");
      return this.mapHolding(row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError("Holding already exists for this user");
      }
      throw err;
    }
  }

  async updateHolding(holding: TokenHoldingDTO): Promise<TokenHoldingDTO> {
    // `units` changes are reconciled into `tokenizations.units_sold` by the
    // `sync_units_sold` trigger; `updated_at` is trigger-owned.
    const { rows } = await this.pool.query<HoldingRow>(
      `update token_holdings set
         holder_address = $2,
         units = $3,
         purchase_amount = $4,
         purchase_currency = $5,
         authorized = $6,
         status = $7
       where id = $1
       returning *`,
      [
        holding.id,
        holding.holderAddress,
        holding.units,
        holding.purchaseAmount,
        holding.purchaseCurrency,
        holding.authorized,
        holding.status,
      ],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError("Holding not found");
    return this.mapHolding(row);
  }

  async findHolding(
    tokenizationId: string,
    holderUserId: string,
  ): Promise<TokenHoldingDTO | undefined> {
    const { rows } = await this.pool.query<HoldingRow>(
      `select * from token_holdings
       where tokenization_id = $1 and holder_user_id = $2`,
      [tokenizationId, holderUserId],
    );
    return rows[0] ? this.mapHolding(rows[0]) : undefined;
  }

  async listHoldings(tokenizationId: string): Promise<TokenHoldingDTO[]> {
    const { rows } = await this.pool.query<HoldingRow>(
      `select * from token_holdings
       where tokenization_id = $1
       order by purchased_at asc`,
      [tokenizationId],
    );
    return rows.map((row) => this.mapHolding(row));
  }

  async listHoldingsByUser(holderUserId: string): Promise<TokenHoldingDTO[]> {
    const { rows } = await this.pool.query<HoldingRow>(
      `select * from token_holdings
       where holder_user_id = $1
       order by purchased_at desc`,
      [holderUserId],
    );
    return rows.map((row) => this.mapHolding(row));
  }

  /**
   * Remove a holding — the cooling-off cancellation (plane.md §3.2).
   *
   * `units_sold` is not adjusted here: the 0006 `sync_units_sold` trigger
   * already fires on delete and recomputes it from the surviving rows. Writing
   * it as well would double-count the release. Migration 0018 adds the
   * un-funding half of `auto_fund_tokenization`, which the original only
   * handled in the funding direction.
   */
  async deleteHolding(holdingId: string): Promise<void> {
    const { rowCount } = await this.pool.query(
      `delete from token_holdings where id = $1`,
      [holdingId],
    );
    if (!rowCount) {
      throw new NotFoundError("Holding not found");
    }
  }

  // ── Distributions ────────────────────────────────────────────────────────

  async createDistribution(
    distribution: Omit<PayoutDistributionDTO, "id">,
  ): Promise<PayoutDistributionDTO> {
    const { rows } = await this.pool.query<DistributionRow>(
      `insert into payout_distributions
         (tokenization_id, triggered_by_order_id, triggered_by_transition,
          total_amount, total_currency, status, ledger_transaction_id,
          initiated_at, completed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning *`,
      [
        distribution.tokenizationId,
        distribution.triggeredByOrderId,
        distribution.triggeredByTransition,
        distribution.totalAmount,
        distribution.totalCurrency,
        distribution.status,
        distribution.ledgerTransactionId,
        distribution.initiatedAt,
        distribution.completedAt,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("Failed to create distribution");
    return this.mapDistribution(row);
  }

  async updateDistribution(
    distribution: PayoutDistributionDTO,
  ): Promise<PayoutDistributionDTO> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");

      // The completed-status CHECK requires a ledger_transaction_id that FKs to
      // a real ledger_transactions row. The service passes a placeholder and
      // does not persist the payout ledger, so post a real balanced RWA payout
      // transaction here (rwa_payout_reserve → rwa_payout_payable) and link it.
      let ledgerTransactionId = distribution.ledgerTransactionId;
      if (
        distribution.status === PayoutStatus.Completed &&
        distribution.completedAt !== null
      ) {
        ledgerTransactionId = await this.postPayoutLedger(
          client,
          distribution,
        );
      }

      const { rows } = await client.query<DistributionRow>(
        `update payout_distributions set
           status = $2,
           ledger_transaction_id = $3,
           completed_at = $4
         where id = $1
         returning *`,
        [
          distribution.id,
          distribution.status,
          ledgerTransactionId,
          distribution.completedAt,
        ],
      );
      const row = rows[0];
      if (!row) throw new NotFoundError("Distribution not found");

      await client.query("commit");
      return this.mapDistribution(row);
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async findDistribution(
    distributionId: string,
  ): Promise<PayoutDistributionDTO | undefined> {
    const { rows } = await this.pool.query<DistributionRow>(
      `select * from payout_distributions where id = $1`,
      [distributionId],
    );
    return rows[0] ? this.mapDistribution(rows[0]) : undefined;
  }

  async listDistributions(
    tokenizationId: string,
  ): Promise<PayoutDistributionDTO[]> {
    const { rows } = await this.pool.query<DistributionRow>(
      `select * from payout_distributions
       where tokenization_id = $1
       order by initiated_at desc`,
      [tokenizationId],
    );
    return rows.map((row) => this.mapDistribution(row));
  }

  // ── Payout records ───────────────────────────────────────────────────────

  async createPayoutRecords(
    records: Omit<PayoutRecordDTO, "id">[],
  ): Promise<PayoutRecordDTO[]> {
    if (records.length === 0) return [];
    const created: PayoutRecordDTO[] = [];
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      for (const record of records) {
        const { rows } = await client.query<PayoutRecordRow>(
          `insert into payout_records
             (distribution_id, holder_user_id, units_held, share_amount,
              share_currency, ledger_entry_id, created_at)
           values ($1, $2, $3, $4, $5, $6, $7)
           returning *`,
          [
            record.distributionId,
            record.holderUserId,
            record.unitsHeld,
            record.shareAmount,
            record.shareCurrency,
            record.ledgerEntryId,
            record.createdAt,
          ],
        );
        const row = rows[0];
        if (!row) throw new Error("Failed to create payout record");
        created.push(this.mapPayoutRecord(row));
      }
      await client.query("commit");
      return created;
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async listPayoutRecords(distributionId: string): Promise<PayoutRecordDTO[]> {
    const { rows } = await this.pool.query<PayoutRecordRow>(
      `select * from payout_records
       where distribution_id = $1
       order by created_at asc`,
      [distributionId],
    );
    return rows.map((row) => this.mapPayoutRecord(row));
  }

  async listPayoutRecordsByUser(
    holderUserId: string,
  ): Promise<PayoutRecordDTO[]> {
    const { rows } = await this.pool.query<PayoutRecordRow>(
      `select * from payout_records
       where holder_user_id = $1
       order by created_at desc`,
      [holderUserId],
    );
    return rows.map((row) => this.mapPayoutRecord(row));
  }

  /**
   * Post a balanced RWA payout ledger transaction and return its id. Resolves
   * the system reserve/payable accounts for the payout currency and posts the
   * full total on both legs (the pro-rata per-holder split is recorded in
   * payout_records; the ledger records the aggregate movement).
   */
  private async postPayoutLedger(
    client: pg.PoolClient,
    distribution: PayoutDistributionDTO,
  ): Promise<string> {
    const currency = distribution.totalCurrency;
    const [reserve, payable] = await Promise.all([
      this.resolveSystemAccount(client, "rwa_payout_reserve", currency),
      this.resolveSystemAccount(client, "rwa_payout_payable", currency),
    ]);

    const ledgerInsert = await client.query<{ id: string }>(
      `insert into ledger_transactions (reference_id, description)
       values ($1, $2)
       returning id`,
      [
        `rwa-payout:${distribution.id}`,
        `RWA payout distribution ${distribution.id}`,
      ],
    );
    const ledgerId = ledgerInsert.rows[0]?.id;
    if (!ledgerId) throw new Error("Failed to create payout ledger transaction");

    await client.query(
      `insert into ledger_entries
         (transaction_id, account_id, direction, amount, currency)
       values ($1, $2, 'debit', $4, $3), ($1, $5, 'credit', $4, $3)`,
      [ledgerId, reserve, currency, distribution.totalAmount, payable],
    );

    return ledgerId;
  }

  private async resolveSystemAccount(
    client: pg.PoolClient,
    name: string,
    currency: string,
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `select id from ledger_accounts
       where owner_ref = 'system' and currency = $1 and name = $2`,
      [currency, name],
    );
    const id = rows[0]?.id;
    if (!id) {
      throw new Error(`System ledger account '${name}' (${currency}) is not seeded`);
    }
    return id;
  }
}
