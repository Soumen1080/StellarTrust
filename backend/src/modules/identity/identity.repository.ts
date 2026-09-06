/**
 * Identity persistence boundary.
 *
 * Phase 1 ships an in-memory implementation for hermetic tests/local use. The
 * schema in migration 0003 is the production contract; a Postgres repository
 * can replace this implementation without changing auth/KYC services.
 */
import { randomUUID } from "node:crypto";
import {
  KycStatus,
  type BusinessProfile,
  type IdentityProfileResponse,
  type KycApplicationResponse,
  type PublicUserRef,
  type UserProfile,
  type WalletRef,
} from "@stellartrust/shared";
import { ConflictError } from "../../lib/errors.js";

/**
 * The handle an account is born with.
 *
 * Derived from the Stellar public key rather than random so that it is stable:
 * the same wallet yields the same handle, which keeps fixtures and local
 * databases reproducible. Lower-cased and prefixed to satisfy the
 * `users_username_format` constraint — a bare key fragment could start with a
 * digit and base32 keys are upper-case.
 */
export function generateUsername(stellarPublicKey: string): string {
  return `user_${stellarPublicKey.slice(1, 13).toLowerCase()}`;
}

export interface IdentityRepository {
  upsertWalletIdentity(stellarPublicKey: string): Promise<{
    user: UserProfile;
    wallet: WalletRef;
  }>;
  /**
   * The wallet a user signs and receives value with. On-chain escrow needs to
   * turn the internal user ids on an order into real Stellar addresses; this is
   * the only sanctioned mapping (the addresses come from a completed SEP-10
   * proof of key control, never from client-supplied input).
   */
  findPrimaryWallet(userId: string): Promise<WalletRef | undefined>;
  updateUserProfile(
    userId: string,
    input: { email: string; legalName: string; kycStatus: KycStatus },
  ): Promise<UserProfile>;
  /**
   * Claims the user's one permanent handle.
   *
   * Throws {@link ConflictError} if the handle is taken or if this user has
   * already claimed one — the username is displayed against settled
   * transactions, so it is writable exactly once.
   */
  setUsername(userId: string, username: string): Promise<UserProfile>;
  setAvatarUrl(userId: string, avatarUrl: string | null): Promise<UserProfile>;
  /** The subset of a user that may be shown to a transaction counterparty. */
  findPublicRef(userId: string): Promise<PublicUserRef | undefined>;
  setUserKycStatus(userId: string, status: KycStatus): Promise<UserProfile>;
  upsertBusiness(
    userId: string,
    input: { legalName: string; country: string },
  ): Promise<BusinessProfile>;
  setLatestVerification(
    userId: string,
    verification: KycApplicationResponse,
  ): Promise<void>;
  getProfile(userId: string): Promise<IdentityProfileResponse | undefined>;
}

interface IdentityRecord {
  user: UserProfile;
  business: BusinessProfile | null;
  wallets: WalletRef[];
  latestVerification: KycApplicationResponse | null;
}

export interface DevelopmentDemoAccount {
  stellarPublicKey: string;
  displayName: string;
}

export class InMemoryIdentityRepository implements IdentityRepository {
  private readonly records = new Map<string, IdentityRecord>();
  private readonly walletToUser = new Map<string, string>();

  constructor(demoAccounts: readonly DevelopmentDemoAccount[] = []) {
    for (const account of demoAccounts) {
      this.createWalletIdentity(
        account.stellarPublicKey,
        account.displayName,
        KycStatus.Verified,
      );
    }
  }

  async upsertWalletIdentity(stellarPublicKey: string): Promise<{
    user: UserProfile;
    wallet: WalletRef;
  }> {
    const existingUserId = this.walletToUser.get(stellarPublicKey);
    if (existingUserId) {
      const record = this.records.get(existingUserId);
      if (!record) throw new Error("Identity index is inconsistent");
      const wallet = record.wallets.find(
        (item) => item.stellarPublicKey === stellarPublicKey,
      );
      if (!wallet) throw new Error("Wallet index is inconsistent");
      return { user: record.user, wallet };
    }

    return this.createWalletIdentity(stellarPublicKey);
  }

