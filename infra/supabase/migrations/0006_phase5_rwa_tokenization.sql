-- StellarTrust — Phase 5: RWA Tokenization
-- Forward-only Postgres/Supabase migration.
-- Opt-in module for tokenizing real-world assets (invoices, commodities, real estate)
-- to unlock working capital for sellers and provide transparent fractional ownership
-- for investors.
--
-- Architecture.md §3: RWA is a peer module, NOT part of the escrow happy path.
-- Payout distribution happens when buyer pays through escrow (Phase 2 path).

begin;

-- Supersede the Phase 0 placeholder RWA tables from 0001 (assets/tokenizations/
-- token_holdings) with the full Phase 5 schema below. The placeholders
-- (issuer_id/kind/face_value, stellar_asset_code, investor_id) were never used
-- by application code, and creating them again here would collide on a clean
-- sequential apply. Forward-only and safe: nothing references them.
drop table if exists token_holdings cascade;
drop table if exists tokenizations cascade;
drop table if exists assets cascade;

-- Asset types supported by the RWA token contract
create type asset_type as enum ('invoice', 'commodity', 'real_estate', 'other');

-- RWA tokenization lifecycle states
create type tokenization_status as enum (
  'draft',          -- Initial creation, not yet deployed
  'active',         -- Contract deployed and accepting investments
  'funded',         -- Fully funded (all units sold)
  'distributing',   -- Payout in progress
  'distributed',    -- Payout completed
  'frozen',         -- Transfers frozen (compliance control)
  'cancelled'       -- Tokenization cancelled before activation
);

