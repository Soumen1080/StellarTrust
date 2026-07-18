# StellarTrust — Project Memory

> **Purpose:** Living state file for the whole project. **Read this first** at the
> start of any session, and **update it after any change.** It captures current
> status, what is being worked on, what is complicated, decisions made, and a
> changelog. This is the shared memory for humans and AI agents.
>
> **Update policy:** Every change to the codebase or docs should update the
> relevant section here (Current Focus, Decision Log, Changelog, Complications).

**Last updated:** 2026-07-18

---

## 1. Project Snapshot

- **Name:** StellarTrust
- **What:** AI-powered cross-border escrow, liquidity settlement, and RWA
  tokenization platform on Stellar.
- **Track:** Production (real product for real users).
- **Current phase:** Phase 0 — Foundations (**scaffold complete**; see §2).
- **Repo state:** Full portion scaffold in place: `frontend/`, `backend/`,
  `ai/`, `contracts/`, `shared/`, `infra/`. Backend + frontend build and test
  green locally. Canonical docs remain at repo root.

### Canonical docs
- `docs/PRD.md` — product requirements, users, features.
- `docs/Architecture.md` — architecture, flow, structure, stack, data model.
- `docs/Rules.md` — engineering rules, libraries, error handling, AI guardrails.
- `docs/Phases.md` — phased roadmap + acceptance criteria.
- `docs/Design.md` — colors, fonts, typography, UI system.
- `docs/Memory.md` — this file.

---

## 2. Current Focus

- **Currently working on:** Phase 0 — Foundations. **Scaffold complete.**
- **What was built (Phase 0):**
  - **Separated portions:** `frontend/` (Next.js), `backend/` (Express modular
    monolith), `ai/` (FastAPI), `contracts/` (Soroban/Rust), `shared/`
    (contracts of record — types/constants/validation/error codes), `infra/`
    (docker + CI + migrations). `frontend` and `backend` each have their own
    `package.json`/build/deploy.
  - **Double-entry ledger:** enforced both in the backend
    (`backend/src/modules/ledger/ledger.balance.ts`, BigInt, per-currency
    debits==credits, both sides required) and at the **database** level
    (`infra/supabase/migrations/0001_initial_schema.sql`, deferred constraint
    trigger `assert_ledger_transaction_balanced`). Unbalanced writes are
    rejected in both places.
  - **Supabase schema:** users, businesses, kyc, wallets, orders, escrows,
    disputes, dispute_evidence, ledger_accounts/transactions/entries, assets,
    tokenizations, token_holdings, stellar_transactions, webhook_events
    (replay-protected), append-only audit_log.
  - **Stellar/Soroban:** SDK wrappers (`stellar.client.ts`) + **KMS/HSM signing
    boundary** (`signer.ts`): `LocalStubSigner` (ephemeral in-memory key,
    forbidden in staging/prod), `KmsSigner` placeholder. No secret keys in
    repo/env.
  - **Cross-cutting:** typed config (Zod), structured logging with PII/secret
    redaction (pino), shared error taxonomy + boundary translation, idempotency
    middleware, auth stub (no unauthenticated money endpoints).
  - **AI service:** advisory-only `/kyc-score` + `/dispute-recommend`,
    read-only w.r.t. funds/ledger, `requires_human_review` gate.
  - **Contracts:** `escrow` (lock/release/refund/dispute) + `rwa_token`
    (issuance/transfer/pro-rata payout) with unit tests.
  - **CI:** `.github/workflows/ci.yml` — backend (lint/typecheck/test/build),
    frontend (build), ai (ruff/pytest), contracts (cargo test), database
    (migrations + ledger-balance smoke test).

- **Verification status (this environment):**
  - ✅ `backend`: lint + typecheck + build + 17 tests **pass** (includes the
    empty end-to-end `/health` request, ledger balancing, idempotency, auth).
  - ✅ `shared`: builds clean.
  - ✅ `frontend`: `next build` (lint + typecheck + build) **passes**.
  - ⚠️ `ai`: Python sources byte-compile; **pytest not run locally** — Python
    3.14 has no `pydantic-core` wheel and the source build is blocked by an OS
    Application Control policy. CI runs it on Python 3.12.
  - ⚠️ `contracts`: authored with tests; **not compiled locally** — Rust/cargo
    builds blocked by the same OS policy. CI runs `cargo test`.
  - ⚠️ DB-level ledger trigger: authored + CI smoke test; **not run locally**
    (no Postgres/psql/docker here). App-level balancing is verified.

- **Next up:** Resolve open questions (§5), then **Phase 1 — Identity & Wallet**
  (SEP-10 auth replacing the auth stub, KYC provider sandbox, AI KYC risk
  aggregation wired to the decision engine, wallet connect).

---

## 3. Key Decisions Made (Decision Log)

