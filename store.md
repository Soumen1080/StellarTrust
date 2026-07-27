# StellarTrust — Data Store & Route Map

A route-wise reference of every API surface, the database tables behind it, and
exactly what each table stores.

Source of truth for this document:
- Migrations: `infra/supabase/migrations/0001` … `0006`
- Routers: `backend/src/modules/*/**.routes.ts`
- Wiring: `backend/src/app.ts`

---

## 1. Design Principles

| Principle | How it is enforced |
|---|---|
| The double-entry ledger is the system of record | Every money movement writes a balanced `ledger_entries` set **and** a `stellar_transactions` row |
| Invariants live in the database, not the app | Deferred constraint triggers reject bad writes even if application code is wrong |
| Money is never a float | All amounts are `bigint` in integer **minor units** (e.g. cents) |
| No raw PII in Postgres | KYC stores score + decision only; documents/images stay with the provider. Evidence and webhook payloads are stored as storage **references** |
| Fail closed | An unresolved reconciliation mismatch blocks all order lifecycle changes |
| Human gate on AI | AI columns are advisory; a separate human decision column is authoritative |
| Forward-only migrations | No down-migrations; corrections are new numbered files |

**Totals:** 24 tables, 6 migrations, 8 route modules, 4 infrastructure endpoints.

---

## 2. Enum Types

| Enum | Values | Defined in |
|---|---|---|
`kyc_status` | pending, under_review, verified, rejected | 0001
`kyc_decision` | approve, review, reject | 0001
`order_status` | created, accepted, deposited, locked, confirmed, released, refunded, disputed, cancelled | 0001
`escrow_state` | locked, released, refunded, disputed | 0001
`dispute_status` | open, evidence_window, under_review, resolved | 0001
`ai_recommendation` | release, refund, manual_review | 0001
`entry_direction` | debit, credit | 0001
`ledger_account_type` | asset, liability, equity, revenue, expense | 0001
`chain_tx_status` | pending, submitted, success, failed | 0001
`custody_type` | self, contract | 0001
`applicant_type` | individual, business | 0003
`provider_check_status` | pass, review, fail | 0003
`kyc_review_status` | queued, resolved | 0003
`human_kyc_decision` | approve, reject | 0003
`payment_transition` | create, accept, deposit, lock, confirm, release, refund | 0004
`reconciliation_status` | open, resolved | 0004
`asset_type` | invoice, commodity, real_estate, other | 0006
`tokenization_status` | draft, active, funded, distributing, distributed, frozen, cancelled | 0006
`payout_status` | pending, processing, completed, failed | 0006

---

## 3. Route-Wise Store Map

### 3.1 `/api/auth` — SEP-10 Wallet Authentication

**Routes**

| Method | Path | Auth | Purpose |
|---|---|---|---|
POST | `/api/auth/sep10/challenge` | public | Issue a one-time challenge transaction for a wallet to sign |
POST | `/api/auth/sep10/verify` | public | Verify the signed challenge, mint a session bearer token |
GET | `/api/auth/me` | bearer | Return the caller's profile + latest KYC snapshot |

**Tables**

| Table | Columns / what is stored |
|---|---|
`sep10_challenges` | `stellar_public_key`, `transaction_hash` (unique), `network_passphrase`, `expires_at`, `consumed_at`, `created_at`. CHECK `expires_at > created_at`. One-time + expiring, so a challenge cannot be replayed. |
`auth_sessions` | `user_id`, `wallet_id`, `token_hash` (unique), `roles text[]` default `{user}`, `expires_at`, `revoked_at`. **Only the SHA-256 hash of the token is stored — never the token itself.** Partial index on active (non-revoked) sessions. |
`users` | `email` (unique), `kyc_status`, `auth_subject` (unique), `display_name`, `verified_at`, `latest_verification` jsonb (denormalized DTO for `GET /me`), `created_at`, `updated_at`. |
`wallets` | `user_id`, `stellar_public_key` (unique), `custody_type` (`self`/`contract`), `verified_at`, `last_authenticated_at`. |
`businesses` | `owner_user_id`, `legal_name`, `country`, `registration_number`, `verification_id` → `kyc_verifications`. |

