/**
 * Per-user ledger accounts (plane.md §4.5).
 *
 * Every posting in the platform used to land on a *system* account. That made
 * "this investor's balance" a thing that did not exist, which is why the
 * insufficient-funds checks in §1.1 and §3.2 could not be written, and why no
 * user could be shown a statement.
 *
 * A user account is addressed differently from a system one. System accounts
 * are a fixed chart, so they get fixed synthetic ids (`system-accounts.ts`)
 * resolved to a real row at write time. User accounts are unbounded — one per
 * (user, currency), created the first time that user's money moves — so they
 * are addressed by a *reference string* the repository resolves and creates on
 * demand.
 *
 * The two address spaces must not collide: a system synthetic id is a UUID, a
 * user account reference is `user:<uuid>/user_cash`. {@link isUserAccountRef}
 * is what the repository switches on.
 */

/** The single account name a user's spendable balance lives under. */
export const USER_CASH_ACCOUNT = "user_cash";

/**
 * Ledger account reference for a user's cash balance.
 *
 * Shape matches the `owner_ref` constraint added in migration 0020
 * (`^(user|business):<uuid>$`), with the account name appended after a slash so
 * one reference names one row in `ledger_accounts` — which is unique on
 * (owner_ref, currency, name), with currency supplied by the entry itself.
 */
export function userCashAccount(userId: string): string {
  return `user:${userId}/${USER_CASH_ACCOUNT}`;
}

/** True when an account id addresses a user account rather than a system one. */
export function isUserAccountRef(accountId: string): boolean {
  return accountId.startsWith("user:") && accountId.includes("/");
}

export interface ParsedUserAccountRef {
  ownerRef: string;
  userId: string;
  name: string;
}

/**
 * Split a user account reference into the parts `ledger_accounts` is keyed on.
 *
 * Returns undefined rather than throwing for anything that is not a user
 * reference, so a caller can use it as the discriminator itself.
 */
export function parseUserAccountRef(
  accountId: string,
): ParsedUserAccountRef | undefined {
  if (!isUserAccountRef(accountId)) return undefined;
  const separator = accountId.indexOf("/");
  const ownerRef = accountId.slice(0, separator);
  const name = accountId.slice(separator + 1);
  const userId = ownerRef.slice("user:".length);
  // Non-empty and free of the delimiter — the same shape
  // `ledgerAccountRefSchema` accepts. Deliberately *not* a uuid check: the
  // Postgres constraint in migration 0020 holds real ids to that, while the
  // in-memory adapters name their users `investor-1`, and Rules.md §2 requires
  // both adapters to accept the same inputs.
  if (userId.length === 0 || name.length === 0) {
    return undefined;
  }
  return { ownerRef, userId, name };
}
