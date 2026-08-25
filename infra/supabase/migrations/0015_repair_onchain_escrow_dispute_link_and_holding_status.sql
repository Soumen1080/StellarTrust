-- StellarTrust — repair: re-apply the on-chain escrow (0008), dispute/escrow
-- link (0009) and RWA holding-status (0010) schema on a database where those
-- three migrations never ran.
-- Forward-only Postgres/Supabase migration (Rules.md §2).
--
-- Why this exists:
--   The companion to 0014. Auditing every SQL statement in the backend's
--   repositories against the live schema showed the hand-applied database had
--   stopped at 0007 and then jumped to 0013, so 0008-0012 were all absent.
--   0014 restored 0011/0012; these are the remaining three.
--
--   What was broken, and where it surfaced:
--     * `escrow_state` had no 'pending' value (0008). The lock flow deploys the
--       custody contract before the buyer signs, and writes the escrow row as
--       'pending' in that window — so "Lock in escrow" failed on an invalid
--       enum input and returned 500.
--     * `payment_transition` had no 'dispute' value (0008). Moving locked
--       custody to Disputed is a recorded transition, so raising a dispute
--       against a funded order hit the same wall.
--     * `dispute_records` had no `escrow_id` / `contract_id` (0009), so the
--       dispute INSERT itself referenced columns that did not exist.
--     * `token_holdings` had no `status` and `token_holding_status` did not
--       exist (0010), so recording an RWA purchase failed on the same class of
--       error.
--
--   Every statement is idempotent, so this is safe to re-run and is a no-op on
--   a database where 0008-0010 already applied.
--
-- Transaction layout:
--   `alter type ... add value` may run inside a transaction on PostgreSQL 12+,
--   but the new label cannot be USED until that transaction commits. The enum
--   additions therefore get their own committed block, and everything that
--   depends on them — notably the `escrows.state` default of 'pending' —
--   follows in a second block. Do not merge the two.

-- ─────────────────────────────────────────────────────────────────────────────
-- 0008 · Enum labels (must commit before anything below can use them)
-- ─────────────────────────────────────────────────────────────────────────────
begin;

alter type escrow_state add value if not exists 'pending' before 'locked';
alter type payment_transition add value if not exists 'dispute';

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- Everything that depends on those labels, plus 0009 and 0010
-- ─────────────────────────────────────────────────────────────────────────────
begin;

-- 0008 · Custody instances are deployed before they are funded, so the default
-- no longer describes a newly inserted row.
alter table escrows alter column state set default 'pending';

comment on column escrows.state is
  'pending = custody contract deployed, funds not yet locked; locked/released/refunded/disputed mirror the on-chain State enum.';

comment on column escrows.contract_id is
  'Soroban contract id of the per-order custody instance. Set at deploy time, before the buyer signs the lock, so a retry reuses the instance instead of leaking a new one.';

-- ── 0009 · Link disputes to the custody they are about ──────────────────────
-- Both nullable: a dispute can be opened against an order whose funds were
-- never locked, and that is a legitimate state, not a missing value.
alter table dispute_records
  add column if not exists escrow_id uuid references escrows(id) on delete restrict;

alter table dispute_records
  add column if not exists contract_id text;

comment on column dispute_records.escrow_id is
  'Custody instance this dispute is about, captured when the dispute was opened. Null when the order had no escrow yet.';

comment on column dispute_records.contract_id is
  'Soroban contract id of that custody instance at open time.';

create index if not exists dispute_records_contract_idx
  on dispute_records(contract_id)
  where contract_id is not null;

-- ── 0010 · RWA issuer self-custody: delivered vs merely purchased ───────────
-- Existing rows default to 'settled': every holding written before this
-- migration was delivered inline by the platform signer.
do $$ begin
  create type token_holding_status as enum ('pending', 'settled');
exception when duplicate_object then null; end $$;

alter table token_holdings
  add column if not exists status token_holding_status not null default 'settled';

comment on column token_holdings.status is
  'pending = purchased and reserved, but the issuer has not yet signed the on-chain transfer (issuer custody only); settled = the contract has moved the units.';

-- The reconciliation job and the payout calculation both filter on this, and
-- the outstanding-delivery queue is a hot path for an issuer with a live sale.
create index if not exists token_holdings_pending_idx
  on token_holdings(tokenization_id)
  where status = 'pending';

commit;