---

### 3.2 `/api/kyc` — Identity Verification

**Routes**

| Method | Path | Auth | Purpose |
|---|---|---|---|
GET | `/api/kyc/status` | bearer | Current KYC state for the caller |
POST | `/api/kyc/applications` | bearer + idempotency | Submit a verification application |
GET | `/api/kyc/reviews` | bearer (compliance) | Human review queue |
GET | `/api/kyc/dev/reviews` | dev password | Local-only review listing |
POST | `/api/kyc/dev/reviews/:reviewId/approve` | dev password | Local-only approval shortcut |

> The `/dev/*` endpoints are unavailable unless the backend is in development
> **and** a server-side approval password is configured.

**Tables**

| Table | Columns / what is stored |
|---|---|
`kyc_verifications` | `user_id`, `provider`, `provider_ref`, `applicant_type`, `provider_checks` jsonb, `risk_score` numeric(5,4) 0–1, `decision`, `status`, `ai_confidence`, `ai_explanation`, `ai_signals` jsonb, `submitted_at`, `decided_at`. **Stores score + decision only — no identity documents, no face images, no raw provider payload.** |
`kyc_review_queue` | `verification_id` (unique), `user_id`, `status` (queued/resolved), `provider_checks` jsonb, `advisory_snapshot` jsonb, `resolved_by`, `resolution` (approve/reject), `resolution_reason`, `resolved_at`. CHECK forces resolved rows to carry both a resolution and a timestamp. |

---

### 3.3 `/api/ledger` — Double-Entry Accounting

**Routes**

| Method | Path | Auth | Purpose |
|---|---|---|---|
POST | `/api/ledger/transactions` | bearer + idempotency | Record a balanced double-entry transaction |
GET | `/api/ledger/transactions/:referenceId` | bearer | Look up a transaction by money-movement reference id |

**Tables**

| Table | Columns / what is stored |
|---|---|
`ledger_accounts` | `type` (asset/liability/equity/revenue/expense), `currency`, `owner_ref` (`system`, `user:<id>`, `business:<id>`), `name`. Unique `(owner_ref, currency, name)`. |
`ledger_transactions` | `reference_id` **(unique — the idempotency/correlation key that prevents double-posting)**, `description`, `created_at`. |
`ledger_entries` | `transaction_id`, `account_id`, `direction` (debit/credit), `amount` bigint minor units CHECK `> 0`, `currency`. Indexed by transaction and by account. |

**Enforcement — `ledger_balance_check`**

A `deferrable initially deferred` constraint trigger on `ledger_entries`. At
COMMIT it asserts, for the whole transaction:

1. For **every** currency, `sum(debits) == sum(credits)`
2. At least one debit **and** one credit are present

Because it is deferred, multi-row inserts are assembled first and validated as a
whole. This is the invariant proven by
`infra/supabase/tests/ledger_balance_test.sql` in CI.

**Seeded system accounts**

| Migration | Accounts | Currencies |
|---|---|---|
0002 | `escrow_holding` (liability), `cash_clearing` (asset), `platform_fees` (revenue) | USD, EUR, INR |
0004 | `commitment_asset`, `commitment_liability`, `cash_clearing`, `escrow_holding`, `contract_custody`, `delivery_confirmation_asset`, `delivery_confirmation_liability` | USD, EUR, INR, NGN, XLM, USDC |
0006 | `rwa_investment_receivable`, `rwa_investment_liability`, `rwa_escrow_holding`, `rwa_payout_payable`, `rwa_payout_reserve` | USD, EUR, INR, NGN, XLM, USDC |

