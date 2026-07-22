/**
 * Postgres-backed identity repository.
 *
 * Implements the {@link IdentityRepository} contract against the schema from
 * migrations 0001/0003/0005 (`users`, `wallets`, `businesses`, plus the
 * `users.latest_verification` JSONB snapshot). Because identities live in
 * Postgres, the same wallet resolves to the same user id across restarts, so
 * opaque sessions persisted by {@link PgAuthRepository} remain valid and
 * `/api/auth/me` keeps working.
 *
 * Parameterized queries only (Rules.md §7).
 */
import type pg from "pg";
import {
  KycStatus,
  type BusinessProfile,
  type IdentityProfileResponse,
  type KycApplicationResponse,
  type UserProfile,
  type WalletRef,
} from "@stellartrust/shared";
import type {
  DevelopmentDemoAccount,
  IdentityRepository,
} from "./identity.repository.js";

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** Deterministic placeholder email until KYC onboarding supplies a real one. */
function pendingEmail(stellarPublicKey: string): string {
  return `wallet-${stellarPublicKey.slice(0, 12)}@pending.stellartrust.local`;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  kyc_status: KycStatus;
  created_at: Date | string;
  latest_verification: KycApplicationResponse | null;
}

interface WalletRow {
  id: string;
  user_id: string;
  stellar_public_key: string;
  custody_type: "self" | "contract";
}

interface BusinessRow {
  id: string;
  owner_user_id: string;
  legal_name: string;
  country: string;
  created_at: Date | string;
}

export class PgIdentityRepository implements IdentityRepository {
  private readonly demoAccounts: Map<string, DevelopmentDemoAccount>;

  constructor(
    private readonly pool: pg.Pool,
    demoAccounts: readonly DevelopmentDemoAccount[] = [],
  ) {
    this.demoAccounts = new Map(
      demoAccounts.map((account) => [account.stellarPublicKey, account]),
    );
  }

  private mapUser(row: UserRow): UserProfile {
    return {
      id: row.id,
      email: row.email,
      ...(row.display_name ? { displayName: row.display_name } : {}),
      kycStatus: row.kyc_status,
      createdAt: toIso(row.created_at),
    };
  }

  private mapWallet(row: WalletRow): WalletRef {
    return {
      id: row.id,
      userId: row.user_id,
      stellarPublicKey: row.stellar_public_key,
      custodyType: row.custody_type,
    };
  }

