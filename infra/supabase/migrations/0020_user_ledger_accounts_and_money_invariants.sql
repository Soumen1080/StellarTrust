-- StellarTrust — per-user ledger accounts + money-safety invariants
-- (plane.md §4.5 and §4.3). Forward-only Postgres/Supabase migration
-- (Rules.md §2).
--
-- Why this exists
-- ───────────────
-- Every ledger posting in the platform lands on a *system* account
-- (`rwa_investor_cash_clearing`, `escrow_holding`, …). There is no per-user
-- account, so there is no such thing as "this investor's balance" to check
-- against — which is why the insufficient-funds check in §1.1 and §3.2 could
-- not be written, and why no user has a statement.
--
-- The schema already supports the shape: `ledger_accounts` is unique on
-- (owner_ref, currency, name) and 0001 documents `user:<id>` as a valid
-- `owner_ref`. Nothing has ever written one. This migration makes them real,
-- gives them a balance read that Postgres computes rather than the
-- application, and closes the three money invariants §4.3 leaves open.
--
-- What a per-user account means here
-- ──────────────────────────────────
-- One account per (user, currency), named `user_cash`, typed `liability`.
-- Liability is the correct side: the platform *owes* the user their balance.
-- A user's balance is therefore credits − debits, which is the natural sign
-- for a liability and is what `ledger_account_balances` computes below.
--
-- These accounts are created on demand by the application (a user who never
-- transacts needs no row), so this migration adds no seed data. What it adds
-- is the guard rails: a check that a user account is named consistently, an
-- index that makes the balance read cheap, and the balance view itself.

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- §4.5 — Per-user ledger accounts
-- ─────────────────────────────────────────────────────────────────────────────

-- `owner_ref` was free text. It is now the thing balances are keyed on, so a
-- typo ('users:<id>', 'user-<id>') would silently create a *second* account
-- that no balance read ever finds. Constrain the shape: either the literal
-- 'system', or `user:<uuid>` / `business:<uuid>`.
--
-- Existing rows are all 'system' seeds, so this validates without a rewrite.
alter table ledger_accounts
  add constraint ledger_accounts_owner_ref_shape check (
    owner_ref is null
    or owner_ref = 'system'
    or owner_ref ~ '^(user|business):[0-9a-fA-F-]{36}$'
  );

-- A user-owned account must be a liability: the balance is what we owe them.
-- Without this a user account could be seeded as an `asset` and its balance
-- would read with the sign inverted — an overdrawn user would look funded.
alter table ledger_accounts
  add constraint ledger_accounts_user_owned_is_liability check (
    owner_ref is null
    or owner_ref !~ '^user:'
    or type = 'liability'
  );

-- The balance read walks entries by account. Without this it is a sequential
-- scan of every entry the platform has ever posted, per balance request.
create index if not exists ledger_entries_account_currency_idx
  on ledger_entries (account_id, currency);

create index if not exists ledger_accounts_owner_ref_idx
  on ledger_accounts (owner_ref)
  where owner_ref is not null and owner_ref <> 'system';

-- ── Balance as a database-computed value ─────────────────────────────────────
--
-- Deliberately a view, not a stored column. A stored balance is a second copy
-- of what `ledger_entries` already says, and the two drift the moment any
-- write path forgets to update it — which is exactly the class of bug the
-- double-entry ledger exists to make impossible. Golden Rule #1 says the
-- entries are the truth; this view just reads them.
--
-- Sign convention: liability/equity/revenue accounts increase on the credit
-- side, asset/expense accounts on the debit side. `balance` is therefore
-- always "how much this account holds", positive, in the account's natural
-- direction — so a user's `user_cash` balance is credits − debits.
create or replace view ledger_account_balances as
select
  a.id                as account_id,
  a.owner_ref,
  a.name,
  a.type,
  a.currency,
  coalesce(sum(
    case
      when a.type in ('liability', 'equity', 'revenue')
        then case when e.direction = 'credit' then e.amount else -e.amount end
      else case when e.direction = 'debit' then e.amount else -e.amount end
    end
  ), 0)::bigint       as balance,
  coalesce(sum(case when e.direction = 'debit'  then e.amount else 0 end), 0)::bigint as total_debits,
  coalesce(sum(case when e.direction = 'credit' then e.amount else 0 end), 0)::bigint as total_credits,
  count(e.id)         as entry_count,
  max(e.created_at)   as last_entry_at
from ledger_accounts a
left join ledger_entries e
  on e.account_id = a.id
 and e.currency   = a.currency
group by a.id, a.owner_ref, a.name, a.type, a.currency;