All seeds use `on conflict (owner_ref, currency, name) do nothing` and are
re-runnable.

---

### 3.4 `/api/payments` — Orders & Escrow (the happy path)

**Routes**

| Method | Path | Auth | Purpose |
|---|---|---|---|
POST | `/api/payments/orders` | bearer + idempotency | Create an order |
GET | `/api/payments/orders` | bearer | List the caller's orders |
GET | `/api/payments/orders/:orderId` | bearer | Order detail |
POST | `/api/payments/orders/:orderId/accept` | bearer + idempotency | Transition → accept |
POST | `/api/payments/orders/:orderId/deposit` | bearer + idempotency | Transition → deposit |
POST | `/api/payments/orders/:orderId/lock` | bearer + idempotency | Transition → lock |
POST | `/api/payments/orders/:orderId/confirm` | bearer + idempotency | Transition → confirm |
POST | `/api/payments/orders/:orderId/release` | bearer + idempotency | Transition → release |
POST | `/api/payments/orders/:orderId/refund` | bearer + idempotency | Transition → refund |
POST | `/api/payments/reconciliation/run` | bearer | Trigger a reconciliation sweep |

**Tables**

| Table | Columns / what is stored |
|---|---|
`orders` | `buyer_id`, `seller_id`, `amount` bigint, `currency`, `status` (`order_status`), `reconciliation_blocked` boolean, timestamps. CHECK `buyer_id <> seller_id`. |
`escrows` | `order_id` (**unique** — one escrow per order), Soroban `contract_id`, `state` (locked/released/refunded/disputed). |
`payment_transitions` | `order_id`, `transition`, `actor_id`, `ledger_transaction_id` (**not null, unique**), `stellar_transaction_id` (**not null, unique**). Unique `(order_id, transition)` so a transition can never fire twice. This is the audit spine binding books to chain. |
`stellar_transactions` | `hash` (unique), `type`, `status` (pending/submitted/success/failed), `ledger_transaction_id`, `order_id`, `transition`, `amount`, `currency`, `contract_id`, `updated_at`. CHECK `stellar_payment_metadata_complete`: the payment metadata group is either all-null or all-present. |
`reconciliation_mismatches` | `order_id`, `payment_transition_id`, `reason`, `status` (open/resolved), `detected_at`, `resolved_at`. CHECK ties `resolved_at` to status. Partial unique index allows only **one open** mismatch per transition. |

**Enforcement — three triggers**

| Trigger | Behaviour |
|---|---|
`payment_transition_link_check` | Deferred. A transition's chain record must reference the **same** ledger transaction, order, and transition — otherwise `check_violation`. |
`reconciliation_block_sync` | Inserting an `open` mismatch sets `orders.reconciliation_blocked = true`; resolving one clears it only if no other open mismatch remains. |
`orders_reconciliation_block` | While `reconciliation_blocked` is true, **any** `status` change raises an exception. Money cannot move while the books and the chain disagree. |

Verified in CI by `infra/supabase/tests/phase2_transition_test.sql`.

---

### 3.5 `/api/disputes` — Dispute Resolution with AI Advisory

**Routes**

| Method | Path | Auth | Purpose |
|---|---|---|---|
POST | `/api/disputes` | bearer (order party) | Open a dispute against an order |
GET | `/api/disputes` | bearer | List the caller's own disputes |
GET | `/api/disputes/queue` | bearer (compliance) | Open-dispute queue |
GET | `/api/disputes/:disputeId` | bearer | Dispute detail |
POST | `/api/disputes/:disputeId/evidence` | bearer (order party) | Submit evidence within the open window |

**Tables**

| Table | Columns / what is stored |
|---|---|
`disputes` | `escrow_id`, `status` (open/evidence_window/under_review/resolved), `ai_recommendation`, `ai_confidence` numeric(5,4), `ai_explanation`, `human_decision`. **The AI columns are advisory only; `human_decision` is the authoritative gate.** |
`dispute_evidence` | `dispute_id`, `kind` (invoice / tracking / otp / courier / image), `uri` — a **storage reference, never inline PII** — `submitted_by`. |

