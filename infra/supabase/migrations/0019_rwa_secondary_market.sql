-- StellarTrust — RWA secondary market (plane.md §3.3)
-- Forward-only Postgres/Supabase migration (Rules.md §2).
--
-- Why this exists
-- ───────────────
-- Until now `purchaseUnits` refused outright when the investor already held a
-- position ("Secondary purchases not yet supported" — finding D6). An investor
-- could enter but never exit, and never add to a position they liked. A claim
-- you cannot sell is not an investment; it is a donation with a maturity date.
--
-- Two things are needed to change that, and only one of them is schema.
--
--   rwa_secondary_seller_payable   where a selling holder's proceeds land.
--
-- It is a *separate* account from `rwa_issuer_proceeds_payable` because on a
-- secondary trade the issuer receives nothing — the money moves between two
-- investors, and posting it to the issuer's payable would credit them for a
-- sale they were not party to and quietly overstate what the platform owes
-- them.
--
-- Everything else the secondary market needs already exists: `token_holdings`
-- carries units per (tokenization, holder) and the 0006 `sync_units_sold`
-- trigger recomputes `units_sold` from those rows, so a transfer between two
-- holders nets to zero there without any schema change. That is worth stating
-- because the obvious instinct — add a `transfers` table — would duplicate
-- state the holdings rows already hold.

-- ─────────────────────────────────────────────────────────────────────────────
-- Secondary-market seller proceeds
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Seeded per currency to match the shape of every other system account: the
-- chart is unique on (owner_ref, currency, name), and the synthetic id in
-- `system-accounts.ts` resolves to this NAME at write time.

insert into ledger_accounts (type, currency, owner_ref, name)
select account_type::ledger_account_type, currency, 'system', account_name
from (values
  ('liability', 'rwa_secondary_seller_payable')  -- Owed to a holder who sold units
) as account_kinds(account_type, account_name)
cross join (values ('USD'),('EUR'),('INR'),('NGN'),('XLM'),('USDC'))
  as currencies(currency)
on conflict (owner_ref, currency, name) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- A holding's units must stay positive
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 0006 constrained `units_sold <= total_units` on the tokenization but left the
-- individual holding unconstrained, because until now units only ever moved in
-- one direction: issuer → investor, once. A secondary transfer subtracts from
-- the seller, so an arithmetic slip could drive a holding negative — and a
-- negative holding would earn a *negative* pro-rata payout share, taking money
-- from the other holders.
--
-- The service refuses to oversell before it posts anything. This is the same
-- rule stated where it cannot be bypassed.
--
-- 0006 allowed `units >= 0`, so a zero-unit holding could already exist. Those
-- rows are removed before the stricter constraint is added: a holding of zero
-- units owns nothing, matches no on-chain balance, and earns a zero payout
-- share — it is the residue of a fully-exited position, not a position.

delete from token_holdings where units = 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'token_holdings_units_positive'
  ) then
    -- A zero-unit holding is deleted rather than kept, so the floor is 1.
    alter table token_holdings
      add constraint token_holdings_units_positive
      check (units > 0);
  end if;
end$$;