  async findPrimaryWallet(userId: string): Promise<WalletRef | undefined> {
    // First wallet is the one the identity was created from (the SEP-10 key).
    return this.records.get(userId)?.wallets[0];
  }

  private createWalletIdentity(
    stellarPublicKey: string,
    displayName?: string,
    kycStatus: KycStatus = KycStatus.Pending,
  ): { user: UserProfile; wallet: WalletRef } {
    const userId = randomUUID();
    const now = new Date().toISOString();
    const user: UserProfile = {
      id: userId,
      // Replaced by the KYC onboarding email; not externally delivered.
      email: `wallet-${stellarPublicKey.slice(0, 12)}@pending.stellartrust.local`,
      ...(displayName ? { displayName } : {}),
      // No `usernameSetAt`: this is the generated handle, so the user's one
      // claim is still available.
      username: generateUsername(stellarPublicKey),
      kycStatus,
      createdAt: now,
    };
    const wallet: WalletRef = {
      id: randomUUID(),
      userId,
      stellarPublicKey,
      custodyType: "self",
    };
    this.records.set(userId, {
      user,
      business: null,
      wallets: [wallet],
      latestVerification: null,
    });
    this.walletToUser.set(stellarPublicKey, userId);
    return { user, wallet };
  }

  async updateUserProfile(
    userId: string,
    input: { email: string; legalName: string; kycStatus: KycStatus },
  ): Promise<UserProfile> {
    const record = this.requireRecord(userId);
    record.user = {
      ...record.user,
      email: input.email,
      kycStatus: input.kycStatus,
    };
    return record.user;
  }

  async setUsername(userId: string, username: string): Promise<UserProfile> {
    const record = this.requireRecord(userId);
    if (record.user.usernameSetAt) {
      throw new ConflictError(
        "Your username has already been set and cannot be changed",
      );
    }
    // Mirrors the case-insensitive unique index from migration 0023: handles
    // are stored folded, so a plain comparison is the same check.
    for (const [otherId, other] of this.records) {
      if (otherId !== userId && other.user.username === username) {
        throw new ConflictError("That username is already taken");
      }
    }
    record.user = {
      ...record.user,
      username,
      usernameSetAt: new Date().toISOString(),
    };
    return record.user;
  }

  async setAvatarUrl(
    userId: string,
    avatarUrl: string | null,
  ): Promise<UserProfile> {
    const record = this.requireRecord(userId);
    const { avatarUrl: _previous, ...rest } = record.user;
    record.user = { ...rest, ...(avatarUrl ? { avatarUrl } : {}) };
    return record.user;
  }

  async findPublicRef(userId: string): Promise<PublicUserRef | undefined> {
    const user = this.records.get(userId)?.user;
    if (!user) return undefined;
    return {
      id: user.id,
      username: user.username,
      ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
    };
  }

  async setUserKycStatus(
    userId: string,
    status: KycStatus,
  ): Promise<UserProfile> {
    const record = this.requireRecord(userId);
    record.user = { ...record.user, kycStatus: status };
    return record.user;
  }

  async upsertBusiness(
    userId: string,
    input: { legalName: string; country: string },
  ): Promise<BusinessProfile> {
    const record = this.requireRecord(userId);
    record.business = {
      id: record.business?.id ?? randomUUID(),
      ownerUserId: userId,
      legalName: input.legalName,
      country: input.country,
      createdAt: record.business?.createdAt ?? new Date().toISOString(),
    };
    return record.business;
  }

  async setLatestVerification(
    userId: string,
    verification: KycApplicationResponse,
  ): Promise<void> {
    this.requireRecord(userId).latestVerification = verification;
  }

  async getProfile(
    userId: string,
  ): Promise<IdentityProfileResponse | undefined> {
    const record = this.records.get(userId);
    return record
      ? {
          user: record.user,
          business: record.business,
          wallets: [...record.wallets],
          latestVerification: record.latestVerification,
        }
      : undefined;
  }

  private requireRecord(userId: string): IdentityRecord {
    const record = this.records.get(userId);
    if (!record) throw new Error(`Identity ${userId} was not found`);
    return record;
  }
}