A resolved dispute's outcome is auto-executed through the Phase 2 arbiter
payments path under the system actor `system:dispute-resolver` (non-fatal on
failure).

---

### 3.6 `/api/rwa` — Real-World Asset Tokenization (opt-in peer module)

Not part of the escrow happy path. Payouts distribute when the buyer pays
through escrow.

**Routes**

| Method | Path | Auth | Purpose |
|---|---|---|---|
POST | `/api/rwa/assets` | bearer + idempotency | Create an asset for tokenization |
GET | `/api/rwa/assets` | bearer | List assets owned by the caller |
POST | `/api/rwa/tokenizations` | bearer + idempotency | Create a tokenization for an asset |
POST | `/api/rwa/tokenizations/:tokenizationId/deploy` | bearer + idempotency | Deploy the Soroban contract |
GET | `/api/rwa/tokenizations/:tokenizationId` | bearer | Tokenization detail |

**Tables**

| Table | Columns / what is stored |
|---|---|
`assets` | `owner_user_id`, `asset_type`, `asset_ref` (e.g. `invoice:INV-001`), `description`, `valuation_amount` bigint, `valuation_currency`, `metadata` jsonb (opaque document references). Unique `(owner_user_id, asset_ref)`. |
`tokenizations` | `asset_id`, `issuer_user_id`, `contract_id` (unique, null until deployed), `contract_deployed_at`, `total_units`, `units_sold`, `price_per_unit_amount`, `price_per_unit_currency`, compliance flags `require_authorization` / `frozen`, `linked_order_id`, `status`. CHECK: draft ⇔ no contract; non-draft ⇔ contract present. |
`token_holdings` | `tokenization_id`, `holder_user_id`, `holder_address` (Stellar address), `units`, `purchase_amount`, `purchase_currency`, `purchased_at`, `authorized`. Unique per `(tokenization, holder_user)` and per `(tokenization, holder_address)`. |
`payout_distributions` | `tokenization_id`, `triggered_by_order_id`, `triggered_by_transition`, `total_amount`, `total_currency`, `status`, `ledger_transaction_id`, `initiated_at`, `completed_at`. CHECK ties `completed` to both a timestamp and a ledger transaction. |
`payout_records` | `distribution_id`, `holder_user_id`, `units_held`, `share_amount`, `share_currency`, `ledger_entry_id`. Unique `(distribution_id, holder_user_id)`. |

**Triggers**

| Trigger | Behaviour |
|---|---|
`sync_units_sold` | Maintains `tokenizations.units_sold` on holding insert / unit update / delete |
`check_tokenization_capacity` | Rejects an insert that would push `units_sold` past `total_units` |
`tokenization_funded_check` | Auto-transitions `active → funded` when fully sold |
`assets_updated_at`, `tokenizations_updated_at`, `token_holdings_updated_at` | Refresh `updated_at` |

**Migration note:** `0006` intentionally drops the Phase 0 placeholder
`assets` / `tokenizations` / `token_holdings` from `0001` (which used
`issuer_id`, `face_value`, `stellar_asset_code`, `investor_id`) and recreates
them with the full Phase 5 schema. The placeholders were never referenced by
application code, so the drop is forward-only and safe — and it prevents a
name collision on a clean sequential apply.

---

### 3.7 `/api/settlement` — Cross-Border Settlement

**Routes**

| Method | Path | Auth | Purpose |
|---|---|---|---|
GET | `/api/settlement/corridors` | bearer | Supported corridor catalog |
POST | `/api/settlement/quotes` | bearer | Price a corridor transfer (read-style, no idempotency key) |
POST | `/api/settlement/orders` | bearer + idempotency | Execute a quote end-to-end (money movement) |
GET | `/api/settlement/orders` | bearer | List the caller's settlements |
GET | `/api/settlement/orders/:settlementId` | bearer | Settlement detail |