  async upsertWalletIdentity(stellarPublicKey: string): Promise<{
    user: UserProfile;
    wallet: WalletRef;
  }> {
    const existing = await this.findByWallet(stellarPublicKey);
    if (existing) return existing;

    // First sight of this wallet: create the user + wallet atomically. Demo
    // accounts are seeded verified with their display name; everyone else
    // starts pending. ON CONFLICT handles a concurrent insert race.
    const demo = this.demoAccounts.get(stellarPublicKey);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const userInsert = await client.query<UserRow>(
        `insert into users (email, display_name, kyc_status, verified_at)
         values ($1, $2, $3, $4)
         returning id, email, display_name, kyc_status, created_at, latest_verification`,
        [
          pendingEmail(stellarPublicKey),
          demo?.displayName ?? null,
          demo ? KycStatus.Verified : KycStatus.Pending,
          demo ? new Date().toISOString() : null,
        ],
      );
      const userRow = userInsert.rows[0];
      if (!userRow) throw new Error("Failed to create identity user");
      const walletInsert = await client.query<WalletRow>(
        `insert into wallets (user_id, stellar_public_key, custody_type)
         values ($1, $2, 'self')
         on conflict (stellar_public_key) do nothing
         returning id, user_id, stellar_public_key, custody_type`,
        [userRow.id, stellarPublicKey],
      );

      const walletRow = walletInsert.rows[0];
      if (!walletRow) {
        // Lost the race: another request created the wallet. Roll back our
        // orphan user and return the winner.
        await client.query("rollback");
        const winner = await this.findByWallet(stellarPublicKey);
        if (winner) return winner;
        throw new Error("Wallet identity index is inconsistent");
      }

      await client.query("commit");
      return {
        user: this.mapUser(userRow),
        wallet: this.mapWallet(walletRow),
      };
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async findByWallet(stellarPublicKey: string): Promise<
    | {
        user: UserProfile;
        wallet: WalletRef;
      }
    | undefined
  > {
    const { rows } = await this.pool.query(
      `select
         w.id as wallet_id, w.user_id, w.stellar_public_key, w.custody_type,
         u.id as user_id2, u.email, u.display_name, u.kyc_status,
         u.created_at, u.latest_verification
       from wallets w
       join users u on u.id = w.user_id
       where w.stellar_public_key = $1`,
      [stellarPublicKey],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      user: this.mapUser({
        id: row.user_id,
        email: row.email,
        display_name: row.display_name,
        kyc_status: row.kyc_status,
        created_at: row.created_at,
        latest_verification: row.latest_verification,
      }),
      wallet: this.mapWallet({
        id: row.wallet_id,
        user_id: row.user_id,
        stellar_public_key: row.stellar_public_key,
        custody_type: row.custody_type,
      }),
    };
  }

  async updateUserProfile(
    userId: string,
    input: { email: string; legalName: string; kycStatus: KycStatus },
  ): Promise<UserProfile> {
    // `legalName` is not part of the users row (kept on businesses); mirror the
    // in-memory repository which only updates email + KYC status here.
    const { rows } = await this.pool.query<UserRow>(
      `update users
       set email = $2, kyc_status = $3, updated_at = now()
       where id = $1
       returning id, email, display_name, kyc_status, created_at, latest_verification`,
      [userId, input.email, input.kycStatus],
    );
    const row = rows[0];
    if (!row) throw new Error(`Identity ${userId} was not found`);
    return this.mapUser(row);
  }

  async setUserKycStatus(
    userId: string,
    status: KycStatus,
  ): Promise<UserProfile> {
    const { rows } = await this.pool.query<UserRow>(
      `update users
       set kyc_status = $2, updated_at = now()
       where id = $1
       returning id, email, display_name, kyc_status, created_at, latest_verification`,
      [userId, status],
    );
    const row = rows[0];
    if (!row) throw new Error(`Identity ${userId} was not found`);
    return this.mapUser(row);
  }

  async upsertBusiness(
    userId: string,
    input: { legalName: string; country: string },
  ): Promise<BusinessProfile> {
    // One business per owner (matches the in-memory contract): update in place
    // if present, otherwise insert.
    const existing = await this.pool.query<BusinessRow>(
      `select id, owner_user_id, legal_name, country, created_at
       from businesses where owner_user_id = $1
       order by created_at asc limit 1`,
      [userId],
    );

    if (existing.rows[0]) {
      const { rows } = await this.pool.query<BusinessRow>(
        `update businesses
         set legal_name = $2, country = $3
         where id = $1
         returning id, owner_user_id, legal_name, country, created_at`,
        [existing.rows[0].id, input.legalName, input.country],
      );
      const updated = rows[0];
      if (!updated) throw new Error(`Business for ${userId} was not found`);
      return this.mapBusiness(updated);
    }

    const { rows } = await this.pool.query<BusinessRow>(
      `insert into businesses (owner_user_id, legal_name, country)
       values ($1, $2, $3)
       returning id, owner_user_id, legal_name, country, created_at`,
      [userId, input.legalName, input.country],
    );
    const inserted = rows[0];
    if (!inserted) throw new Error("Failed to create business profile");
    return this.mapBusiness(inserted);
  }

  private mapBusiness(row: BusinessRow): BusinessProfile {
    return {
      id: row.id,
      ownerUserId: row.owner_user_id,
      legalName: row.legal_name,
      country: row.country,
      createdAt: toIso(row.created_at),
    };
  }

  async setLatestVerification(
    userId: string,
    verification: KycApplicationResponse,
  ): Promise<void> {
    const result = await this.pool.query(
      `update users set latest_verification = $2 where id = $1`,
      [userId, JSON.stringify(verification)],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new Error(`Identity ${userId} was not found`);
    }
  }

  async getProfile(
    userId: string,
  ): Promise<IdentityProfileResponse | undefined> {
    const userResult = await this.pool.query<UserRow>(
      `select id, email, display_name, kyc_status, created_at, latest_verification
       from users where id = $1`,
      [userId],
    );
    const userRow = userResult.rows[0];
    if (!userRow) return undefined;

    const [businessResult, walletsResult] = await Promise.all([
      this.pool.query<BusinessRow>(
        `select id, owner_user_id, legal_name, country, created_at
         from businesses where owner_user_id = $1
         order by created_at asc limit 1`,
        [userId],
      ),
      this.pool.query<WalletRow>(
        `select id, user_id, stellar_public_key, custody_type
         from wallets where user_id = $1
         order by created_at asc`,
        [userId],
      ),
    ]);

    return {
      user: this.mapUser(userRow),
      business: businessResult.rows[0]
        ? this.mapBusiness(businessResult.rows[0])
        : null,
      wallets: walletsResult.rows.map((row) => this.mapWallet(row)),
      latestVerification: userRow.latest_verification ?? null,
    };
  }
}
