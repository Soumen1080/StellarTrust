-- Smoke test for the database-level money-safety invariants (plane.md §4.3)
-- and the per-user ledger accounts that back a balance (§4.5).
--
-- Run against a database with every migration applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f money_invariants_test.sql
--
-- These invariants are already checked in application code. They are restated
-- in the database because an application check protects against the code paths
-- someone thought of, and a database check protects against the ones they did
-- not — a future migration, a manual fix applied in a console at 3am, a second
-- service written against the same tables.
--
-- A test that only proved the *happy* path would prove nothing: every one of
-- these is a refusal, so each block below asserts the write is rejected and
-- fails loudly if it is accepted.

\set ON_ERROR_STOP on

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixtures
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  issuer_id uuid;
  asset_id  uuid;
begin
  insert into users (email, kyc_status)
  values ('invariants-issuer@test.local', 'verified')
  returning id into issuer_id;

  insert into assets (owner_user_id, asset_type, asset_ref, description,
                      valuation_amount, valuation_currency)
  values (issuer_id, 'invoice', 'invariants:INV-1', '90-day receivable',
          1000000, 'USDC')
  returning id into asset_id;

  -- 1000 units at 800 minor each; face value 1,000,000 at an 80% advance.
  insert into tokenizations (
    asset_id, issuer_user_id, total_units, units_sold,
    price_per_unit_amount, price_per_unit_currency,
    face_value_amount, face_value_currency,
    advance_rate_bps, discount_rate_bps, platform_fee_bps,
    maturity_date, status
  )
  values (
    asset_id, issuer_id, 1000, 0,
    800, 'USDC',
    1000000, 'USDC',
    8000, 400, 100,
    now() + interval '90 days', 'active'
  );
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- §4.5 — a user ledger account, and the balance derived from its entries
-- ─────────────────────────────────────────────────────────────────────────────

-- A user account must be a liability: the balance is what the platform owes
-- them. Typed as an asset, its balance would read with the sign inverted and
-- an overdrawn user would look funded.
do $$
declare
  user_id uuid;
begin
  select id into user_id from users where email = 'invariants-issuer@test.local';

  begin
    insert into ledger_accounts (type, currency, owner_ref, name)
    values ('asset', 'USDC', 'user:' || user_id, 'user_cash');
    raise exception 'TEST FAILED: a user account was accepted as an asset';
  exception
    when check_violation then
      raise notice 'OK: a user-owned account must be a liability';
  end;
end $$;

-- An owner_ref that does not match the documented shape is refused, because
-- it is what balances are keyed on: a typo would silently create a second
-- account no balance read ever finds.
do $$
begin
  begin
    insert into ledger_accounts (type, currency, owner_ref, name)
    values ('liability', 'USDC', 'users:not-a-uuid', 'user_cash');
    raise exception 'TEST FAILED: a malformed owner_ref was accepted';
  exception
    when check_violation then
      raise notice 'OK: owner_ref shape is enforced';
  end;
end $$;

-- The balance view derives from entries rather than storing a second copy.
do $$
declare
  user_id     uuid;
  user_acct   uuid;
  clearing    uuid;
  txid        uuid;
  observed    bigint;
begin
  select id into user_id from users where email = 'invariants-issuer@test.local';

  insert into ledger_accounts (type, currency, owner_ref, name)
  values ('liability', 'USDC', 'user:' || user_id, 'user_cash')
  returning id into user_acct;

  select id into clearing
  from ledger_accounts
  where owner_ref = 'system' and currency = 'USDC' and name = 'cash_clearing';

  -- A deposit: platform cash in, user credited.
  insert into ledger_transactions (reference_id, description)
  values ('invariants-deposit-1', 'deposit') returning id into txid;
  insert into ledger_entries (transaction_id, account_id, direction, amount, currency)
  values (txid, clearing, 'debit', 50000, 'USDC'),
         (txid, user_acct, 'credit', 50000, 'USDC');

  -- A purchase: the user spends, which debits their liability.
  insert into ledger_transactions (reference_id, description)
  values ('invariants-spend-1', 'purchase') returning id into txid;
  insert into ledger_entries (transaction_id, account_id, direction, amount, currency)
  values (txid, user_acct, 'debit', 20000, 'USDC'),
         (txid, clearing, 'credit', 20000, 'USDC');

  select balance into observed
  from ledger_account_balances
  where account_id = user_acct;

  if observed <> 30000 then
    raise exception 'TEST FAILED: expected a balance of 30000, got %', observed;
  end if;
  raise notice 'OK: balance derives from entries (50000 credited - 20000 debited)';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- §4.3 invariant 1 — units_sold cannot exceed total_units
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  tok_id uuid;
begin
  select id into tok_id from tokenizations
  where asset_id = (select id from assets where asset_ref = 'invariants:INV-1');

  begin
    update tokenizations set units_sold = 1001 where id = tok_id;
    raise exception 'TEST FAILED: units_sold exceeded total_units';
  exception
    when check_violation then
      raise notice 'OK: units_sold cannot exceed total_units';
  end;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- §4.3 invariant 2 — one holding cannot exceed the tokenization's supply
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  tok_id    uuid;
  holder_id uuid;