| # | Date | Decision | Rationale |
|---|---|---|---|
| D1 | 2026-07-18 | Production track | Real product for real users |
| D2 | 2026-07-18 | Postgres/Supabase as system of record; **no MongoDB** | ACID + double-entry ledger required |
| D3 | 2026-07-18 | Double-entry ledger is source of truth; chain is not accounting | Financial correctness + reconciliation |
| D4 | 2026-07-18 | Classic Stellar for payments/liquidity; Soroban for escrow/RWA | Right tool per capability |
| D5 | 2026-07-18 | Fiat ramp via Anchors + SEP-31/24/6/10/12 | Real cross-border settlement, not hand-waved |
| D6 | 2026-07-18 | AI is advisory, human-gated above thresholds | Legal/liability + fairness |
| D7 | 2026-07-18 | KYC/liveness via 3rd-party provider, not built in-house | Compliance + speed |
| D8 | 2026-07-18 | Modular monolith (`backend`) + separate Python AI service | Simplicity + ML ecosystem |
| D9 | 2026-07-18 | Separate top-level folders per portion (`frontend`/`backend`/`ai`/`contracts`/`shared`/`infra`); `frontend` & `backend` independently deployed with own `package.json` | Full separation of concerns; independent build/scale/deploy |
| D10 | 2026-07-18 | Secret keys only via KMS/HSM boundary | Security |
| D11 | 2026-07-18 | RWA is opt-in module, not in escrow happy path | Correct domain modeling |
| D12 | 2026-07-18 | Money amounts stored/validated as integer **minor units** (BigInt in TS, `bigint` in Postgres), never floats | Financial precision; no float drift |
| D13 | 2026-07-18 | Ledger balancing enforced **twice**: backend service (pre-persist) + Postgres deferred constraint trigger | Defense in depth on Golden Rule #1 |
| D14 | 2026-07-18 | `shared/` holds contracts only (types/constants/validation/**error codes**); runtime error **classes** live in backend | Keep shared free of runtime logic/secrets |
| D15 | 2026-07-18 | Backend test runner pinned to **vitest 3.2.4** | vitest 4.1.10 had a framework-level incompat with dotenv v17 that broke suite loading |
| D16 | 2026-07-18 | Frontend pinned to **Next.js 15.5.20** (patched backport) | 15.1.3 flagged CVE-2025-66478; stayed on 15.x to minimize churn |
| D17 | 2026-07-18 | AI service targets **Python 3.12** in CI/Docker | pydantic-core has no 3.14 wheel; avoids source build |
| D18 | 2026-07-18 | Idempotency + ledger repositories use in-memory impls behind interfaces for Phase 0 | Swap to Redis/Postgres in later phases without changing call sites |

---

## 4. Complications & Risks (what's hard)

| Area | Complication | Status / Mitigation |
|---|---|---|
| Fiat on/off ramp | Needs regulated anchors per corridor; not trivial | Use SEP-31/24; start with controlled/sandbox anchor |
| Custody | Escrow fund custody model must be trustless/defensible | Soroban escrow contract; confirm hybrid needs |
| AI liability | Autonomous money decisions are risky | Advisory + human gate + audit log |
| Reconciliation | Ledger ↔ chain drift | Scheduled reconciliation job; block on mismatch |
| Licensing | Money-transmitter/MSB needed for real money | Track before mainnet go-live (Phase 6) |
| Key management | Secret key handling | KMS/HSM; signer boundary |
| Path payment liquidity | Thin corridors → slippage | Fee/slippage constraints in routing |

---

## 5. Open Questions (need answers before/during Phase 0–3)

1. Launch corridors? (e.g., USD↔INR, USD↔EUR)
2. Anchor partner(s) per corridor?
3. Custody: Soroban-only escrow, or hybrid custodial for some flows?
4. Auto-resolve thresholds: `AUTO_RESOLVE_MAX_AMOUNT`,
   `AUTO_RESOLVE_MIN_CONFIDENCE`?
5. Which KYC provider (Sumsub / Onfido / Persona / Veriff)?
6. Target cloud (AWS / GCP) for KMS + hosting?

---

## 6. Environment / Toolchain Notes

- OS: Windows (dev machine).
- Verified present: Node v24.18.0, npm 11.16.0, Python 3.14.6, git 2.55.0.
- **Not usable on this dev machine:** Rust/cargo builds and Python native
  (Rust-backed) wheel builds are **blocked by an OS Application Control policy**
  (`os error 4551`). Consequences: `ai` pytest and `contracts` cargo test can't
  run locally — they run in CI instead (Python 3.12 / Rust toolchain).
- No Docker/psql locally → DB-level migration + ledger trigger verified via CI,
  not locally.
- No secrets committed. KMS/HSM not yet configured (local stub signer only).

---

## 7. Changelog

| Date | Change |
|---|---|
| 2026-07-18 | Authored initial docs: PRD, Architecture, Rules, Phases, Design, Memory. |
| 2026-07-18 | Locked production-track decisions D1–D11 (see Decision Log). |
| 2026-07-18 | Restructured to fully separate top-level folders per portion: `frontend/`, `backend/`, `ai/`, `contracts/`, `shared/`, `infra/`. `frontend` & `backend` are independent projects (own `package.json`/build/deploy). Updated Architecture, Rules, Phases, Design accordingly (D9). |
| 2026-07-18 | **Phase 0 scaffold implemented.** Built all six portions + root README/.gitignore. `shared` contracts package; `backend` modular monolith (config, logging, error taxonomy, idempotency + auth middleware, double-entry ledger with balancing enforcement, Stellar wrappers, KMS signing boundary, `/health`); Supabase migrations incl. ledger tables + balancing trigger + seed; `ai` FastAPI advisory service; `contracts` Soroban escrow + rwa_token; `frontend` Next.js + Tailwind design tokens; `infra` Dockerfiles + docker-compose + CI. Verified locally: backend lint/typecheck/test(17)/build green, shared build green, frontend build green. Decisions D12–D18 recorded. |

---

## 8. How To Use This File (for AI agents & contributors)

1. **On session start:** read this file + `docs/Rules.md` before acting.
2. **Before coding:** confirm current phase + focus here.
3. **After any change:** update Section 2 (Current Focus), add to Changelog,
   record new decisions (Section 3) and complications (Section 4).
4. **When a file becomes the active work item:** note it in "File(s) in
   progress."
5. Keep entries concise and factual. This file is the project's memory.
