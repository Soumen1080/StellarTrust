# StellarTrust

AI-powered cross-border **escrow**, **liquidity settlement**, and **Real-World
Asset (RWA) tokenization** platform on the Stellar network.

> Fast, secure, transparent global commerce: cross-border payments + escrow +
> AI dispute resolution + asset tokenization, all on Stellar.

See the canonical docs in [`docs/`](docs/): [`PRD.md`](docs/PRD.md),
[`Architecture.md`](docs/Architecture.md), [`Rules.md`](docs/Rules.md),
[`Phases.md`](docs/Phases.md), [`DESIGN.md`](docs/DESIGN.md),
[`Memory.md`](docs/Memory.md).

---

## Repository layout (separation of portions)

Every portion is a **self-contained top-level folder** with its own
dependencies, config, and tests. Portions communicate only over defined
interfaces (REST + shared type contracts) — never by reaching into each other's
internals.

| Folder | Portion | Toolchain |
|---|---|---|
| `frontend/` | Next.js dashboards + transactional UI | Node / TS / Tailwind |
| `backend/`  | Modular-monolith API (Express) | Node / TS |
| `ai/`       | AI Risk Service (advisory only) | Python / FastAPI |
| `contracts/`| Soroban escrow + RWA token | Rust |
| `shared/`   | Cross-portion contracts (types/constants/validation/error codes) | TS |
| `infra/`    | docker-compose, CI, env templates | — |

`frontend/` and `backend/` are **independently deployed** projects with their
own `package.json`, build, and env. `shared/` is the only code both may import,
and it holds **contracts only** — no runtime logic, no secrets.

---

## Golden rules (see [`docs/Rules.md`](docs/Rules.md))

1. The **double-entry ledger** is the source of truth. Every money movement
   writes balanced ledger entries (debits == credits) **and** a Stellar
   transaction record.
2. **No secret keys** in code, DB, env, or logs. Signing happens behind the
   KMS/HSM boundary only.
3. **AI is advisory**, human-gated above thresholds.
4. All money-mutating endpoints are **idempotent**.
5. **No unauthenticated** money/PII/escrow endpoints.

---

## Current status — Phase 2 application complete

Phase 0 foundations and the Phase 1 identity/wallet application are present.
Phase 2 now includes:

- Authenticated/idempotent `create → accept → deposit → lock → confirm → release`
  APIs under `/api/payments/orders` plus an arbiter-only refund path.
- Balanced ledger postings, linked chain records, and append-only audit metadata
  for each transition.
- A scheduled ledger↔chain reconciliation job that reports mismatches and blocks
  dependent operations.
- Soroban escrow buyer confirmation + lock/release/refund authorization tests.
- Postgres migration `0004_phase2_core_payment_escrow.sql` and `/escrow` UI.

The default runtime still uses in-memory repositories and a deterministic local
Soroban boundary. Public-testnet deployment, production Postgres/Redis adapters,
and KMS/HSM signing are intentionally not claimed as complete; see [`docs/Phases.md`](docs/Phases.md).

### Local environment

`infra/.env` is the gitignored local stack configuration. Safe defaults are
already present. To recreate it, copy `infra/.env.example` and keep real values
out of source control. Start the full stack with:

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.yml up --build
```

Docker is required for this command. Without Docker, run each portion directly
using its own environment file.

### Phase 2 API

All mutations require `Authorization: Bearer …` and `Idempotency-Key` headers.

```text
POST /api/payments/orders
GET  /api/payments/orders
GET  /api/payments/orders/:orderId
POST /api/payments/orders/:orderId/{accept|deposit|lock|confirm|release|refund}
POST /api/payments/reconciliation/run   # compliance role
```

### Quick start (backend)

```bash
cd backend
npm install
cp .env.example .env      # no secrets — references only
npm run build
npm test                  # ledger balancing + health e2e
npm run dev               # starts API on http://localhost:8080
curl http://localhost:8080/health
```

### Quick start (AI service)

```bash
cd ai
python -m venv .venv && . .venv/Scripts/activate   # Windows
pip install -e .[dev]
uvicorn app.main:app --reload --port 8000
```

### Contracts (Soroban)

Requires the Rust toolchain + `stellar` CLI. See `contracts/README.md`.
