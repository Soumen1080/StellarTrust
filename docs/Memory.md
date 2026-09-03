# StellarTrust — Project Memory

> **Purpose:** Living state file for the whole project. **Read this first** at the
> start of any session, and **update it after any change.** It captures current
> status, what is being worked on, what is complicated, decisions made, and a
> changelog. This is the shared memory for humans and AI agents.
>
> **Update policy:** Every change to the codebase or docs should update the
> relevant section here (Current Focus, Decision Log, Changelog, Complications).

**Last updated:** 2026-09-03

---

## 1. Project Snapshot

- **Name:** StellarTrust
- **What:** AI-powered cross-border escrow, liquidity settlement, and RWA
  tokenization platform on Stellar.
- **Track:** Production (real product for real users).
- **Current phase:** Phase 6 — Hardening. Application-level hardening is
  complete (observability/metrics/alerting, readiness probes, reputation store,
  dispute auto-execution). Phases 1–5 application code is complete, including
  the on-chain escrow path and durable settlement persistence. A public product
  feedback wall shipped as the last Phase 6 feature.
  What remains is operational/external: live contract instances exercised by
  real users, a real KMS signer, Redis-backed idempotency, live anchors, an
  independent security audit, and MSB licensing.

### Verified state (2026-09-03 — re-measured, not assumed)

| Check | Result |
|---|---|
| `contracts` — `cargo test` | ✅ **27 pass** (escrow 9, rwa_token 18) |
| `backend` — `vitest run` | ✅ **257 pass**, 26 files, 0 failures |
| `frontend` — `tsc --noEmit` | ✅ clean |
| `ai` — pytest | ⚠️ CI-only (native wheels blocked on this machine), 6 tests |
| Database invariant tests (psql) | ⚠️ CI-only, 2 smoke tests |

**Total across suites: 292 tests.**

- **Repo state:** All portions present. Postgres repositories exist and are used
  when `DATABASE_URL` is set for: identity, auth, audit, ledger, payments,
  disputes, rwa, **settlement**, and **feedback**. Still in-memory in every
  environment: **kyc**, **reputation**, and all **idempotency** stores. Chain
  adapters have real Soroban implementations for escrow and RWA; anchor and
  liquidity are still sandbox/deterministic only.
- **Migrations:** `0001`–`0015`. `0014` and `0015` are *repair* migrations that
  re-apply settlement/dispute-party and on-chain-escrow/dispute-link/holding
  status schema to a deployed database where the originals never ran.

### Canonical docs
- `PRD.md` — product requirements, users, features.
- `Architecture.md` — architecture, flow, structure, stack, data model.
- `Rules.md` — engineering rules, libraries, error handling, AI guardrails.
- `Phases.md` — phased roadmap + acceptance criteria.
- `DESIGN.md` — colors, fonts, typography, UI system (matches
  `frontend/tailwind.config.ts`).
- `devlopement.md` — development log + issue register + production plan.
- `testnet-onchain-setup.md` — taking escrow from simulator to real testnet value.
- `SUBMISSION_TODO.md` — what is left that only a human can do.
- `Memory.md` — this file.

---

## 2. Current Focus

- **Currently working on:** documentation accuracy pass — every `.md` rewritten
  against the actual codebase (2026-09-03).
