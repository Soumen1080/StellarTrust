# StellarTrust — Development Log, Issue Register & Production Plan

> **Purpose:** This is the working development file. It records the **real,
> verified state** of the codebase, every **issue / problem / structural gap**
> found during the audit, the **current build strategy** (frontend + backend
> first), the **temporary development shortcuts** we are intentionally using,
> and the **plan to reach a production-level platform**.
>
> **Read this together with:** `Memory.md` (project memory), `Rules.md`
> (golden rules), `Phases.md` (roadmap), `Architecture.md` (target design).
>
> **Last updated:** 2026-08-18
> **Audit basis:** re-verified against the repository tree, `package.json`
> files, and a full local run of `cargo test`, `vitest run`, `tsc`, `eslint`,
> and `next build` on this date. The 2026-07-22 audit that opened this file is
> preserved below as history; **most of its blockers are now resolved** and each
> is marked with what closed it.

---

## 0. TL;DR — Where we actually are

| Layer | Code exists | Builds/tests | Verified against a real network | Blocker |
|---|---|---|---|---|
| Frontend (Next.js) | ✅ | ✅ typecheck + lint + build, 10 app routes | ⚠️ needs a reachable backend | — |
| Backend (Express) | ✅ | ✅ **102 tests pass**, 13 files | ⚠️ | Redis; KMS for real money |
| Auth (SEP-10) | ✅ | ✅ | ⚠️ works via `DEMO_MODE` testnet signer | `KmsSigner` unimplemented |
| Persistence (DB) | ✅ 6 Postgres repos | ⚠️ code only | ❌ migrations never executed | provision + run `0001`–`0008` |
| Escrow contract | ✅ Rust, on-chain path wired | ✅ **9 tests pass locally** | ❌ not deployed | funded testnet identity |
| RWA contract | ✅ Rust + real gateway | ✅ **18 tests pass locally** | ❌ not deployed | funded testnet identity + 3 gaps (§2 I) |
| AI service | ✅ FastAPI | ⚠️ CI-only (pytest blocked here) | ❌ not deployed | not hosted; engines are placeholders |

**One-line status:** The code now has a **complete, tested path from the UI to
the Soroban contracts**, and the money-critical repositories are Postgres-backed.
Nothing has yet been executed against a real Stellar network or a real database,
so every on-chain and persistence claim is *implemented and unit-covered*, not
*proven*.