**Tables: none.** A search of all migrations for `settlement|corridor|anchor`
returns no matches. This module runs entirely on
`InMemorySettlementRepository` — state is lost on restart.

---

### 3.8 `/api/reputation` — Advisory Trust Scoring

**Routes**

| Method | Path | Auth | Purpose |
|---|---|---|---|
GET | `/api/reputation/me` | bearer | The caller's own reputation |
GET | `/api/reputation/:userId` | bearer (compliance) | Look up any user |

**Tables: none.** Backed by `InMemoryReputationRepository`. Feeds an advisory
prior into dispute risk; a completed escrow release records a positive signal.

---

## 4. Cross-Cutting Tables (no dedicated route)

| Table | Columns / what is stored |
|---|---|
`audit_log` | `actor` (`user:<id>` / `system` / `ai`), `action`, `entity`, `entity_id`, `metadata` jsonb, `created_at`. **Truly append-only:** rules `audit_log_no_update` and `audit_log_no_delete` make UPDATE and DELETE do nothing. Indexed on `(entity, entity_id, created_at)` and `(actor, created_at)` for compliance investigations. |
`webhook_events` | `source`, `external_id` (provider event id), `signature_verified`, `payload_ref` (storage reference — raw payload is **not** inlined), `processed_at`, `verification_id`. Unique `(source, external_id)` for replay protection. |

---

## 5. Infrastructure Endpoints

| Method | Path | Purpose |
|---|---|---|
GET | `/health` | Service name, version, timestamp |
GET | `/health/live` | Liveness — never touches dependencies, so an orchestrator won't kill a pod during a transient dependency blip |
GET | `/health/ready` | Readiness — pings the database and checks unresolved ledger + settlement reconciliation counts. Returns **503 `degraded`** so the load balancer stops routing until recovery |
GET | `/metrics` | Prometheus text exposition (`version=0.0.4`), operational signals only, no PII |

**Global middleware** (`backend/src/app.ts`): helmet, origin allow-list CORS,
`express.json({ limit: "1mb" })`, request id, pino-http, HTTP metrics, and rate
limiting at 300 requests / 60s. `trust proxy = 1` so `req.ip` resolves to the
real client behind Vercel's TLS-terminating proxy.

---

## 6. Migration Inventory

| File | Adds |
|---|---|
`0001_initial_schema.sql` | pgcrypto; 10 enums; `users`, `businesses`, `kyc_verifications`, `wallets`, `ledger_accounts`, `ledger_transactions`, `ledger_entries`, `orders`, `escrows`, `disputes`, `dispute_evidence`, placeholder `assets`/`tokenizations`/`token_holdings`, `stellar_transactions`, `webhook_events`, `audit_log`; `ledger_balance_check`; audit append-only rules |
`0002_seed_system_accounts.sql` | Seeds `escrow_holding`, `cash_clearing`, `platform_fees` for USD/EUR/INR |
`0003_phase1_identity_wallet.sql` | 4 enums; `sep10_challenges`, `auth_sessions`, `kyc_review_queue`; identity columns on `users`/`businesses`/`wallets`; provider-check + AI advisory columns on `kyc_verifications`; audit indexes; RLS enable + `auth.uid()`-guarded self-read policies |
`0004_phase2_core_payment_escrow.sql` | 2 enums; `payment_transitions`, `reconciliation_mismatches`; payment metadata on `stellar_transactions`; `reconciliation_blocked` on `orders`; the three payment triggers; 7 account types × 6 currencies; RLS enable |
`0005_session_roles_and_verification_snapshot.sql` | `auth_sessions.roles text[]`; `users.latest_verification` jsonb |
`0006_phase5_rwa_tokenization.sql` | 3 enums; replaces RWA placeholders with `assets`, `tokenizations`, `token_holdings`, `payout_distributions`, `payout_records`; 5 triggers; 5 RWA accounts × 6 currencies; RLS enable + `auth.uid()`-guarded policies |