- **Immediately next (code):** Redis-backed idempotency — the last place a
  golden rule (#4) is aspirational rather than enforced in a multi-instance
  deployment. Then Postgres repositories for kyc and reputation, the last two
  domains that lose state on restart.
- **Blocked on you (operational):** run a real testnet order end-to-end with
  `ESCROW_GATEWAY=soroban-rpc` so a live contract instance ID and transaction
  hash exist to record; onboard 10+ real wallet users. See `SUBMISSION_TODO.md`.

---

## 3. Recent Work

### Product feedback wall (Phase 6, most recent)
A public, in-app feedback surface — not a form link.

- Backend module `modules/feedback` — `GET /api/feedback` (public wall,
  unauthenticated, capped at `FEEDBACK_PAGE_SIZE = 50` newest-first so an open
  endpoint cannot become a free full-table read), `GET /api/feedback/me`,
  `POST /api/feedback` (requires a verified session).
- **PII boundary:** email and wallet address are accepted and stored, and never
  returned by any endpoint. `FeedbackDTO` is the only shape that leaves the
  service. Row-level security was added on `product_feedback` to protect contact
  PII at the database layer as well.
- **One entry per account.** The wall is public and unmoderated; a verified
  session plus one opinion per account is what keeps it from being a spam
  surface.
- Migration `0013`; UI in `frontend/src/features/feedback/`.

### Contract-ID validation and error handling
- Guarded against errors when a Soroban contract is not yet deployed — a missing
  or malformed contract ID is now detected and reported rather than surfacing as
  an opaque transaction failure.
- Broader error handling for contract transactions and deployment failures.

### Repair migrations (`0014`, `0015`)
A deployed database had drifted from the migration history — the settlement
(`0011`), dispute-parties (`0012`), on-chain escrow (`0008`), dispute/escrow link
(`0009`) and RWA holding-status (`0010`) schema were missing. Both repairs are
idempotent and no-ops on a database that already has the schema.

### Durable cross-border settlement persistence
Settlement moved from in-memory to Postgres (`PgSettlementRepository`, migration
`0011`): settlements, quotes, transitions, and reconciliation mismatches all
survive a restart. Payout rails covered by 23 tests.

### CORS origin validation
Configured origins are normalized to scheme+host+port before matching, because
values typed into a hosting dashboard routinely arrive with a trailing slash —
one stray slash silently blocked every request from the deployed frontend and
surfaced in the browser only as `TypeError: Failed to fetch`. Wildcards match a
single host label, so `https://acme-*.vercel.app` covers Vercel preview deploys
without widening to another project's domain.

### RWA issuer self-custody
`RWA_CUSTODY=issuer` makes the issuer's own SEP-10 wallet the on-chain issuer;
the platform cannot move units, freeze, or arm the payout guard on their behalf.
Three consequences are surfaced rather than hidden: a purchase stays a *pending*
holding until the issuer signs (earning no payout, reported as outstanding),
compliance freeze is platform-side only, and the one-shot payout guard is the
issuer's to arm. The RWA reconciliation job reports each divergence.

### RWA payout correctness
- **Payouts now post to the ledger.** `distributePayout` had computed a balanced
  transaction and thrown it away (`void` on a *synchronous* method), storing a
  `randomUUID()` as its `ledgerTransactionId` — every RWA payout wrote nothing to
  the system of record.
- **Idempotency** keyed on `rwa-payout:{tokenization}:{order}:{transition}` —
  derived from what caused the payout, not a timestamp — so the retryable
  escrow-release hook converges on one posting.
- **Ordering bug caught by a test written for it:** marking the contract
  distributed *before* the ledger post deadlocks a retry — the one-shot flag is
  set, the money was never recorded, and no later attempt can finish. The ledger
  posts first.
- **Real addresses.** Issuer and holder resolve through `WalletAddressResolver`
  with StrKey validation; previously a DB UUID went straight into a Soroban
  `Address`.

### On-chain escrow
- **Root problem:** the escrow contract was written and tested but *unreachable*
  — `SorobanRpcEscrowGateway.submitTransition` threw unconditionally,
  `ESCROW_WASM_HASH` had zero readers, and nothing validated a strkey anywhere.
- **Contract:** added an on-chain `order_ref` so reconciliation can prove a
  contract id belongs to its order; allowed the **arbiter** to raise a dispute
  (the contract accepts `release` only from `Disputed` or `delivery_confirmed`,
  so without this the arbiter's release path was unreachable).
- **Signing split.** `initialize`/`confirm_delivery`/`dispute` need the acting
  party's `require_auth()`, so they run **prepare → wallet sign → submit** with
  that party as transaction source. `release`/`refund` are arbiter-signed
  server-side. `GET /api/payments/capabilities` publishes the split so the
  frontend never hard-codes it.
- **Correctness:** every submission reads the contract back and checks state and
  order binding before the ledger posts. `getEscrowSnapshot` distinguishes
  `isErr()` ("not initialized") from a thrown error (RPC down), so an outage
  cannot be mistaken for missing custody.
- **Divergence fixed:** the deterministic adapter used to let `arbiter: true`
  release a locked, unconfirmed escrow — which the real contract rejects with
  `InvalidState`. It now mirrors the contract.
- **Config enforces itself:** boot fails when `ESCROW_GATEWAY=soroban-rpc` lacks
  a WASM hash or token binding.

### Phase 6 hardening (application layer)
- **Observability.** `lib/metrics.ts` — dependency-free Prometheus registry
  exposing `http_requests_total`, `http_request_duration_seconds`,
  `reconciliation_unresolved_mismatches`, `reconciliation_runs_total`,
  `alerts_total`. Per-route cardinality is bounded to the matched route pattern,
  never ids or PII. `/metrics`, `/health/live`, and `/health/ready` (DB ping +
  reconciliation drift → 503 when degraded).
- **Alerting.** `lib/alerts.ts` — `AlertSink` + `LoggingAlertSink` +
  `RecordingAlertSink`. Both reconciliation jobs emit a critical alert on
  unresolved drift and track `lastUnresolved()` for the readiness probe.
- **Reputation store.** Bounded 0..1 advisory score from completed orders and
  resolved disputes, Laplace-smoothed toward a neutral 0.5 prior. Advisory only —
  never gates money.
- **Dispute auto-execution.** `PaymentService.settleDisputedOrder` releases or
  refunds a *locked* escrow on the authority of a resolved dispute.

---

## 4. Complications & Known Gaps

| Area | Gap | Consequence |
|---|---|---|
| Idempotency | Stores are in-memory in every environment | Golden rule #4 is not enforced across instances or restarts. Blocks safe multi-instance deploys. |
| KYC / reputation | No Postgres repository | State is lost on restart. |
| Anchors / liquidity | Sandbox and deterministic adapters only | No real fiat on/off ramp; settlement rates are simulated. |
| Signer | `local-stub` / `DEMO_MODE` env seed | Real KMS/HSM signing is required before staging or production. |
| Frontend tests | Zero | No automated guard on UI regressions. |
| Contract events | Emitted, nothing consumes them | No real-time push; the UI polls every 12s instead. |
| `LICENSE` | README claims MIT; file does not exist | Unbacked license claim. |
| Env examples | README tells users to copy `backend/.env.render.example` and `frontend/.env.vercel.example` | Neither file exists; setup instructions fail on a fresh clone. `.gitignore` ends with a blanket `.env*` that overrides the earlier `!.env.example` negation. |

---

## 5. Decision Log

| Decision | Rationale |
|---|---|
| Ledger is the system of record, not the chain | Chain state can lag, fork, or be unreachable. A double-entry ledger with a database-enforced balance constraint is the auditable truth; reconciliation asserts the chain against it. |
| AI is advisory, never autonomous | Above `AUTO_RESOLVE_MAX_AMOUNT` or below `AUTO_RESOLVE_MIN_CONFIDENCE`, a human decides. An AI timeout degrades to human review rather than blocking. |
| One escrow contract instance per order | Cheaper than a monolithic contract and gives every order isolated custody. |
| Deploy from an installed WASM *hash*, not a contract ID | Both gateways need the hash; the deploy script uploads rather than deploys. |
| Hand-written TS interfaces + a spec manifest, not generated bindings | Generated bindings were not viable; `contract-spec.json` diffed in CI makes a renamed Rust argument fail CI instead of failing a real transaction at simulation. |
| `ESCROW_GATEWAY` is a real switch, not a feature flag | `deterministic` moves no value and synthesizes hashes; `soroban-rpc` moves real testnet funds. `npm run chain:preflight` reports which mode is live. |
| Blank env vars mean "unset" | `FOO=` in a `.env` and an empty hosting-dashboard field both mean "not configured" to a human, but arrive as `""` and fail a format check instead of falling through to `.optional()`. |
| Feedback contact fields stored, never returned | The wall is public; email and wallet are for follow-up only. Enforced in the service *and* by row-level security. |
| Forward-only migrations, never edited after landing | Repairs ship as new numbered migrations (`0014`, `0015`), not edits to history. |

---

## 6. Changelog

| Date | Change |
|---|---|
| 2026-09-03 | Full documentation accuracy pass — every `.md` rewritten against the codebase. |
| 2026-09-03 | Removed the account/verification link from the primary nav; the CTA button remains the path to `/kyc`. |
| 2026-08-27 | README updated with verified test count (292) and demo video link. |
| 2026-08-27 | Error handling for contract transactions and deployment failures. |
| 2026-08-26 | Repair migrations `0014`, `0015` for a drifted deployed database. |
| 2026-08-26 | Contract-ID validation for undeployed Soroban contracts. |
| 2026-08-25 | Row-level security on `product_feedback` to protect contact PII. |
| 2026-08-25 | Product feedback wall (backend module, migration `0013`, UI + CTA). |
| 2026-08-25 | Durable cross-border settlement persistence (`0011`) and payout rails. |
| 2026-08-25 | Escrow dispute handling and order visibility. |
| 2026-08-23 | CORS origin validation and normalization. |
| 2026-08-19 | RWA issuer self-custody (`RWA_CUSTODY=issuer`, migration `0010`). |
| 2026-08-19 | RWA ledger reconciliation; on-chain escrow setup and testnet provisioning scripts. |
| 2026-08-18 | Phase 6 application hardening — metrics, alerts, readiness, reputation. |
