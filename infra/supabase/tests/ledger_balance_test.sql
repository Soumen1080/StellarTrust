-- Smoke test for the database-level double-entry balancing invariant.
-- Run against a database with 0001+0002 applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f ledger_balance_test.sql
-- Expectation: the BALANCED block commits; the UNBALANCED block raises and
-- rolls back. The final SELECT proves exactly one transaction was persisted.

\set ON_ERROR_STOP on

-- Fetch two system accounts to post against.
-- (Assumes 0002 seed applied.)

-- 1) BALANCED transaction — must succeed.
do $$
declare
  debit_acct  uuid;
  credit_acct uuid;
  txid        uuid;
begin
  select id into debit_acct  from ledger_accounts where owner_ref='system' and currency='USD' and name='cash_clearing';
  select id into credit_acct from ledger_accounts where owner_ref='system' and currency='USD' and name='escrow_holding';

  insert into ledger_transactions (reference_id, description)
  values ('test-balanced-1', 'balanced deposit') returning id into txid;

  insert into ledger_entries (transaction_id, account_id, direction, amount, currency) values
    (txid, debit_acct,  'debit',  10000, 'USD'),
    (txid, credit_acct, 'credit', 10000, 'USD');
end $$;

-- 2) UNBALANCED transaction — must fail at commit and roll back.
do $$
declare
  debit_acct  uuid;
  credit_acct uuid;
  txid        uuid;
begin
  select id into debit_acct  from ledger_accounts where owner_ref='system' and currency='USD' and name='cash_clearing';
  select id into credit_acct from ledger_accounts where owner_ref='system' and currency='USD' and name='escrow_holding';

  begin
    insert into ledger_transactions (reference_id, description)
    values ('test-unbalanced-1', 'unbalanced deposit') returning id into txid;

    insert into ledger_entries (transaction_id, account_id, direction, amount, currency) values
      (txid, debit_acct,  'debit',  10000, 'USD'),
      (txid, credit_acct, 'credit',  9999, 'USD');

    -- Force the deferred constraint to check now, inside this sub-block.
    set constraints ledger_balance_check immediate;

    raise exception 'TEST FAILED: unbalanced transaction was accepted';
  exception
    when check_violation then
      raise notice 'OK: unbalanced transaction correctly rejected';
  end;
end $$;

-- Proof: exactly one persisted transaction (the balanced one).
select count(*) as persisted_transactions from ledger_transactions;