begin
  select id into tok_id from tokenizations
  where asset_id = (select id from assets where asset_ref = 'invariants:INV-1');

  insert into users (email, kyc_status)
  values ('invariants-holder@test.local', 'verified')
  returning id into holder_id;

  begin
    insert into token_holdings (tokenization_id, holder_user_id, holder_address,
                                units, purchase_amount, purchase_currency)
    values (tok_id, holder_id,
            'GDYWVMFH5JDIISEZMLDFTN6A5NHPLZGKTTYAAKGB5Z6U7MHKUV6JPVS5',
            1500, 1200000, 'USDC');
    raise exception 'TEST FAILED: a holding exceeded the total supply';
  exception
    when check_violation then
      raise notice 'OK: a holding cannot exceed the tokenization supply';
  end;
end $$;

-- And the sum across holders is bounded too, not only each row on its own.
do $$
declare
  tok_id     uuid;
  holder_a   uuid;
  holder_b   uuid;
begin
  select id into tok_id from tokenizations
  where asset_id = (select id from assets where asset_ref = 'invariants:INV-1');

  select id into holder_a from users where email = 'invariants-holder@test.local';
  insert into users (email, kyc_status)
  values ('invariants-holder-b@test.local', 'verified')
  returning id into holder_b;

  insert into token_holdings (tokenization_id, holder_user_id, holder_address,
                              units, purchase_amount, purchase_currency)
  values (tok_id, holder_a,
          'GDYWVMFH5JDIISEZMLDFTN6A5NHPLZGKTTYAAKGB5Z6U7MHKUV6JPVS5',
          600, 480000, 'USDC');

  begin
    insert into token_holdings (tokenization_id, holder_user_id, holder_address,
                                units, purchase_amount, purchase_currency)
    values (tok_id, holder_b,
            'GBNPF7BZKNCAS32XWOBWGL7KD6NFHLZO5GQDIJA7Z73B7YISNM4MFZNL',
            600, 480000, 'USDC');
    raise exception 'TEST FAILED: holdings totalled more than the supply';
  exception
    when check_violation then
      raise notice 'OK: holdings in aggregate cannot exceed the supply';
  end;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- §4.3 invariant 3 — payouts cannot exceed what is collectible
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The trigger is DEFERRED, so it fires at COMMIT. `set constraints … immediate`
-- forces it to check inside the sub-block, which is how a rejection can be
-- caught and asserted on rather than aborting the script.
do $$
declare
  tok_id   uuid;
  dist_id  uuid;
  holder   uuid;
begin
  select id into tok_id from tokenizations
  where asset_id = (select id from assets where asset_ref = 'invariants:INV-1');
  select id into holder from users where email = 'invariants-holder@test.local';

  insert into payout_distributions (tokenization_id, total_amount,
                                    total_currency, status)
  values (tok_id, 900000, 'USDC', 'pending')
  returning id into dist_id;

  begin
    -- Face value is 1,000,000. A payout of 1,000,001 to investors is more than
    -- the position can ever have collected.
    insert into payout_records (distribution_id, holder_user_id, units_held,
                                share_amount, share_currency)
    values (dist_id, holder, 600, 1000001, 'USDC');

    set constraints assert_payout_within_collection immediate;

    raise exception 'TEST FAILED: a payout exceeded the collectible amount';
  exception
    when check_violation then
      raise notice 'OK: payouts cannot exceed the collectible face value';
  end;
end $$;

-- A payout within the ceiling is accepted — the constraint must not refuse
-- legitimate distributions, which is the failure that would be discovered
-- only when a real payout could not be recorded.
do $$
declare
  tok_id  uuid;
  dist_id uuid;
  holder  uuid;
begin
  select id into tok_id from tokenizations
  where asset_id = (select id from assets where asset_ref = 'invariants:INV-1');
  select id into holder from users where email = 'invariants-holder@test.local';

  insert into payout_distributions (tokenization_id, total_amount,
                                    total_currency, status)
  values (tok_id, 832000, 'USDC', 'pending')
  returning id into dist_id;

  insert into payout_records (distribution_id, holder_user_id, units_held,
                              share_amount, share_currency)
  values (dist_id, holder, 600, 499200, 'USDC');

  set constraints assert_payout_within_collection immediate;
  raise notice 'OK: a payout within the ceiling is accepted';
end $$;

select 'money invariants: all checks passed' as result;
