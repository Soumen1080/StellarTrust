-- StellarTrust — treasury movements: how a ledger balance comes to exist
-- (plane.md §4.5). Forward-only Postgres/Supabase migration (Rules.md §2).
--
-- Why this exists
-- ───────────────
-- Migration 0020 gave every user a ledger account and a balance. It did not
-- say how money gets into one, and without that the insufficient-funds check
-- it unblocked refuses every purchase, because every balance is zero.
--
-- A deposit here is not a number a user types. It is the platform observing a
-- payment that already happened on Stellar — to an address the platform
-- controls, from an address the user proved control of at SEP-10 — and
-- crediting exactly what arrived.
--
-- The one invariant this table exists to hold
-- ───────────────────────────────────────────
-- **A Stellar transaction can be credited once.** Not by convention, and not
-- by an application check that two racing API instances would both pass, but
-- by a unique index. That is the difference between a deposit system and a way
-- to mint balance by clicking twice.
--
-- The ledger enforces the same thing independently: the deposit posts with
-- `treasury-deposit:<hash>` as its reference id, and `ledger_transactions`
-- is unique on that. Two constraints in two tables, either of which alone
-- would stop the double credit.

begin;

create type treasury_direction as enum ('deposit', 'withdrawal');
create type treasury_status    as enum ('pending', 'completed', 'failed');

create table treasury_movements (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references users(id) on delete restrict,
  direction             treasury_direction not null,
  status                treasury_status not null default 'pending',

  -- Integer minor units, matching every other amount in the platform. bigint
  -- rather than numeric for the same reason `ledger_entries.amount` is: money
  -- is counted, not measured.
  amount                bigint not null check (amount > 0),
  currency              text not null,

  -- The chain evidence. For a deposit this is supplied by the user and is what
  -- the platform verified against Horizon. For a withdrawal it is filled in
  -- once submission succeeds, so it is null while pending and after a failure.
  stellar_tx_hash       text,

  -- Where a deposit came from, or where a withdrawal went.
  counterparty_address  text not null,

  ledger_transaction_id uuid references ledger_transactions(id) on delete restrict,
  failure_reason        text,

  created_at            timestamptz not null default now(),
  completed_at          timestamptz,

  -- A completed movement has settled: it has a chain hash and a ledger posting
  -- behind it. Without this a row could claim completion while recording
  -- neither, which is precisely the state a reconciliation job exists to find
  -- and would then never find.
  constraint treasury_completed_is_evidenced check (
    status <> 'completed'
    or (stellar_tx_hash is not null
        and ledger_transaction_id is not null
        and completed_at is not null)
  ),

  -- A failure says why. An unexplained failed withdrawal is a support ticket
  -- with no answer in it.
  constraint treasury_failure_has_reason check (
    status <> 'failed' or failure_reason is not null
  )
);

-- ── The double-credit guard ──────────────────────────────────────────────────
--
-- Partial, because `stellar_tx_hash` is legitimately null on a pending or
-- failed withdrawal and a plain unique index would collapse all of those into
-- one allowed row.
create unique index treasury_movements_tx_hash_key
  on treasury_movements (stellar_tx_hash)
  where stellar_tx_hash is not null;

create index treasury_movements_user_idx
  on treasury_movements (user_id, created_at desc);
create index treasury_movements_status_idx
  on treasury_movements (status, created_at desc)
  where status = 'pending';
create index treasury_movements_created_idx
  on treasury_movements (created_at desc);

comment on table treasury_movements is
  'Deposits and withdrawals between a user''s Stellar wallet and their ledger '
  'balance. A deposit row is evidence the platform verified a real on-chain '
  'payment; the unique index on stellar_tx_hash is what makes it creditable '
  'exactly once.';

commit;