-- Payout distribution status
create type payout_status as enum (
  'pending',        -- Awaiting escrow release trigger
  'processing',     -- Distribution in progress
  'completed',      -- All payouts sent
  'failed'          -- Distribution failed (requires manual intervention)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Assets: The underlying real-world assets being tokenized
-- ─────────────────────────────────────────────────────────────────────────────
create table assets (
  id                  uuid primary key default gen_random_uuid(),
  owner_user_id       uuid not null references users(id) on delete restrict,
  asset_type          asset_type not null,
  asset_ref           text not null,  -- e.g. "invoice:INV-001", "commodity:GOLD-100KG"
  description         text not null,
  -- Valuation in minor units (e.g., cents)
  valuation_amount    bigint not null check (valuation_amount > 0),
  valuation_currency  text not null,
  -- Metadata storage (documents, appraisals, etc.) - opaque references only
  metadata            jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (owner_user_id, asset_ref)
);

create index assets_owner_idx on assets(owner_user_id);
create index assets_type_idx on assets(asset_type);

-- ─────────────────────────────────────────────────────────────────────────────
-- Tokenizations: The on-chain token contracts representing fractional ownership
-- ─────────────────────────────────────────────────────────────────────────────
create table tokenizations (
  id                      uuid primary key default gen_random_uuid(),
  asset_id                uuid not null references assets(id) on delete restrict,
  issuer_user_id          uuid not null references users(id) on delete restrict,
  
  -- Soroban contract details
  contract_id             text unique,  -- Deployed contract address (null until deployed)
  contract_deployed_at    timestamptz,
  
  -- Token configuration
  total_units             bigint not null check (total_units > 0),
  units_sold              bigint not null default 0 check (units_sold >= 0 and units_sold <= total_units),
  price_per_unit_amount   bigint not null check (price_per_unit_amount > 0),
  price_per_unit_currency text not null,
  
  -- Compliance controls (mirrors contract state)
  require_authorization   boolean not null default false,
  frozen                  boolean not null default false,
  
  -- Link to escrow that will trigger payout
  linked_order_id         uuid references orders(id) on delete restrict,
  
  -- Lifecycle
  status                  tokenization_status not null default 'draft',
  
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  
  check (
    (status = 'draft' and contract_id is null and contract_deployed_at is null)
    or
    (status != 'draft' and contract_id is not null and contract_deployed_at is not null)
  )
);

create index tokenizations_asset_idx on tokenizations(asset_id);
create index tokenizations_issuer_idx on tokenizations(issuer_user_id);
create index tokenizations_status_idx on tokenizations(status);
create index tokenizations_linked_order_idx on tokenizations(linked_order_id) where linked_order_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- Token Holdings: Investor ownership of tokenized units
-- ─────────────────────────────────────────────────────────────────────────────
create table token_holdings (
  id                uuid primary key default gen_random_uuid(),
  tokenization_id   uuid not null references tokenizations(id) on delete restrict,
  holder_user_id    uuid not null references users(id) on delete restrict,
  holder_address    text not null,  -- Stellar address holding the units
  
  -- Current balance
  units             bigint not null check (units >= 0),
  
  -- Purchase details
  purchase_amount   bigint not null check (purchase_amount >= 0),
  purchase_currency text not null,
  purchased_at      timestamptz not null default now(),
  
  -- Authorization status (for compliance-controlled tokens)
  authorized        boolean not null default true,
  
  updated_at        timestamptz not null default now(),
  
  unique (tokenization_id, holder_user_id),
  unique (tokenization_id, holder_address)
);

create index token_holdings_tokenization_idx on token_holdings(tokenization_id);
create index token_holdings_holder_idx on token_holdings(holder_user_id);
create index token_holdings_address_idx on token_holdings(holder_address);

-- ─────────────────────────────────────────────────────────────────────────────
-- Payout Distributions: Tracking pro-rata payouts to token holders
-- ─────────────────────────────────────────────────────────────────────────────
create table payout_distributions (
  id                        uuid primary key default gen_random_uuid(),
  tokenization_id           uuid not null references tokenizations(id) on delete restrict,
  
  -- Trigger: typically linked to escrow release
  triggered_by_order_id     uuid references orders(id) on delete restrict,
  triggered_by_transition   payment_transition,
  
  -- Total payout amount from buyer payment
  total_amount              bigint not null check (total_amount > 0),
  total_currency            text not null,
  
  -- Distribution status
  status                    payout_status not null default 'pending',
  
  -- Each payout to a holder links to a ledger transaction
  ledger_transaction_id     uuid references ledger_transactions(id) on delete restrict,
  
  -- Audit
  initiated_at              timestamptz not null default now(),
  completed_at              timestamptz,
  
  check (
    (status = 'completed' and completed_at is not null and ledger_transaction_id is not null)
    or
    (status != 'completed' and (completed_at is null or ledger_transaction_id is null))
  )
);

create index payout_distributions_tokenization_idx on payout_distributions(tokenization_id);
create index payout_distributions_order_idx on payout_distributions(triggered_by_order_id) where triggered_by_order_id is not null;
create index payout_distributions_status_idx on payout_distributions(status);

-- ─────────────────────────────────────────────────────────────────────────────
-- Individual Payout Records: Each holder's share in a distribution
-- ─────────────────────────────────────────────────────────────────────────────
create table payout_records (
  id                    uuid primary key default gen_random_uuid(),
  distribution_id       uuid not null references payout_distributions(id) on delete restrict,
  holder_user_id        uuid not null references users(id) on delete restrict,
  
  -- Share calculation
  units_held            bigint not null check (units_held > 0),
  share_amount          bigint not null check (share_amount > 0),
  share_currency        text not null,
  
  -- Ledger linkage
  ledger_entry_id       uuid references ledger_entries(id) on delete restrict,
  
  created_at            timestamptz not null default now(),
  
  unique (distribution_id, holder_user_id)
);

create index payout_records_distribution_idx on payout_records(distribution_id);
create index payout_records_holder_idx on payout_records(holder_user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- RWA ledger accounts for tokenization operations
-- ─────────────────────────────────────────────────────────────────────────────
-- Add RWA-specific ledger accounts for each supported currency
insert into ledger_accounts (type, currency, owner_ref, name)
select account_type::ledger_account_type, currency, 'system', account_name
from (values
  ('asset', 'rwa_investment_receivable'),      -- Investor commitments to purchase units
  ('liability', 'rwa_investment_liability'),   -- Obligation to deliver units
  ('asset', 'rwa_escrow_holding'),             -- Units held in tokenization escrow
  ('liability', 'rwa_payout_payable'),         -- Obligation to distribute payouts
  ('asset', 'rwa_payout_reserve')              -- Reserve for pending distributions
) as account_kinds(account_type, account_name)
cross join (values ('USD'),('EUR'),('INR'),('NGN'),('XLM'),('USDC'))
  as currencies(currency)
on conflict (owner_ref, currency, name) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- Business logic constraints and triggers
-- ─────────────────────────────────────────────────────────────────────────────

-- Maintain units_sold count on tokenizations
create or replace function sync_tokenization_units_sold()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    update tokenizations
    set units_sold = units_sold + new.units
    where id = new.tokenization_id;
  elsif tg_op = 'UPDATE' then
    update tokenizations
    set units_sold = units_sold + (new.units - old.units)
    where id = new.tokenization_id;
  elsif tg_op = 'DELETE' then
    update tokenizations
    set units_sold = units_sold - old.units
    where id = old.tokenization_id;
  end if;
  return coalesce(new, old);
end;
$$;

create trigger sync_units_sold
  after insert or update of units or delete on token_holdings
  for each row execute function sync_tokenization_units_sold();

-- Prevent over-subscription (units_sold cannot exceed total_units)
create or replace function prevent_tokenization_oversell()
returns trigger
language plpgsql
as $$
declare
  tokenization_record tokenizations%rowtype;
begin
  select * into tokenization_record
  from tokenizations
  where id = new.tokenization_id;
  
  if tokenization_record.units_sold + new.units > tokenization_record.total_units then
    raise exception 'Tokenization % is fully subscribed (% / % units sold)',
      tokenization_record.id,
      tokenization_record.units_sold,
      tokenization_record.total_units
      using errcode = 'check_violation';
  end if;
  
  return new;
end;
$$;

create trigger check_tokenization_capacity
  before insert on token_holdings
  for each row execute function prevent_tokenization_oversell();

-- Auto-transition to 'funded' when fully sold
create or replace function auto_fund_tokenization()
returns trigger
language plpgsql
as $$
begin
  if new.units_sold >= new.total_units and new.status = 'active' then
    new.status := 'funded';
  end if;
  return new;
end;
$$;

create trigger tokenization_funded_check
  before update of units_sold on tokenizations
  for each row execute function auto_fund_tokenization();

-- Update timestamps
create or replace function update_rwa_timestamp()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger assets_updated_at
  before update on assets
  for each row execute function update_rwa_timestamp();

create trigger tokenizations_updated_at
  before update on tokenizations
  for each row execute function update_rwa_timestamp();

create trigger token_holdings_updated_at
  before update on token_holdings
  for each row execute function update_rwa_timestamp();

-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security (placeholder policies - to be configured per deployment)
-- ─────────────────────────────────────────────────────────────────────────────
alter table assets enable row level security;
alter table tokenizations enable row level security;
alter table token_holdings enable row level security;
alter table payout_distributions enable row level security;
alter table payout_records enable row level security;

-- Basic policies: owners can read their own data
-- (Production will need more nuanced policies for investors, admins, etc.)
create policy assets_owner_read on assets
  for select using (owner_user_id = auth.uid()::uuid);

create policy tokenizations_issuer_read on tokenizations
  for select using (issuer_user_id = auth.uid()::uuid);

create policy token_holdings_holder_read on token_holdings
  for select using (holder_user_id = auth.uid()::uuid);

create policy payout_records_holder_read on payout_records
  for select using (holder_user_id = auth.uid()::uuid);

-- ─────────────────────────────────────────────────────────────────────────────
-- Comments for documentation
-- ─────────────────────────────────────────────────────────────────────────────
comment on table assets is 'Real-world assets available for tokenization';
comment on table tokenizations is 'On-chain RWA token contracts representing fractional ownership';
comment on table token_holdings is 'Investor ownership records of tokenized units';
comment on table payout_distributions is 'Pro-rata payout events triggered by buyer payments';
comment on table payout_records is 'Individual holder shares in a payout distribution';

commit;