**What changed since the original audit:** the three stacked structural gaps
that made the demo non-functional (auth can't sign → state doesn't persist →
chain isn't reachable) have each been addressed in code. What is left is
provisioning, not architecture.

---

## 1. Current Build Strategy

1. **Ship the operational prerequisites next, not more features.** The highest-
   value work is now: run the migrations against a real Postgres, fund a testnet
   identity, deploy both contracts, and set `ESCROW_WASM_HASH`,
   `RWA_WASM_HASH`, `STELLAR_TOKEN_CONTRACTS`.
2. **The chain path is real but unproven.** `ESCROW_GATEWAY=soroban-rpc` and
   `RWA_GATEWAY=soroban-rpc` are fully implemented. Keep `deterministic` as the
   local/test default — it now mirrors the contract's rules exactly, including
   the ones it used to get wrong.
3. **AI engine remains stubbed.** The KYC risk client and dispute engine fall
   back to a deterministic local decision; no external AI call is required to
   complete a flow.
4. **KYC auto-verifies after ~10 seconds** in development (§6), flag-gated and
   impossible in production.

> Items 3–4 are **development shortcuts**, tracked in §7 so they are never
> mistaken for production behavior.

---

## 2. Issue Register

Severity: 🔴 blocker · 🟠 major · 🟡 minor / hygiene
Status: ✅ resolved · 🔧 partially resolved · ⬜ still open

### Status summary (2026-08-18)

| ID | Issue | Status |
|---|---|---|
| A1 | Wallet auth 500 in production (no signer) | 🔧 `DemoEnvSigner` unblocks testnet; `KmsSigner` still throws |
| A2 | Everything in-memory | 🔧 identity/auth/audit/payments/disputes/rwa on Postgres; kyc/reputation/settlement/idempotency still in-memory |
| A3 | Serverless host vs long-lived scheduler | ⬜ open — pick a persistent host |
| A4 | Two conflicting serverless entrypoints | ✅ only `backend/api/index.ts` remains; no root `vercel.json` |
| A5 | Hardcoded env values in source | 🔧 `FRONTEND_ORIGINS` still defaults to a specific Vercel URL; `frontend/src/lib/api.ts` still defaults to a Render URL |
| B1 | Exposed Supabase secret | ⬜ **open — must still be rotated** |
| B2 | No real signing boundary | ⬜ open — `KmsSigner` unimplemented |
| B3 | Single global rate limiter | ⬜ open |
| C1 | Postgres repositories unimplemented | 🔧 six exist; kyc/reputation/settlement do not |
| C2 | No Redis idempotency / job state | ⬜ open — Golden Rule #4 is not enforced across instances |
| C3 | Migrations never validated | ⬜ open — `0001`–`0008` have still never been executed |
| D1 | Contract not deployed to testnet | ⬜ open — needs a funded identity |
| D2 | No `SorobanRpcEscrowGateway` | ✅ implemented, with prepare/sign/submit and read-back |
| D3 | Contract tests Windows-blocked | ✅ **wrong** — `cargo test` runs here; all 27 pass |
| E1 | AI service not deployed/wired | ⬜ open |
| E2 | Engines are placeholder heuristics | ⬜ open (acceptable for now — keep them labeled) |
| F1 | Frontend can't complete a flow | 🔧 unblocked locally and on a `DEMO_MODE` testnet deploy |
| F2 | Very dense single-line JSX | ⬜ open — `KycOnboarding.tsx`, `EscrowDashboard.tsx` |
| F3 | Session in `sessionStorage` only | ✅ intentional (D27) |
| G1 | Scratch file `awsedrfgyhuji.md` | ✅ deleted |
| G2 | Docs overstate completeness | ✅ addressed by the 2026-08-18 docs pass |
| G3 | `frontend/` outside the root workspace | ✅ intentional (D9) |
| G4 | Empty dirs / duplicate entrypoints | ✅ `backend/scripts/` and the duplicate entrypoint are gone |
| H1 | Golden rules unenforceable at runtime | 🔧 see C2 — idempotency is the remaining hole |
| I1 | RWA payouts write no ledger entries | ✅ fixed — posts through `LedgerService`, idempotent by cause-derived reference |
| I2 | Contract double-payout guard inert | ✅ fixed — `markDistributed` + `getContractMeta` engaged (ledger posts first) |
| I3 | DB user ids passed as Stellar `Address` | ✅ fixed — `WalletAddressResolver` + StrKey validation |

### I. RWA gaps (found 2026-08-18, **all three fixed the same day** — §13)

> Kept in full because the *shape* of these bugs is instructive: each was
> invisible to the type system and to a green test suite.

- 🔴 **I1 — RWA payouts write no ledger entries.**
  `RwaService.distributePayout` builds a balanced `LedgerTransactionInput` and
  discards it (`void this.createPayoutLedger(...)` — the method is synchronous
  and its return value is dropped), then records a `ledgerTransactionId` from
  `randomUUID()` that references no row. This is a direct violation of Golden
  Rule #1 for every RWA payout.

- 🟠 **I2 — The contract's double-payout guard is inert.**
  `markDistributed` and `getPayoutShares` are implemented on the gateway but
  have **zero** non-test callers. Shares are computed off-chain and the
  contract's `distributed` flag is never set.

- 🟠 **I3 — DB user ids are passed where the contract expects an `Address`.**
  `issuerAddress: actor.userId` and `from: tokenization.issuerUserId`. The
  Soroban gateway silently substitutes the signer's address, so the
  deterministic adapter keys balances by UUID while the real one keys by `G…`.
  `EscrowAddressResolver` already solves this for escrow and should be reused.

---

## 2b. Original audit detail (2026-07-22)

Kept for provenance. Read it with the status table above.

### A. Deployment & runtime architecture

- 🔴 **A1 — Wallet auth returns HTTP 500 in production.**
  `Sep10Service.createChallenge()` calls `signer.getPublicKey()` and
  `signer.signTransactionXdr()`. In staging/production with
  `SIGNER_PROVIDER=local-stub`, `createSigner()` returns `UnavailableSigner`,
  which throws `ExternalServiceError`. Since auth gates the whole app, the
  entire product is unusable when deployed. This is the top blocker.
  *(File: `backend/src/modules/stellar/signer.ts`, `.../auth/sep10.service.ts`.)*

- 🔴 **A2 — Everything is in-memory; nothing persists.**
  `app.ts` wires `InMemoryIdentityRepository`, `InMemoryAuthRepository`,
  `InMemoryKycRepository`, `InMemoryPaymentRepository`,
  `InMemoryAuditRepository`, and an in-memory idempotency store. On a serverless
  host (Vercel), each cold start / instance gets a fresh empty store, so:
  sessions vanish, orders disappear, and a challenge issued by one instance can
  be verified by another that never saw it. No flow can be trusted across
  requests.

- 🟠 **A3 — Backend deployed as serverless, but it expects a long-lived process.**
  `backend/src/index.ts` starts the `ReconciliationJob` scheduler and handles
  `SIGINT/SIGTERM`. The serverless entrypoints (`api/index.ts`,
  `backend/api/index.ts`) only call `createApp()` — the reconciliation scheduler
  **never starts** in the deployed path. A scheduler + in-memory job state does
  not fit the serverless model; it needs a persistent worker.

- 🟠 **A4 — Two conflicting serverless entrypoints.**
  Both `./api/index.ts` (imports `../backend/src/app.js`) and
  `./backend/api/index.ts` (imports `../src/app.js`) exist and export
  `createApp()`. The root `vercel.json` rewrites `/(.*) → /api`. It is ambiguous
  which project/entrypoint actually deploys the backend, and the root workspace
  builds both `shared` and `backend`. This needs one clear deployment topology.

- 🟡 **A5 — Hardcoded environment values in source.**
  `config/index.ts` defaults `FRONTEND_ORIGINS` to a specific personal Vercel
  URL, and `frontend/src/lib/api.ts` defaults production API base to
  `https://stellar-trust-backend.vercel.app`. These belong in env vars, not code.

### B. Security

- 🔴 **B1 — Previously exposed Supabase secret must be rotated.**
  Flagged repeatedly in `Memory.md`. Until rotated and moved to a secret
  manager, any Supabase integration is compromised. Do not enable Supabase until
  this is done.

- 🟠 **B2 — No real signing boundary.** `KmsSigner` is a stub that throws. There
  is no AWS/GCP KMS implementation, so there is no compliant way to sign in a
  real environment (ties into A1).

- 🟡 **B3 — Network-exposed endpoints are correct on auth, but rate limiting is
  a single global limiter.** Money/auth endpoints should have their own stricter
  limits (Rules.md §7). Minor for now, real before production.

### C. Persistence & data model

- 🔴 **C1 — Postgres repositories are unimplemented.** Migrations `0001`–`0004`
  define the schema (ledger, identity, KYC, payments, reconciliation, RLS,
  balancing trigger), but **no repository actually talks to Postgres**. Every
  `*Repository` is an `InMemory*` class. The system of record does not exist at
  runtime.

- 🟠 **C2 — No Redis-backed idempotency / job state.** `InMemoryIdempotencyStore`
  cannot dedupe across instances, so the "all mutations idempotent" golden rule
  is not actually enforced in a deployed multi-instance environment.

- 🟠 **C3 — Migrations never validated locally.** No Docker/psql on the dev
  machine, so `0001`–`0004` have only ever been read, not run. CI is claimed as
  authoritative but the DB path is unproven end-to-end.

### D. Smart contracts (deferred this phase)

- 🟠 **D1 — Contract not deployed to testnet.** `Phases.md` Phase 2 leaves the
  deploy + smoke-flow checkbox unchecked. No public contract ID exists.

- 🟠 **D2 — No `SorobanRpcEscrowGateway`.** Only `DeterministicEscrowGateway`
  exists, and `createEscrowGateway()` throws if `ESCROW_GATEWAY=soroban-rpc`.
  There is no real chain path.

- 🟡 **D3 — Contract tests are Windows-blocked.** `cargo test` fails inside
  Soroban macro deps on this machine; only CI/Linux can validate them.

### E. AI service (deferred this phase)

- 🟠 **E1 — AI service is not deployed and not wired.** `HttpKycRiskClient`
  points at `AI_SERVICE_URL` (default `localhost:8000`). In a deployed backend
  this call fails and (correctly) falls back to human review — but with
  auto-verify (§6) we bypass this entirely for now.

- 🟡 **E2 — Engines are placeholder heuristics.** `aggregate_kyc_risk` and
  `recommend_dispute` are simple weighted rules, explicitly labeled as
  placeholders. Fine for now; real models are a later phase.

### F. Frontend

- 🟠 **F1 — Frontend cannot complete any flow because backend auth fails (A1).**
  UI loads, health check passes, CORS is correct, but wallet sign-in dies at the
  SEP-10 challenge. Everything downstream (KYC, escrow, dashboard) is gated on a
  session it can never obtain in the deployed environment.

- 🟡 **F2 — Very dense single-line JSX.** `KycOnboarding.tsx` (and others) pack
  entire forms onto single lines. It builds, but it is hard to maintain and
  review. Candidate for cleanup during the frontend pass.

- 🟡 **F3 — Session in `sessionStorage` only.** Intentional (D27) but means a
  page refresh in a new tab logs the user out. Acceptable; noted.

### G. Repository structure & planning hygiene

- 🟠 **G1 — Scratch/junk file in repo root: `awsedrfgyhuji.md`.** Contains a
  previous agent's ad-hoc "verdict" notes. Its content is folded into this file
  (§3) and it should be deleted.

- 🟡 **G2 — Docs claim "Phase 2 complete" while the deployed product is
  non-functional.** `README.md` / `PRD.md` / `Memory.md` describe application
  completeness accurately, but a casual reader would assume a working product.
  This file is the corrective "ground truth" record.

- 🟡 **G3 — `frontend/` is not in the root npm workspace** (`package.json`
  workspaces = `shared`, `backend` only). Intentional per the separation
  principle, but it means there is no single root command to build the whole
  product; deployment topology must be explicit (see A4).

- 🟡 **G4 — Empty/near-empty dirs** (`backend/scripts/`) and duplicated
  `api/index.ts` files add noise. Clean up as part of the structure pass.

### H. Cross-cutting correctness

- 🟠 **H1 — Golden rules partially unenforceable at runtime.** Rules require
  idempotency, ledger-as-source-of-truth, reconciliation blocking, and audit
  logging. All are implemented **in code**, but because persistence is in-memory
  and the scheduler doesn't run in serverless, they are not actually guaranteed
  in the deployed environment.

---

## 3. Prior review notes (folded in from `awsedrfgyhuji.md`)

A previous review reached the same core conclusion and listed the remaining
work. Summarized (the original scratch file should be deleted):

- Do **not** present the current deployment as a working product demo — only as
  a UI/infra preview. The page loads and `/health` works, but a live SEP-10
  request returns **HTTP 500**.
- To make it real: implement the KMS signer + SEP-10 config; provision Postgres
  and implement real repositories (replace all `InMemory*`); provision Redis for
  idempotency/job state; deploy + wire the Soroban contract and replace the
  deterministic gateway; host the backend on a **persistent** runtime (Railway /
  Render / Fly.io / ECS / Cloud Run) so the reconciliation scheduler can run;
  deploy the AI service and set `AI_SERVICE_URL`; move all secrets into the host
  secret manager and rotate the exposed Supabase secret.
- Validation already passing: backend lint/typecheck/build, 29/29 backend tests,
  frontend build, 9/9 contract tests (CI), AI compile + Ruff. Failing/missing:
  live SEP-10, live DB persistence, live Soroban.

---

## 4. Root-cause analysis of the "demo doesn't work"

The failure is not one bug; it is three structural gaps stacked on top of each
other, in dependency order:

1. **Auth can't sign** (A1/B2) → no session token is ever issued.
2. Even if it could, **state doesn't persist** (A2/C1/C2) → sessions/orders
   evaporate between serverless requests.
3. Even with persistence, **the chain and AI dependencies aren't deployed**
   (D1/D2/E1) → money/escrow steps can't reach a real backend.

Fixing them out of order gives no visible progress. The plan in §5 fixes them in
the order that yields a working flow the earliest, while honoring the "frontend
+ backend first" decision.

---

## 5. Plan to production-level (structured, phased)

### Stage 1 — Make frontend + backend work end-to-end (current focus)

Goal: a real, clickable flow in a deployed environment, using stubs for chain +
AI and the 10-second KYC shortcut.

1. **Choose a persistent backend host** (Railway / Render / Fly.io). Serverless
   is the wrong shape for this backend (A3). Frontend stays on Vercel.
2. **Fix deployment topology** (A4): keep exactly one backend entrypoint. Remove
   the redundant one. Document the deploy in `infra/`.
3. **Provision Postgres + Redis** and implement the real repositories to replace
   every `InMemory*` (C1/C2). Start with auth + identity + KYC + payments +
   ledger + audit. Validate migrations `0001`–`0004` against the real DB (C3).
4. **Make auth work without KMS, safely** (A1). Options, in order of preference
   for this dev phase:
   - **(chosen)** Introduce a **testnet-only demo signer** that loads a Stellar
     secret from the host secret manager (not from code/repo), used *only* when
     `STELLAR_NETWORK=testnet` and an explicit `DEMO_MODE=true` flag is set.
     Keeps SEP-10 real, unblocks the flow, and is fenced off from production.
   - Alternative: implement the real `KmsSigner` now (bigger lift; this is the
     production path in Stage 3 regardless).
5. **Implement the 10-second auto-verify KYC** (see §6).
6. **Keep the deterministic escrow gateway** as the runtime path (already
   correct for dev), and **skip the external AI call** (deterministic fallback).
7. **Environment hygiene** (A5): move hardcoded origins/URLs to env vars.
8. **Repo cleanup** (G1/G4): delete `awsedrfgyhuji.md`, remove the duplicate
   entrypoint and empty dirs.

**Exit criteria for Stage 1:** From the deployed frontend a user can connect a
testnet wallet, sign in (SEP-10), submit KYC and become Verified after ~10s,
create and accept an order, run the escrow lifecycle through the deterministic
gateway, and see it all on the dashboard — and the data survives a backend
restart (because it's in Postgres/Redis now).

### Stage 2 — Reconciliation & correctness on the persistent runtime

- Run the reconciliation scheduler as a real worker (A3).
- Enforce idempotency via Redis across instances (C2).
- Prove balanced-ledger + zero-mismatch reconciliation against real Postgres.

### Stage 3 — Real signing, real chain

- ✅ `SorobanRpcEscrowGateway` implemented (2026-08-18), including the
  prepare → wallet sign → submit round trip the contract's `require_auth()`
  demands, and read-back verification before any ledger posting.
- ⬜ Implement `KmsSigner` (AWS/GCP KMS) and retire the demo signer (B2/A1).
- ⬜ Deploy the escrow contract to testnet and run the real lock→release flow
  (D1). Note the config takes a **WASM hash**, not a contract id: the backend
  deploys one custody instance per order.

### Stage 4 — Real AI + disputes

- Deploy the FastAPI AI service; wire `HttpKycRiskClient`/dispute engine; remove
  the auto-verify shortcut (E1/E2, and reverse §6).

### Stage 5 — Hardening for mainnet

- Rotate/secret-manage all credentials (B1), per-route rate limits (B3), RLS
  validation, security audit of contracts, observability, licensing — per
  `Phases.md` Phase 6.

---

## 6. Temporary design: KYC auto-verify after 10 seconds

**Intent:** during development, submitting KYC should smoothly lead to a
Verified profile without a manual compliance approval or a working AI service,
so escrow/dashboard flows are reachable.

**Guardrails (must hold):**
- Only active when `NODE_ENV !== "production"` **and** an explicit flag
  `KYC_AUTO_APPROVE=true` is set. Production must never auto-approve.
- Audit log records that approval was automatic and development-only.
- The decision engine and human-review queue remain in the code path so the
  shortcut can be removed by flipping one flag.

**Recommended implementation (persistence-friendly):**
- Add config: `KYC_AUTO_APPROVE` (bool) and `KYC_AUTO_APPROVE_DELAY_MS`
  (default `10000`).
- On `KycService.submit`, when auto-approve is on: set status to
  `UnderReview`, and stamp `autoApproveAt = now + delay` on the verification
  record. Do **not** rely on `setTimeout` (it won't survive a serverless/worker
  restart).
- On any read of identity/verification (`/api/auth/me`, KYC status), if
  `autoApproveAt` has passed and status is still `UnderReview`, transition it to
  `Verified` (and update the profile + audit). This is stateless and correct
  even across restarts.
- Frontend: after submit, show a "Verifying… (~10s)" state and poll
  `/api/auth/me` (or the verification) every ~2s until `Verified`, then route to
  `/dashboard`. `KycOnboarding.tsx` already refreshes the profile on submit; it
  needs a short poll loop.

**Reversal:** set `KYC_AUTO_APPROVE=false`. The real path (provider → AI risk →
decision engine → human review) is already implemented and takes over.

> **Note:** this requires the persistence work in Stage 1 to be meaningful; with
> in-memory stores the polled read may hit a different instance. Auto-verify and
> Postgres go in together.

---

## 7. Development shortcuts currently in effect (must reverse before production)

| # | Shortcut | Status | Reverse by | Issue |
|---|---|---|---|---|
| S1 | Deterministic escrow gateway is the default | 🔧 the real gateway now exists and is tested; `deterministic` stays the local/test default | Deploy the contract, set `ESCROW_GATEWAY=soroban-rpc` + `ESCROW_WASM_HASH` + `STELLAR_TOKEN_CONTRACTS` | D1 |
| S2 | AI risk/dispute call skipped (deterministic fallback) | ⬜ in effect | Deploy AI service, wire client | E1 |
| S3 | KYC auto-verify after 10s | ⬜ in effect | `KYC_AUTO_APPROVE=false` | §6 |
| S4 | Testnet demo signer instead of KMS | ⬜ in effect | Implement `KmsSigner`, remove the demo signer | A1/B2 |
| S5 | In-memory stores | 🔧 six repos on Postgres; kyc/reputation/settlement and **all idempotency stores** remain in memory | Write the rest; Redis for idempotency | A2/C1/C2 |
| S6 | OpenAI configured but bypassed by auto-approve | ⬜ in effect | Disable S3 | §11 |

> S5's idempotency half is the one with teeth: `InMemoryIdempotencyStore` cannot
> dedupe across processes, so a multi-instance deployment does not actually
> satisfy Golden Rule #4. Until Redis lands, run a **single** instance.

---

## 8. Immediate next actions (ordered)

Code, in dependency order:

1. ~~Fix the three RWA gaps (I1–I3).~~ ✅ done — see §13.
2. **Redis-backed idempotency store** (C2) — this is what makes Golden Rule #4
   true rather than aspirational in a real deployment. Highest-value item left.
3. **Postgres repositories for kyc, reputation, settlement** (C1 remainder), and
   a forward-only settlement schema.
4. **Include `*.test.ts` in the typecheck.** `backend/tsconfig.json` excludes
   them, so a constructor signature change compiled clean and only failed at
   runtime. Cheap fix, real safety.
5. **Move the remaining hardcoded origins/URLs to env** (A5).
6. **Implement `KmsSigner`** (B2) — the gate on any real-money path.

Operational, and blocking all on-chain verification:

6. **Provision Postgres and run migrations `0001`–`0008`** (C3). Every
   persistence claim is unverified until this happens.
7. **Fund a Stellar testnet identity**, run
   `contracts/scripts/deploy-testnet.ps1`, and set `ESCROW_WASM_HASH` /
   `RWA_WASM_HASH`.
8. **Bind a token per currency** (`STELLAR_TOKEN_CONTRACTS`) and give the test
   buyer a balance + trustline in it — `initialize` transfers *from the buyer*,
   so without this the first lock fails no matter how correct the code is.
9. **Choose a persistent backend host** (A3) so the reconciliation scheduler
   actually runs. Document it in `infra/`.
10. **Rotate the exposed Supabase secret** (B1).

---

## 9. Changelog (this file)

| Date | Change |
|---|---|
| 2026-07-22 | Created development log. Full codebase audit: catalogued 25+ issues across deployment, security, persistence, contracts, AI, frontend, and repo hygiene. Root-caused the "demo doesn't work" (auth signer + in-memory state + undeployed chain/AI). Recorded current strategy (frontend+backend first; stub contract+AI; 10s KYC auto-verify) and a 5-stage plan to production. Folded in and marked for deletion the `awsedrfgyhuji.md` scratch notes. |


---

## 10. Implementation Log — Stage 1, batch 1 (2026-07-22)

This batch delivers the **code-only** parts of Stage 1 that unblock the
frontend + backend flow and are testable without provisioning infrastructure:
the **testnet demo signer**, the **10-second KYC auto-verify**, and **config
hygiene**. The persistence swap (Postgres/Redis) and host migration are the next
batch and require you to provision those services.

### 10.1 What changed (file by file)

**Shared contracts (`shared/`)**
- `src/types/index.ts`
  - Added optional `autoApproveAt?: string | null` to `KycApplicationResponse`
    (the ISO time at which a development submission auto-verifies).
  - Added new `KycStatusResponse { status, verification }` DTO for the polling
    endpoint.

**Backend config (`backend/src/config/index.ts`)**
- Added dev/demo flags, all env-driven and validated:
  - `DEMO_MODE` (bool) — unlocks the stable testnet demo signer.
  - `DEMO_SIGNER_SECRET` (Stellar `S…` seed, optional, testnet only) — provided
    via the host secret manager, never committed.
  - `KYC_AUTO_APPROVE` (bool) — enables the 10s auto-verify shortcut.
  - `KYC_AUTO_APPROVE_DELAY_MS` (default `10000`).
- Removed the hardcoded personal Vercel URL from the `FRONTEND_ORIGINS`
  default; it is now purely env-driven and defaults to empty (issue A5).

**Signer boundary (`backend/src/modules/stellar/signer.ts`)**
- Added `DemoEnvSigner`: loads a Stellar secret seed from the environment so the
  server's SEP-10 signing key is **stable across serverless instances /
  restarts** (the old `LocalStubSigner` generates a new random key per process,
  which breaks SEP-10 when the challenge and verify calls hit different
  instances). Fixes the immediate cause behind A1 for deployed **testnet demos**.
- `createSigner()` now returns `DemoEnvSigner` when `DEMO_MODE=true`,
  `DEMO_SIGNER_SECRET` is set, and `STELLAR_NETWORK=testnet` — even in
  staging/production `NODE_ENV`. On the public network it refuses (returns
  `UnavailableSigner`). Local dev still uses `LocalStubSigner`; real production
  still requires `KmsSigner` (unchanged).

**KYC service (`backend/src/modules/kyc/kyc.service.ts`)**
- Added `KycServiceOptions { autoApprove, autoApproveDelayMs }` (constructor arg,
  optional/defaulted so existing tests are unaffected).
- `submit()`: when auto-approve is on, it **skips the external AI call** entirely
  (no 3s timeout wait, no dependency on a deployed AI service), sets status to
  `under_review`, and stamps `autoApproveAt = now + delay`. The real
  provider → AI → decision-engine → human-review path is fully preserved in the
  `else` branch and audit logging is unchanged in meaning (audit action still
  reflects the **policy** decision, not the advisory).
- Added `getStatus(userId)` and a private `maybeAutoApprove(userId)` that
  **resolves the timer lazily on read** — no `setTimeout`, so it survives
  process/instance restarts. When the stamped time has passed it flips the
  verification + profile to `verified` and writes a `kyc.auto_verified` audit
  event tagged development-only.

**KYC routes (`backend/src/modules/kyc/kyc.routes.ts`)**
- Added `GET /api/kyc/status` (authenticated) → returns `KycStatusResponse` and
  triggers `maybeAutoApprove`. This is what the frontend polls.

**App wiring (`backend/src/app.ts`)**
- Passes `{ autoApprove: config.KYC_AUTO_APPROVE && !config.isProduction,
  autoApproveDelayMs: config.KYC_AUTO_APPROVE_DELAY_MS }` into `KycService`.
  **Auto-approve can never be active in production**, regardless of the flag.

**Frontend API client (`frontend/src/lib/api.ts`)**
- Added `api.kycStatus(accessToken)` → `GET /api/kyc/status`.

**Frontend onboarding (`frontend/src/features/kyc/KycOnboarding.tsx`)**
- After a submission that is pending auto-verify, it polls `api.kycStatus` every
  2s; when `verified` it refreshes the identity and routes to `/dashboard`.
- Added a "Verifying automatically… redirecting when complete" indicator on the
  result panel while the timer is pending.

**Env template (`backend/.env.example`)**
- Documented `DEMO_MODE`, `DEMO_SIGNER_SECRET`, `KYC_AUTO_APPROVE`,
  `KYC_AUTO_APPROVE_DELAY_MS`, and the now-empty `FRONTEND_ORIGINS` default.

**Repo hygiene**
- Deleted the scratch file `awsedrfgyhuji.md` (content preserved in §3).

### 10.2 Verification performed

- `shared`: `tsc` build passes.
- `backend`: `typecheck` passes; `vitest run` → **29/29 tests pass** (fixed a
  transient failure where the decision audit action had to keep reflecting the
  policy decision, not the advisory decision).
- `frontend`: `tsc --noEmit` passes against the rebuilt shared types.
- Runtime boot: backend starts with `KYC_AUTO_APPROVE=true`; `/health` → 200.
- Auto-verify end-to-end (in-memory smoke, then removed): `submit` →
  `under_review` with `autoApproveAt`; immediate read stays `under_review`;
  after the delay a read returns `verified`. **SMOKE PASS.**

### 10.3 How to run the smooth dev flow now

Backend (`backend/.env` or `.env.local`):
```
NODE_ENV=development
KYC_AUTO_APPROVE=true
KYC_AUTO_APPROVE_DELAY_MS=10000
```
Then connect a testnet wallet on the frontend, sign in (works locally via the
stub signer), submit KYC → it shows "Verifying…" and lands on `/dashboard`
after ~10s. No AI service or contract deployment required.

For a **deployed testnet demo** (single persistent instance recommended):
```
DEMO_MODE=true
STELLAR_NETWORK=testnet
DEMO_SIGNER_SECRET=<testnet S… seed, funded, from the host secret manager>
KYC_AUTO_APPROVE=true
```
> Caveat still open: with in-memory stores, a multi-instance deployment can lose
> the SEP-10 challenge / session / order between requests. This batch does not
> fix persistence — that is the next batch (Postgres/Redis + real repositories),
> which needs you to provision the databases. Until then, run the deployed demo
> on a **single** persistent instance.

### 10.4 Updated shortcut status (from §7)

| # | Shortcut | Status after this batch |
|---|---|---|
| S3 | KYC auto-verify after 10s | ✅ implemented (flag-gated, prod-safe, stateless) |
| S4 | Testnet demo signer instead of KMS | ✅ implemented (`DEMO_MODE`, testnet-guarded) |
| S1 | Deterministic escrow gateway | unchanged (still the dev path) |
| S2 | AI call skipped | ✅ now explicitly bypassed when auto-approve is on |
| S5 | In-memory stores | ⏳ next batch (needs Postgres/Redis provisioning) |

### 10.5 Next batch (blocked on your input)

1. **Provision Postgres + Redis** (or confirm Supabase + rotate the exposed
   secret). Then I implement the real repositories to replace all `InMemory*`
   and validate migrations `0001`–`0004`.
2. **Confirm the backend host** (Railway / Render / Fly.io recommended — the
   reconciliation scheduler needs a persistent process; Vercel serverless does
   not fit). Frontend stays on Vercel.
3. Resolve the duplicate serverless entrypoint (`api/index.ts` vs
   `backend/api/index.ts`) once the host is chosen, to avoid breaking your
   current deploy.

### 10.6 Changelog

| Date | Change |
|---|---|
| 2026-07-22 | Stage 1 batch 1 implemented: testnet `DemoEnvSigner` (DEMO_MODE), 10s KYC auto-verify (config-gated, stateless resolve-on-read, `GET /api/kyc/status`, frontend polling), shared `autoApproveAt` + `KycStatusResponse`, config hygiene (removed hardcoded origin). Backend 29/29 tests, frontend typecheck, and an auto-verify smoke all pass. Deleted `awsedrfgyhuji.md`. |



---

## 11. OpenAI Integration & Development Auto-Approval (2026-07-22)

### 11.1 Configuration Added

**OpenAI API Key Integration:**
- Added OpenAI API key to backend `.env` for KYC risk assessment
- Set `KYC_RISK_ENGINE=openai` to use OpenAI instead of the local AI service
- Using `gpt-4o-mini` model for advisory KYC risk scoring
- API Key: stored in `backend/.env` as `OPENAI_API_KEY` (kept out of version control; never commit real keys)

### 11.2 Development Auto-Approval Mode

**Current Behavior (Development Only):**
- `KYC_AUTO_APPROVE=true` is enabled in development `.env`
- **All KYC verification requests automatically approve after 10 seconds**
- This bypasses the OpenAI advisory AND the human review queue
- Allows smooth development and testing of downstream flows (escrow, payments, disputes)

**Why This Approach:**
During development, we want:
1. OpenAI integration configured and ready to use
2. All requests to pass automatically so developers can test full workflows
3. No dependency on manual compliance reviews
4. No blocking on AI service response times

**Current Flow:**
```
User submits KYC → Status: "Under Review" → 
10 seconds pass → Frontend polls /api/kyc/status → 
Auto-approve resolves → Status: "Verified" → 
User can proceed with orders/escrow
```

### 11.3 Production Transition Plan

**When moving to production behavior:**

1. **Phase 1 - Enable OpenAI Review (keep auto-approve):**
   - OpenAI is already configured
   - System will call OpenAI for advisory scoring
   - But auto-approve still bypasses it temporarily
   - Test that OpenAI integration works correctly

2. **Phase 2 - Disable Auto-Approve (use real workflow):**
   - Set `KYC_AUTO_APPROVE=false` in `.env`
   - System will use: Provider → OpenAI Advisory → Decision Engine → Human Review (if needed)
   - Low-risk cases (below `KYC_APPROVE_MAX_RISK=0.35`) auto-approve via policy
   - High-risk cases route to human compliance review queue
   - AI advisory is logged and auditable

3. **Phase 3 - Production Hardening:**
   - Move `OPENAI_API_KEY` to secret manager (never in `.env` in production)
   - Set `NODE_ENV=production` (disables auto-approve regardless of flag)
   - Implement rate limiting on KYC endpoints
   - Monitor OpenAI API usage and costs

### 11.4 Safety Guardrails (Already Implemented)

**Auto-approve CANNOT activate in production:**
- `app.ts` passes `{ autoApprove: config.KYC_AUTO_APPROVE && !config.isProduction }`
- Even if `KYC_AUTO_APPROVE=true` is mistakenly set in production env, `!config.isProduction` prevents it
- All audit logs clearly mark development auto-approvals with `"development": true`

**OpenAI Integration Safety:**
- OpenAI is advisory-only (Rules.md §3, §6) — never moves funds or writes ledger
- On OpenAI timeout/failure, system degrades gracefully to human review
- Only opaque references and normalized signals sent to OpenAI (no PII, names, DOB, documents)
- Sanctions hits always force reject, regardless of AI recommendation

### 11.5 Updated Shortcut Status

| # | Shortcut | Status | Production Plan |
|---|---|---|---|
| **S6** | **OpenAI configured but bypassed by auto-approve** | ✅ **NEW** | Set `KYC_AUTO_APPROVE=false` |
| S3 | KYC auto-verify after 10s | ✅ enabled | Set `KYC_AUTO_APPROVE=false` |
| S4 | Testnet demo signer instead of KMS | ✅ enabled | Implement `KmsSigner` |
| S1 | Deterministic escrow gateway | unchanged | Implement `SorobanRpcEscrowGateway` |
| S2 | AI call skipped (when auto-approve on) | ✅ bypassed | Automatic when S3/S6 disabled |
| S5 | In-memory stores | ⏳ next batch | Postgres/Redis repositories |

### 11.6 Testing the Current Setup

**To verify OpenAI integration works (when ready to test):**

1. Temporarily disable auto-approve:
   ```bash
   # In backend/.env
   KYC_AUTO_APPROVE=false
   ```

2. Submit a KYC application via the frontend

3. Check backend logs for OpenAI API call:
   ```
   OpenAI KYC advisory: { riskScore: X, decision: "approve/review/reject", confidence: Y }
   ```

4. Verify the decision engine applies policy correctly:
   - Low risk (< 0.35) + high confidence (> 0.7) → Auto-approve
   - High risk or low confidence → Human review queue
   - Sanctions hit → Always reject

5. Re-enable auto-approve for continued development:
   ```bash
   KYC_AUTO_APPROVE=true
   ```

### 11.7 Files Modified

- `backend/.env` — Added OpenAI configuration + enabled auto-approve
- `backend/.env.example` — Documented OpenAI env vars
- `devlopement.md` — This section (§11)

### 11.8 Changelog Entry

| Date | Change |
|---|---|
| 2026-07-22 | **§11 OpenAI Integration:** Added OpenAI API key to backend configuration with `KYC_RISK_ENGINE=openai`. Currently bypassed by `KYC_AUTO_APPROVE=true` for smooth development (all KYC requests auto-verify after 10s). OpenAI integration is ready and can be activated by disabling auto-approve. Documented production transition plan and safety guardrails. Added new shortcut S6 to track this state. |


---

## 12. Implementation Log — On-chain escrow (2026-08-18)

Closes **D2** and the structural half of **A1/A2**. This is the batch that made
the escrow contract reachable from the product for the first time.

### 12.1 The problem

The escrow contract was written, tested, and completely unreachable:

- `SorobanRpcEscrowGateway.submitTransition()` threw for every transition.
- `ESCROW_WASM_HASH` was declared in config and read by **no file**.
- Nothing mapped an internal user id to a Stellar address.
- `StrKey` was never imported anywhere in the backend — a DB UUID or an empty
  string could be passed straight into a Soroban `Address` argument.
- There was no way for a buyer to sign anything, even though the frontend
  already had a wallet kit (used for SEP-10 only).

The root cause of the last point is structural: the contract gates
`initialize`, `confirm_delivery`, and `dispute` with the **acting party's**
`require_auth()`. The server cannot produce those signatures — no amount of
backend work fixes that. It needs a round trip.

### 12.2 What changed

**Contract (`contracts/escrow/src/lib.rs`)**
- `initialize` takes and stores `order_ref`, so reconciliation can prove a
  contract id really is a given order's custody rather than trusting the
  server-side mapping.
- `dispute` now also accepts the **arbiter** as a disputing party, with a new
  `Error::Unauthorized` for strangers. Rationale: `release` accepts only
  `Disputed` or `delivery_confirmed`, so without this the arbiter's settlement
  path was unreachable on-chain and compliance was blocked on a signature from
  the party it was ruling against.
- 9 tests pass (`cargo test --package escrow`), including the arbiter path and a
  stranger-rejection case.

**Signing model**
- `lock` / `confirm` / `dispute`: `POST …/{step}/prepare` returns an unsigned,
  simulated XDR built with the acting party's account as the transaction source;
  the wallet signs; `POST …/{step}/submit` submits it. Source-account
  credentials satisfy `require_auth()` with a single envelope signature —
  asserted by `toUnsignedTransaction()`, which refuses to hand back a
  transaction that would need signatures from other addresses.
- `release` / `refund`: one server-signed call as the arbiter.
- `GET /api/payments/capabilities` publishes the split.

**New boundaries**
- `modules/stellar/address.ts` — StrKey validation with named-field 400s.
- `modules/stellar/asset.ts` — integer-only minor-units ↔ token-amount
  conversion, per-currency token bindings, refuses to truncate in either
  direction.
- `modules/escrow/escrow.addresses.ts` — user id → SEP-10-proven wallet.
- `IdentityRepository.findPrimaryWallet()` (in-memory + Postgres).

**Correctness**
- Every submission reads the contract back and verifies state **and**
  `order_ref` before the ledger posts.
- `getEscrowSnapshot()` distinguishes `result.isErr()` (the contract answering
  "not initialized") from a thrown error (RPC down). Conflating them would make
  an outage look like missing custody and raise false reconciliation mismatches.
- Reconciliation now asserts on-chain custody state against the books, not just
  that a transaction hash exists.

**Divergence fixed**
The deterministic adapter used to allow `arbiter: true` to release a locked,
unconfirmed escrow — which the real contract rejects with `InvalidState`. Tests
passing therefore proved nothing about deployment. The adapter now mirrors the
contract, `settleDisputedOrder` escalates to `Disputed` first, and a regression
test pins the old behaviour as a failure.

**Schema**
`EscrowState.Pending` (custody deployed, buyer has not signed) and
`PaymentTransition.Dispute`, via migration `0008`. Persisting the contract id at
prepare-time means an abandoned signature costs one idle contract instead of
leaking a fresh one per retry. A dispute writes custody state + audit and **no**
ledger entries — no money moves.

**Config**
`superRefine` now fails the boot when `ESCROW_GATEWAY=soroban-rpc` has no WASM
hash or no token binding. The comments had claimed this for months; nothing
checked it, so the failure surfaced mid-payment instead of at startup.

**Frontend**
`features/escrow/useEscrowOrders.ts` drives prepare → sign → submit with honest
per-phase status (*Preparing → Confirm in your wallet → Submitting to Stellar*),
polls every 12s while orders are in flight, pauses on a hidden tab, detects
wallet cancellation, and re-reads after an error because the step may have
landed on-chain even if the response did not arrive.

**Tooling**
`contracts/scripts/deploy-testnet.ps1` ran `contract deploy` (which emits a
contract *id*) when both gateways need the WASM *hash*. It now runs
`contract upload` for both contracts and prints the env lines.

### 12.3 Verification

| Check | Before | After |
|---|---|---|
| `cargo test` | 6 escrow tests | **9 escrow + 18 rwa_token = 27 pass** |
| `vitest run` | 16 pass / 9 of 11 files erroring | **102 pass / 13 files** |
| backend typecheck + eslint | clean | clean |
| frontend typecheck + eslint + build | clean | clean, 10 app routes |

The test-count jump is mostly a fix, not new coverage: 9 of 11 files were
failing at import because a placeholder `AUTH_DEMO_WALLET` in the local `.env`
failed config validation. Blank env vars now mean "unset" (`optionalEnv`) and
`vitest.config.ts` clears demo/chain vars — extending the isolation that file
already intended for `KYC_AUTO_APPROVE`.

### 12.4 Still not verified

Nothing here has run against a real Stellar network or a real Postgres. The
first live `initialize` is where SDK-level surprises would surface, and it needs
a funded identity, a deployed contract, a token binding, and a buyer holding
that token. See §8.

### 12.5 Changelog

| Date | Change |
|---|---|
| 2026-08-18 | **§12 On-chain escrow wired end to end.** Contract `order_ref` + arbiter dispute; `SorobanRpcEscrowGateway` with prepare/sign/submit and read-back; StrKey + amount-conversion + address-resolution boundaries; deterministic adapter aligned with the contract (regression-tested); `EscrowState.Pending` + `PaymentTransition.Dispute` + migration `0008`; config self-enforcement; wallet-signing frontend with live refresh; deploy script fixed to upload WASM hashes. 27 contract tests, 102 backend tests, frontend build all green. |
| 2026-08-18 | **Docs accuracy pass.** Audited all seven `docs/` files against the repo. `DESIGN.md` verified valid. Corrected `Architecture.md`, `Rules.md`, `Phases.md`, `Memory.md`, `PRD.md`, and rewrote this file's TL;DR, issue register, shortcuts, and next actions — most original blockers are resolved, and three new RWA gaps (I1–I3) were found and recorded. |
