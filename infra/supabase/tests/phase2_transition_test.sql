-- Phase 2 database smoke test: a payment transition links one balanced ledger
-- transaction to one matching Stellar transaction, and an open mismatch blocks
-- lifecycle state changes. Runs inside a rollback-only transaction.

begin;

insert into users (id, email, kyc_status)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'phase2-buyer@example.invalid', 'verified'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'phase2-seller@example.invalid', 'verified');

insert into orders (id, buyer_id, seller_id, amount, currency, status)
values (
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  12500,
  'USDC',
  'created'
);

insert into ledger_transactions (id, reference_id, description)
values (
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'phase2-db-smoke-create',
  'Phase 2 DB smoke create'
);

insert into ledger_entries (transaction_id, account_id, direction, amount, currency)
select
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  id,
  case name
    when 'commitment_asset' then 'debit'::entry_direction
    else 'credit'::entry_direction
  end,
  12500,
  'USDC'
from ledger_accounts
where owner_ref = 'system'
  and currency = 'USDC'
  and name in ('commitment_asset', 'commitment_liability');

insert into stellar_transactions (
  id, hash, type, status, ledger_transaction_id,
  order_id, transition, amount, currency
) values (
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'phase2-db-smoke-hash',
  'escrow_create',
  'success',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'create',
  12500,
  'USDC'
);

insert into payment_transitions (
  id, order_id, transition, actor_id,
  ledger_transaction_id, stellar_transaction_id
) values (
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'create',
  'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
);

set constraints all immediate;

do $$
begin
  if not exists (
    select 1
    from payment_transitions pt
    join stellar_transactions st on st.id = pt.stellar_transaction_id
    where pt.id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
      and st.ledger_transaction_id = pt.ledger_transaction_id
  ) then
    raise exception 'Phase 2 transition was not linked';
  end if;
end $$;

insert into reconciliation_mismatches (
  order_id, payment_transition_id, reason
) values (
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  'smoke-test mismatch'
);

do $$
begin
  if not (select reconciliation_blocked from orders
          where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc') then
    raise exception 'Open mismatch did not block the order';
  end if;

  begin
    update orders set status = 'accepted'
    where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    raise exception 'Blocked order incorrectly advanced';
  exception
    when check_violation then null;
  end;
end $$;

rollback;
