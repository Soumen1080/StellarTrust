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

```bash
docker compose -f infra/docker-compose.yml up --build
# backend  → http://localhost:8080/health
# ai       → http://localhost:8000/health
# frontend → http://localhost:3000
```

Postgres applies `supabase/migrations/*.sql` on first boot.

## CI

`.github/workflows/ci.yml` runs, per portion:

- **backend** — lint · typecheck · test (incl. the empty end-to-end `/health`
  request) · build
- **frontend** — build (Next runs lint + typecheck)
- **ai** — ruff · pytest (Python 3.12)
- **contracts** — `cargo test` (Rust + wasm target)
- **database** — apply migrations to Postgres, then run the ledger-balance smoke
  test proving unbalanced writes are rejected at the DB level

## Secrets

No secret keys anywhere in this folder or the repo. Signing goes through the
KMS/HSM boundary (`backend/src/modules/stellar/signer.ts`); the local stub uses
an ephemeral in-memory key and is forbidden in staging/production.
