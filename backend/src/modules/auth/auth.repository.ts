/** SEP-10 challenge and opaque-session persistence boundary. */
export interface ChallengeRecord {
  id: string;
  stellarPublicKey: string;
  transactionHash: string;
  expiresAt: string;
  consumedAt: string | null;
}

export interface SessionRecord {
  tokenHash: string;
  userId: string;
  walletId: string;
  roles: string[];
  expiresAt: string;
  revokedAt: string | null;
}

export interface AuthRepository {
  saveChallenge(record: ChallengeRecord): Promise<void>;
  getChallenge(id: string): Promise<ChallengeRecord | undefined>;
  consumeChallenge(id: string, consumedAt: string): Promise<boolean>;
  saveSession(record: SessionRecord): Promise<void>;
  findActiveSession(tokenHash: string, now: string): Promise<SessionRecord | undefined>;
}

export class InMemoryAuthRepository implements AuthRepository {
  private readonly challenges = new Map<string, ChallengeRecord>();
  private readonly sessions = new Map<string, SessionRecord>();

  async saveChallenge(record: ChallengeRecord): Promise<void> {
    this.challenges.set(record.id, record);
  }

  async getChallenge(id: string): Promise<ChallengeRecord | undefined> {
    return this.challenges.get(id);
  }

  async consumeChallenge(id: string, consumedAt: string): Promise<boolean> {
    const current = this.challenges.get(id);
    if (!current || current.consumedAt) return false;
    this.challenges.set(id, { ...current, consumedAt });
    return true;
  }

  async saveSession(record: SessionRecord): Promise<void> {
    this.sessions.set(record.tokenHash, record);
  }

  async findActiveSession(
    tokenHash: string,
    now: string,
  ): Promise<SessionRecord | undefined> {
    const session = this.sessions.get(tokenHash);
    if (!session || session.revokedAt || session.expiresAt <= now) return undefined;
    return session;
  }
}
