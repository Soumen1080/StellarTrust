-- StellarTrust — seed system ledger accounts (Phase 0).
-- These are internal accounts the platform posts against (not user-owned).
-- Idempotent: safe to re-run.

begin;

insert into ledger_accounts (type, currency, owner_ref, name)
values
  ('liability', 'USD', 'system', 'escrow_holding'),
  ('liability', 'EUR', 'system', 'escrow_holding'),
  ('liability', 'INR', 'system', 'escrow_holding'),
  ('asset',     'USD', 'system', 'cash_clearing'),
  ('asset',     'EUR', 'system', 'cash_clearing'),
  ('asset',     'INR', 'system', 'cash_clearing'),
  ('revenue',   'USD', 'system', 'platform_fees'),
  ('revenue',   'EUR', 'system', 'platform_fees'),
  ('revenue',   'INR', 'system', 'platform_fees')
on conflict (owner_ref, currency, name) do nothing;

commit;
