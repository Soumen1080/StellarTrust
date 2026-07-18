# StellarTrust

AI-powered cross-border **escrow**, **liquidity settlement**, and **Real-World
Asset (RWA) tokenization** platform on the Stellar network.

> Fast, secure, transparent global commerce: cross-border payments + escrow +
> AI dispute resolution + asset tokenization, all on Stellar.

See the canonical docs at the repo root: `PRD.md`, `Architecture.md`,
`Rules.md`, `Phases.md`, `DESIGN.md`, `Memory.md`.

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

## Golden rules (see `Rules.md`)

1. The **double-entry ledger** is the source of truth. Every money movement
   writes balanced ledger entries (debits == credits) **and** a Stellar
   transaction record.
2. **No secret keys** in code, DB, env, or logs. Signing happens behind the
   KMS/HSM boundary only.
3. **AI is advisory**, human-gated above thresholds.
4. All money-mutating endpoints are **idempotent**.
5. **No unauthenticated** money/PII/escrow endpoints.

---

## Phase 0 — Foundations (current)

A safe skeleton that enforces the golden rules from day one:

- Separated portion folders (above).
- Backend: config, structured logging, error taxonomy, idempotency middleware,
  **double-entry ledger** (balanced-pair enforced), Stellar SDK wrappers, KMS
  signing boundary (local stub).
- Supabase initial schema including the double-entry ledger
  (`infra/supabase/migrations`).
- CI pipeline (lint, typecheck, test, build).

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
