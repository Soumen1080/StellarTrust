-- StellarTrust — RWA financing economics (plane.md §1.2)
-- Forward-only Postgres/Supabase migration (Rules.md §2).
--
-- Financing model: DISCOUNT / FACTORING (decided 2026-09-03, plane.md §1.2).
-- Investors buy a claim below face value and are repaid at face value on
-- collection; their yield is the discount. The recurring-coupon alternative was
-- weighed and deferred — see plane.md §8.1. Do not add coupon columns here
-- without reading it.
--
-- Why this exists
-- ───────────────
-- Until now a tokenization carried only `price_per_unit` and `total_units`.
-- That is enough to sell units but not enough to describe the product being
-- sold. Real receivable financing has four numbers that this schema was
-- missing, and without them the payout could only ever be a guess:
--
--   face_value        what the debtor owes at maturity
--   advance_rate_bps  the share of face value actually financed; the remainder
--                     is the seller's retained first-loss, which is what keeps
--                     the seller's incentives aligned with the investors'
--   discount_rate_bps the yield investors earn for carrying the risk
--   maturity_date     when collection is due, and therefore when a position
--                     becomes late and then defaulted
--
-- The previous payout logic distributed the *entire* order amount pro-rata to
-- holders, which silently meant the seller financed nothing and the platform
-- earned nothing. The waterfall in the service layer needs these columns to
-- compute the correct split.
--
-- Backfill: existing rows get a face value derived from the supply they already
-- sold (total_units × price_per_unit) at a 100% advance and zero yield. That is
-- the economically identical restatement of what the old model implied, so no
-- existing tokenization changes value under the new arithmetic.

-- ─────────────────────────────────────────────────────────────────────────────
-- Financing terms
-- ─────────────────────────────────────────────────────────────────────────────

alter table tokenizations
  add column if not exists face_value_amount    bigint,
  add column if not exists face_value_currency  text,
  add column if not exists advance_rate_bps     integer,
  add column if not exists discount_rate_bps    integer not null default 0,
  add column if not exists platform_fee_bps     integer not null default 0,
  add column if not exists maturity_date        timestamptz,
  -- Set when collection actually happens, so late-yield accrual is measured
  -- against the real collection date rather than "now" at read time.
  add column if not exists collected_at         timestamptz;

-- Backfill before applying NOT NULL: face value = the full subscribed amount.
update tokenizations
set face_value_amount   = coalesce(face_value_amount, total_units * price_per_unit_amount),
    face_value_currency = coalesce(face_value_currency, price_per_unit_currency),
    advance_rate_bps    = coalesce(advance_rate_bps, 10000)
where face_value_amount is null
   or face_value_currency is null
   or advance_rate_bps is null;

-- A tokenization with no maturity is treated as due 90 days from creation,
-- the common net-90 receivable term.
update tokenizations
set maturity_date = created_at + interval '90 days'
where maturity_date is null;

alter table tokenizations
  alter column face_value_amount   set not null,
  alter column face_value_currency set not null,
  alter column advance_rate_bps    set not null,
  alter column maturity_date       set not null;

-- Rate sanity. Basis points, so 10000 = 100%.
alter table tokenizations
  drop constraint if exists tokenizations_advance_rate_range,
  add  constraint tokenizations_advance_rate_range
       check (advance_rate_bps > 0 and advance_rate_bps <= 10000);

alter table tokenizations
  drop constraint if exists tokenizations_discount_rate_range,
  add  constraint tokenizations_discount_rate_range
       check (discount_rate_bps >= 0 and discount_rate_bps <= 10000);

alter table tokenizations
  drop constraint if exists tokenizations_platform_fee_range,
  add  constraint tokenizations_platform_fee_range
       check (platform_fee_bps >= 0 and platform_fee_bps <= 10000);

alter table tokenizations
  drop constraint if exists tokenizations_face_value_positive,
  add  constraint tokenizations_face_value_positive
       check (face_value_amount > 0);

-- Financing terms are denominated in one currency. The waterfall subtracts the
-- investor leg from the collected face value, so a face value in one currency
-- and a unit price in another would produce arithmetic with no meaning. The
-- schema refuses it rather than trusting every call site to check.
alter table tokenizations
  drop constraint if exists tokenizations_currency_coherent,
  add  constraint tokenizations_currency_coherent
       check (face_value_currency = price_per_unit_currency);

comment on column tokenizations.face_value_amount is
  'What the debtor owes at maturity (minor units). Investors are repaid from this, not from the raised amount.';
comment on column tokenizations.advance_rate_bps is
  'Share of face value financed, in bps. The remainder is the seller''s retained first-loss.';
comment on column tokenizations.discount_rate_bps is
  'Investor yield in bps, earned over the term and accruing further past maturity.';
comment on column tokenizations.platform_fee_bps is
  'Platform take in bps, paid after investors are made whole.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Lifecycle statuses for maturity and default (plane.md §1.4)
-- ─────────────────────────────────────────────────────────────────────────────
-- A tokenization that can never fail is not a real investment product. These
-- are added to the existing enum rather than replacing statuses, so no existing
-- row changes meaning.

-- Note: `alter type ... add value` is committed separately from its first use
-- (Postgres refuses to use a new enum label in the transaction that added it),
-- so these run as bare statements outside any block — the same convention
-- migration 0008 uses. Nothing later in this file references the new labels.

alter type tokenization_status add value if not exists 'matured';

alter type tokenization_status add value if not exists 'defaulted';

alter type tokenization_status add value if not exists 'written_off';

alter type tokenization_status add value if not exists 'repaid';

alter type tokenization_status add value if not exists 'payout_held';

-- ─────────────────────────────────────────────────────────────────────────────
-- Ledger accounts for the money that now actually moves
-- ─────────────────────────────────────────────────────────────────────────────
-- `rwa_investment_receivable` and `rwa_investment_liability` were seeded by
-- 0006 and never posted against, because a purchase wrote no ledger entry at
-- all. Wiring the purchase up needs two accounts that do not exist yet: where
-- the issuer's proceeds land, and where the platform's fee is recognised.

insert into ledger_accounts (type, currency, owner_ref, name)
select account_type::ledger_account_type, currency, 'system', account_name
from (values
  ('liability', 'rwa_issuer_proceeds_payable'),  -- Owed to the issuer from a subscription
  ('revenue',   'rwa_platform_fee_revenue'),     -- Platform take on the waterfall
  ('asset',     'rwa_investor_cash_clearing'),   -- Investor cash in, before it is applied
  ('asset',     'rwa_recovery_receivable')       -- Expected recovery on a defaulted position
) as account_kinds(account_type, account_name)
cross join (values ('USD'),('EUR'),('INR'),('NGN'),('XLM'),('USDC'))
  as currencies(currency)
on conflict (owner_ref, currency, name) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- Money-safety invariants at the database layer (plane.md §4.3)
-- ─────────────────────────────────────────────────────────────────────────────
-- These are asserted here, not only in the service, because a constraint the
-- database enforces survives a bug in any call site.

-- A holding can never claim more units than the tokenization ever issued.
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

  select coalesce(sum(units), 0) into held
  from token_holdings
  where tokenization_id = new.tokenization_id
    and id <> new.id;

  if held + new.units > supply then
    raise exception
      'Holding would exceed tokenization supply (% + % > %)',
      held, new.units, supply
      using errcode = 'check_violation';
  end if;

  return new;
end$$;

drop trigger if exists token_holdings_within_supply on token_holdings;
create trigger token_holdings_within_supply
  before insert or update on token_holdings
  for each row execute function assert_holding_within_supply();
