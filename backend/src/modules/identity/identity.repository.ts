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
  type UserProfile,
  type WalletRef,
} from "@stellartrust/shared";

export interface IdentityRepository {
  upsertWalletIdentity(stellarPublicKey: string): Promise<{
    user: UserProfile;
    wallet: WalletRef;
  }>;
  updateUserProfile(
    userId: string,
    input: { email: string; legalName: string; kycStatus: KycStatus },
  ): Promise<UserProfile>;
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