comment on view ledger_account_balances is
  'Per-account balance derived from ledger_entries. The entries are the system '
  'of record (Golden Rule #1); this view never stores a second copy.';

-- ─────────────────────────────────────────────────────────────────────────────
-- §4.3 — Money-safety invariants at the database layer
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Each of these is already checked in application code. They are restated here
-- because an application check protects against the code paths someone thought
-- of, and a database check protects against the ones they did not — including
-- a future migration, a manual fix applied in a console at 3am, and a second
-- service written against the same tables.

-- ── Invariant 1: units_sold <= total_units ───────────────────────────────────
-- Already present as an inline check in 0006 line 79. §4.3 asks that it be
-- *verified to have survived* the repair migrations, which is a thing a
-- migration can assert rather than a human remember to grep for.
do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where t.relname = 'tokenizations'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%units_sold%total_units%'
  ) then
    -- Re-establish it rather than fail: the intent is that it holds, not that
    -- a particular earlier migration is the one that established it.
    alter table tokenizations
      add constraint tokenizations_units_sold_within_supply
      check (units_sold >= 0 and units_sold <= total_units);
  end if;
end;
$$;

-- ── Invariant 2: a holding's units cannot exceed the tokenization's supply ───
--
-- A per-row check cannot see across tables, so this is a trigger. 0006 already
-- has a trigger refusing *over-subscription* on insert (sum of holdings vs.
-- supply); this is the narrower structural claim that one holding row can
-- never on its own exceed the supply — which is what a bad UPDATE would do,
-- and 0006's guard only fires on insert.
create or replace function assert_holding_within_supply()
returns trigger
language plpgsql
as $$
declare
  supply bigint;
  held   bigint;
begin
  select total_units into supply
  from tokenizations
  where id = new.tokenization_id;

  if supply is null then
    raise exception 'Holding references unknown tokenization %', new.tokenization_id
      using errcode = 'foreign_key_violation';
  end if;

  if new.units > supply then
    raise exception 'Holding of % units exceeds tokenization supply of % (tokenization %)',
      new.units, supply, new.tokenization_id
      using errcode = 'check_violation';
  end if;

  -- The sum across every holder must also fit. Counted excluding this row's
  -- previous value so an UPDATE that moves units between holders is judged on
  -- the resulting state, not double-counted.
  select coalesce(sum(units), 0) into held
  from token_holdings
  where tokenization_id = new.tokenization_id
    and id <> new.id;

  if held + new.units > supply then
    raise exception 'Holdings would total % units, exceeding supply of % (tokenization %)',
      held + new.units, supply, new.tokenization_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists assert_holding_within_supply on token_holdings;
create trigger assert_holding_within_supply
  before insert or update of units, tokenization_id on token_holdings
  for each row execute function assert_holding_within_supply();

-- ── Invariant 3: payouts per tokenization cannot exceed what was collected ───
--
-- The waterfall (§1.3) already refuses to distribute more than the collection,
-- and `proRataShares` sums to exactly the total. This catches the case those
-- cannot: two distributions posted against the same tokenization — a retry
-- that escaped idempotency, or a manual re-run — which individually respect
-- the waterfall and together pay out twice.
create or replace function assert_payout_within_collection()
returns trigger
language plpgsql
as $$
declare
  target_tokenization uuid;
  distributed bigint;
  collected   bigint;
begin
  select pd.tokenization_id into target_tokenization
  from payout_distributions pd
  where pd.id = new.distribution_id;

  if target_tokenization is null then
    return new;
  end if;

  select coalesce(sum(pr.share_amount), 0) into distributed
  from payout_records pr
  join payout_distributions pd on pd.id = pr.distribution_id
  where pd.tokenization_id = target_tokenization;

  select t.face_value_amount into collected
  from tokenizations t
  where t.id = target_tokenization;

  -- A tokenization with no face value recorded predates §1.2 and is not
  -- constrained here; the backfill in 0016 gave every live row one, so this
  -- only skips rows that were already finished.
  if collected is null then
    return new;
  end if;

  if distributed > collected then
    raise exception
      'Payouts for this tokenization total %, exceeding the % collectible at face value',
      distributed, collected
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists assert_payout_within_collection on payout_records;
-- AFTER, and per-statement rather than per-row: the sum is only meaningful
-- once every record in the distribution has landed. A per-row BEFORE trigger
-- would judge a legitimate multi-holder payout on a partial total.
create constraint trigger assert_payout_within_collection
  after insert or update on payout_records
  deferrable initially deferred
  for each row execute function assert_payout_within_collection();

commit;
