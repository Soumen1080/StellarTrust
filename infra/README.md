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
│  ├─ migrations/          # forward-only SQL (0001 schema + ledger, 0002 seed)
│  └─ tests/               # psql smoke tests (ledger balancing invariant)
└─ .env.example            # local-dev env template (no secrets)
```

## Local stack

`infra/.env` is the gitignored runtime file and `infra/.env.example` is its safe
template. It contains local Postgres/Redis URLs, public testnet endpoints, auth
and KYC sandbox settings, and the reconciliation cadence. Optional Supabase
values remain commented until manually supplied.

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.yml up --build
# backend  → http://localhost:8080/health
# ai       → http://localhost:8000/health
# frontend → http://localhost:3000
```

Postgres applies `supabase/migrations/*.sql` on first boot. Migration `0004`
adds Phase 2 payment transitions, linked chain metadata, mismatch persistence,
and fail-closed order blocking.

## CI

`.github/workflows/ci.yml` runs, per portion:

- **backend** — lint · typecheck · test (incl. the empty end-to-end `/health`
  request) · build
- **frontend** — build (Next runs lint + typecheck)
- **ai** — ruff · pytest (Python 3.12)
- **contracts** — `cargo test` (Rust + wasm target)
- **database** — apply migrations through `0004`, then run ledger-balance and
  Phase 2 linked-transition/blocking smoke tests

## Manual infrastructure prerequisites

- Install Docker Desktop (or Postgres 16 + Redis 7 separately) to run the stack.
- Rotate and manually supply Supabase server credentials; never commit them.
- Configure a funded Stellar testnet CLI identity and deploy the escrow contract.
- Configure AWS/GCP KMS or another HSM-backed signer before staging/production.
- Replace in-memory payment/idempotency stores with Postgres/Redis adapters and
  validate migration `0004` against the target Supabase project.

## Secrets

No secret keys anywhere in this folder or the repo. Signing goes through the
KMS/HSM boundary (`backend/src/modules/stellar/signer.ts`); the local stub uses
an ephemeral in-memory key and is forbidden in staging/production.