### RLS / CI portability note

Supabase provides `auth.uid()`; a plain `postgres:16` CI container does not.
Both `0003` and `0006` therefore create their self-read policies inside a guard:

```sql
do $$
begin
  if to_regprocedure('auth.uid()') is not null then
    execute 'create policy ... using (owner_user_id = auth.uid()::uuid)';
  end if;
end $$;
```

RLS stays **enabled and deny-by-default** on every client-facing table either
way; only the policies are conditional. The backend is the authoritative policy
boundary and connects with a privileged role.

---

## 7. Persistence Status — Schema vs. Running Code

`backend/src/app.ts` selects a Postgres repository for **identity and auth
only**:

```typescript
const usePersistentStore = Boolean(config.DATABASE_URL) && !config.isTest;
const identities = usePersistentStore
  ? new PgIdentityRepository(getPool(), demoAccounts)
  : new InMemoryIdentityRepository(demoAccounts);
const authRepository = usePersistentStore
  ? new PgAuthRepository(getPool())
  : new InMemoryAuthRepository();
```

Every other module is hardcoded to in-memory regardless of `DATABASE_URL`.

| Module | Repository in use | Persists across restart? |
|---|---|---|
Identity | `PgIdentityRepository` (when `DATABASE_URL` set) | Yes |
Auth / sessions | `PgAuthRepository` (when `DATABASE_URL` set) | Yes |
Payments / orders / escrow | `InMemoryPaymentRepository` | **No** |
Ledger | router wired as `createLedgerRouter(undefined, …)` | **No** |
KYC | `InMemoryKycRepository` | **No** |
Disputes | `InMemoryDisputeRepository` | **No** |
RWA | `InMemoryRwaRepository` | **No** |
Settlement | `InMemorySettlementRepository` (no tables exist) | **No** |
Reputation | `InMemoryReputationRepository` (no tables exist) | **No** |
Audit log | `InMemoryAuditRepository` | **No** |

The tables and constraints for payments, ledger, disputes, RWA, and audit are
fully designed and trigger-enforced in Postgres, but no `Pg*` repository has
been written for them yet. Highest-value next step is a Postgres payment
repository, since that is where the ledger and reconciliation invariants
actually pay off.

---

## 8. Known Inconsistencies

1. **Currency coverage gap.** `0002` seeds only USD/EUR/INR, while `0004` and
   `0006` cover USD/EUR/INR/NGN/XLM/USDC. Net effect: `platform_fees` exists
   only in the three original currencies.
2. **Dispute → escrow indirection.** `disputes.escrow_id` references `escrows`,
   but `DisputeService` is wired to look up **orders**
   (`paymentRepository.findOrder`). A Postgres-backed dispute repository will
   need to resolve order → escrow first.

---

## 9. CI Verification

`.github/workflows/ci.yml` job `database (migrations · ledger balance)` runs
against a `postgres:16` service container:

1. Apply every `infra/supabase/migrations/*.sql` in order with
   `psql -v ON_ERROR_STOP=1`
2. `infra/supabase/tests/ledger_balance_test.sql` — a balanced transaction
   commits; an unbalanced one is rejected at constraint-check time; exactly one
   transaction persists
3. `infra/supabase/tests/phase2_transition_test.sql` — a transition links one
   balanced ledger transaction to one matching Stellar transaction, and an open
   mismatch blocks lifecycle changes (rollback-only transaction)

Other jobs: `backend` (lint · typecheck · test · build, Node 24), `frontend`
(build, Node 20), `ai` (ruff · pytest, Python 3.12), `contracts` (cargo test,
`wasm32v1-none`).
