# infra

Docker images, local orchestration, database migrations, and env templates.

```
infra/
├─ docker/                 # per-portion Dockerfiles
│  ├─ backend.Dockerfile
│  ├─ ai.Dockerfile
│  └─ frontend.Dockerfile
├─ docker-compose.yml      # local dev stack (postgres, redis, backend, ai, frontend)
├─ supabase/
│  ├─ migrations/          # forward-only SQL, 0001 → 0015
│  └─ tests/               # psql smoke tests (ledger balancing, phase-2 transitions)
└─ .env.example            # local-dev env template (no secrets)
```

## Local stack

`infra/.env` is the gitignored runtime file and `infra/.env.example` is its safe
template. It carries local Postgres/Redis URLs, public testnet endpoints, auth
and KYC sandbox settings, and the reconciliation cadence. Optional Supabase
values stay commented until manually supplied.

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.yml up --build
# backend  → http://localhost:8080/health
# ai       → http://localhost:8000/health
# frontend → http://localhost:3000
```

Postgres applies `supabase/migrations/*.sql` on first boot, in filename order.

## Migrations

Forward-only, numbered, never edited after they land (`Rules.md` §2). Applying
them in order against an empty database produces the current schema.

| # | Adds |
|---|---|
| `0001` | Initial schema: users, businesses, wallets, ledger accounts/transactions/entries, orders, audit log, webhook events |
| `0002` | Seeds the internal system ledger accounts the platform posts against |
| `0003` | Phase 1 identity & wallet: KYC verifications, review queue, SEP-10 challenges |
| `0004` | Phase 2 core payment + escrow: payment transitions, linked chain metadata, reconciliation mismatches, fail-closed order blocking |
| `0005` | Persistent auth sessions and the profile verification snapshot |
| `0006` | Phase 5 RWA tokenization: assets, tokenizations, token holdings, payout records |
| `0007` | Durable dispute persistence (dispute records, evidence) |
| `0008` | On-chain escrow wiring: escrows table, contract instance and tx metadata |
| `0009` | Links a dispute to the custody it is about |
| `0010` | RWA issuer self-custody, including holding status |
| `0011` | Phase 3 durable cross-border settlement: settlements, quotes, transitions, mismatches |
| `0012` | Dispute parties (both sides of the claim) and the dispute log |
| `0013` | Phase 6 product feedback wall (`product_feedback`) |
| `0014` | **Repair** — re-applies `0011` + `0012` schema on a database where they never ran |
| `0015` | **Repair** — re-applies `0008`, `0009`, `0010` schema on a database missing them |

The two repair migrations exist because a deployed database had drifted from the
migration history. They are idempotent and safe on a database that already has
the schema; on a fresh database they are no-ops after their originals.

## Invariant tests

`supabase/tests/` holds psql smoke tests that assert database-level guarantees,
not application behaviour:

- `ledger_balance_test.sql` — the constraint that rejects an unbalanced
  double-entry transaction actually rejects one
- `phase2_transition_test.sql` — linked payment transitions and fail-closed
  blocking behave as specified

CI runs both against Postgres 16 after applying every migration.

## CI

`.github/workflows/ci.yml` runs, per portion:

- **backend** — lint · typecheck · test (257 Vitest tests, including an
  end-to-end `/health` request through supertest) · build
- **frontend** — build (Next runs lint + typecheck inline)
- **ai** — ruff · pytest (Python 3.12)
- **contracts** — `cargo test`, WASM build for `wasm32v1-none`, contract-spec
  drift check
- **database** — applies every migration, then runs the invariant tests above

## Manual infrastructure prerequisites

- Install Docker Desktop (or Postgres 16 + Redis 7 separately) to run the stack.
- Rotate and manually supply Supabase server credentials; never commit them.
- Configure a funded Stellar testnet CLI identity and install the contract WASMs.
- Configure AWS/GCP KMS or another HSM-backed signer before staging/production.

## Secrets

No secret keys anywhere in this folder or the repo. Signing goes through the
KMS/HSM boundary (`backend/src/modules/stellar/signer.ts`); the local stub uses
an ephemeral in-memory key and is forbidden in staging/production. `DEMO_MODE`
unlocks a testnet-only environment signer and is refused on the public network.
