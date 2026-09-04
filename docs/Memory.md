# StellarTrust — Project Memory

> **Purpose:** Living state file for the whole project. **Read this first** at the
> start of any session, and **update it after any change.** It captures current
> status, what is being worked on, what is complicated, decisions made, and a
> changelog. This is the shared memory for humans and AI agents.
>
> **Update policy:** Every change to the codebase or docs should update the
> relevant section here (Current Focus, Decision Log, Changelog, Complications).

**Last updated:** 2026-09-04

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
  real users, a real KMS signer, a provisioned Redis, live anchors, an
  independent security audit, and MSB licensing.

### Verified state (2026-09-04 — re-measured, not assumed)

| Check | Result |
|---|---|
| `contracts` — `cargo test` | ✅ **27 pass** (escrow 9, rwa_token 18) — last measured 2026-09-03 |
| `backend` — `vitest run` | ✅ **557 pass**, 42 files, 0 failures |
| `backend` — `tsc --noEmit`, `eslint .` | ✅ clean |
| `frontend` — `vitest run` | ✅ **44 pass**, 3 files (was zero) |
| `frontend` — `tsc --noEmit`, `eslint .`, `next build` | ✅ clean (1 pre-existing warning in `EscrowDashboard.tsx`) |
| `ai` — pytest | ⚠️ CI-only (native wheels blocked on this machine), 6 tests |
| Database invariant tests (psql) | ⚠️ CI-only, 3 smoke tests |
| Live testnet XLM transfer (`chain:verify-xlm`) | ✅ **6/6 checks**, run 2026-09-04 |

**Total across suites: 636 tests.**

Live testnet proof (2026-09-04) — real XLM moved between two funded accounts,
balances asserted to the stroop, and the platform's own decimal conversion
checked against what the chain reported:
`b3eac6ee1e7efd490f63d1c1aaa9a1685f38e4037f3346239b45f30f843fb7d7` (sent),
`3186d4ac864cf6a8a60409e33330e0c856d63be30a0334440383567312bdf199` (returned).

> The 292 figure in `README.md` is a captured run from 2026-08-27 and is now
> stale; it is a transcript of that run, so refreshing it means re-capturing
> the output rather than editing the number.

- **Repo state:** All portions present. Postgres repositories exist and are used
  when `DATABASE_URL` is set for: identity, auth, audit, ledger, payments,
  disputes, rwa, settlement, feedback, **kyc**, **reputation**, **treasury**,
  and the **verification policy**. Idempotency and rate limiting are
  Redis-backed when `REDIS_URL` is set and fall back to in-memory with a
  single-instance warning at boot otherwise. Chain adapters have real Soroban
  implementations for escrow and RWA and a real Horizon implementation for
  treasury; anchor and liquidity are still sandbox/deterministic only.
- **Migrations:** `0001`–`0022`. `0014`/`0015` are *repair* migrations.
  `0020` adds per-user ledger accounts, the `ledger_account_balances` view, and
  three money-safety invariants; `0021` adds `treasury_movements`; `0022` adds
  KYC/reputation persistence and the `verification_policies` control surface.

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

- **Currently working on:** `plane.md` §3 and §4 are **complete** except the two
  §4.6 polish items. Landed 2026-09-04: §4.5 per-user ledger accounts and the
  treasury module that funds them, §4.1 Redis-backed idempotency and rate
  limiting, §4.2 KYC/reputation persistence, §4.3 database money invariants,
  §4.4 business metrics and alerting, §4.6's component tests, and §4.7 — an
  operations console that was not in the original plan.

  The through-line: every user now has a real balance, funded by a verified
  on-chain payment, and a purchase they cannot afford is refused. That closes
  the standing blocker §1.1 and §3.2 both named.
- **Immediately next (code):** the two remaining §4.6 items — SSE streaming to
  replace the 12s polling, and breaking up the dense single-line JSX in
  `RwaConsole.tsx` / `EscrowDashboard.tsx` / `KycOnboarding.tsx`. Both are
  polish; neither blocks anything. §1.1's last box (a fully atomic purchase
  across ledger + holding + chain) needs a cross-module transaction boundary
  that does not exist yet, and is deferred with §2.1's for the same reason.
- **Blocked on you (operational):** apply migrations `0020`–`0022` to the
  deployed database; set `REDIS_URL` before running more than one API instance
  (the app warns at boot if it is unset); set `TREASURY_GATEWAY=horizon` so
  deposits verify against real payments rather than the deterministic double.
  Then run a real testnet order end-to-end with `ESCROW_GATEWAY=soroban-rpc`,
  and onboard 10+ real wallet users. See `SUBMISSION_TODO.md`.

---

## 3. Recent Work

### Per-user ledger accounts + treasury (plane.md §4.5 — most recent)

Every posting in the platform landed on a *system* account, so "this investor's
balance" was not a thing that existed. That is why the insufficient-funds
checks in §1.1 and §3.2 could not be written, and why no user had a statement.

One `user_cash` account per (user, currency), created on demand, addressed as
`user:<id>/user_cash`. Typed `liability` and constrained to be one — the
balance is what the platform *owes* the user, so spending debits it; typed as
an asset it would read with the sign inverted and an overdrawn user would look
funded. Balances come from a **view** over `ledger_entries`, never a stored
column: a stored balance is a second copy of what the entries already say, and
the two drift the moment a write path forgets to update it.

Five postings moved onto the user's own account. The payout is the interesting
one — it now credits **each holder individually** rather than a lump to
`rwa_payout_payable`, which makes the ledger agree with `payout_records` by
construction instead of by cross-referencing two tables.

That left a gap: users had a balance and no way to hold anything, so the new
check would have refused every purchase. Hence **treasury**. A deposit is a
*verification, not an instruction* — the user gives a transaction hash, not an
amount, and the platform reads that transaction from Horizon and credits
exactly what arrived from exactly the wallet they proved at SEP-10. A
transaction can be credited once, guarded twice and independently: a unique
index on the hash, and the ledger's own uniqueness on the reference id.

Verified on live testnet: `npm run chain:verify-xlm` funds two accounts, moves
real XLM, and asserts the balance deltas to the stroop *and* that the
platform's own decimal conversion agrees with what the chain reported — the
check unit tests structurally cannot make.

### Cross-instance and persistence gaps (plane.md §4.1, §4.2)

Idempotency and rate limiting were per-process. Behind two API instances a
retry landing on the other one found nothing stored and re-executed, which on
a money-mutating endpoint is a double spend — the exact failure idempotency
keys exist to prevent. Redis backs both when `REDIS_URL` is set; without it
the in-memory stores are used and the constraint is *announced at boot* rather
than silently accepted.

Two bugs surfaced while wiring it. Every router constructed its own store, so
a retry was only recognised by the route group that first served it. And the
middleware stored every response including failures, which makes a transient
5xx permanent for that key — retrying is the right response to a chain blip,
and replaying the error forecloses it.

KYC and reputation moved to Postgres. Both are consulted when money moves, and
an in-memory store meant a deploy reset every user to unverified, re-opened
every closed review, and discarded every track record.

### Operations console (plane.md §4.7)

Business metrics the platform never computed — total value locked, capital
deployed, default rate, dispute rate, days-to-collect — plus the queues and an
audit trail, behind the compliance role.

The substantive change is that **verification routing became a policy row**
rather than three environment variables. The moment you need a control
tightened is the moment you cannot wait for a redeploy. It is read per
submission, so a change applies to the next application; every edit is audited
with the value it was changed *from*, which is the question an auditor asks.

`auto` mode does not mean the model decides — AI stays advisory in every mode
(Rules.md §6). It means the deterministic policy may conclude without queueing
a human. Hard failures, conflicting evidence, and amounts above the ceiling
still reach a person whatever the mode.

### RWA secondary market and risk surfacing (plane.md §3.3, §3.4)

Closes finding D6. An investor could enter a position and never leave it, and
could not add to one they liked.

- **Top-ups and holder-to-holder sales.** `purchaseUnits` increases an existing
  holding instead of refusing; `transferHolding` sells units to another holder
  at a price the two parties agree — not derived from the financing terms,
  because an invoice near maturity is worth more than one just issued. Honours
  the authorization allowlist and the frozen flag, and refuses a sale of
  undelivered units or one around a running distribution.
- **The on-chain leg is the seller's to sign.** `transfer` calls
  `from.require_auth()`, so the platform can only move units it is the `from`
  for — the same contract constraint §3.2 hit on cooling-off cancellation.
- **Risk on every card.** Advance rate, yield, maturity, signed days remaining,
  issuer reputation, projected yield, debtor, and dispute state — computed
  server-side and carried on the *list* response so the marketplace does not
  need a fetch per card. Plus an explicit disclosure before the confirm step,
  and a portfolio that shows accrued yield, overdue positions, and realized
  losses rather than only "total invested".
- **Two latent bugs found by the new arithmetic.** `InMemoryRwaRepository`
  accumulated `units_sold` while the Postgres trigger recomputes it — harmless
  until units could move between holders, and it meant the §3.2 cancellation
  would have drifted differently in production than in every test.
  `writeOffTokenization` posted recovery to the ledger but wrote no payout
  records, so a written-off position reported the whole investment as lost even
  when most of it had been recovered.
- 39 new tests (439 total, was 400).

### RWA asset verification and investor protection (plane.md §3.1, §3.2)

Closes finding D7 and D8. An asset's valuation used to be whatever the issuer
typed: no document behind it, no review, and no check that the same receivable
was not already financed elsewhere.

- **Verification workflow.** `Unverified → UnderReview → Verified | Rejected`
  on `assets` (migration `0018`). Only a `Verified` asset may be tokenized, and
  the gate sits at `createTokenization` — an unverified deal never reaches an
  investor, so nobody can subscribe to something later found to have no
  evidence. Documents are opaque references with a SHA-256, never files.
  Deciding requires the `compliance` role, the issuer included.
- **Double-pledge guard.** Matches `assetRef` *across owners*, because the
  unique constraint on `(owner_user_id, asset_ref)` cannot see the same invoice
  filed under a second account — which is how the fraud is actually done.
  Checked at verification and again at tokenization, since a competing pledge
  can appear in between.
- **Investor limits.** KYC, concentration, exposure, minimum ticket, unit
  granularity, and a cooling-off window, all configurable and all `bigint`.
  Every check runs before the ledger posting, so a refusal moves no money.
- **Cooling-off has a hard boundary the contract sets, not policy.**
  `transfer` calls `from.require_auth()`, so delivered units can only be
  returned by their holder — no custody mode gives the platform that key. A
  cancellation is refused once a holding is `Settled` (immediate under platform
  custody); the window is genuinely usable under issuer custody, where delivery
  waits on the issuer's signature.
- 49 new tests (400 total, was 351).

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
| Idempotency | Redis-backed when `REDIS_URL` is set; in-memory otherwise | Golden rule #4 holds across instances **once Redis is configured**. Without it the app boots with a `SINGLE INSTANCE ONLY` warning — the constraint is announced, not removed. |
| Anchors / liquidity | Sandbox and deterministic adapters only | No real fiat on/off ramp; settlement rates are simulated. |
| Signer | `local-stub` / `DEMO_MODE` env seed | Real KMS/HSM signing is required before staging or production. The treasury signs withdrawals with the same key, so this now gates payouts too. |
| Treasury gateway | Defaults to `deterministic` | Deposits are not verified against a real chain until `TREASURY_GATEWAY=horizon`. Refused outright in staging/production, so it cannot ship unnoticed. |
| Purchase atomicity | Ledger post, holding row, and chain transfer are not one transaction | A chain failure after the posting leaves a paid-for holding with no units. Reported by the RWA reconciliation job rather than hidden. Needs a cross-module transaction boundary (with §2.1's last box). |
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
| A user ledger account is a **liability**, and the balance is a **view** | The platform owes the user their balance, so spending debits it; typed as an asset the sign inverts and an overdrawn user reads as funded. The balance is derived from `ledger_entries` rather than stored, because a stored total is a second copy that drifts the moment a write path forgets it — the class of bug double-entry exists to make impossible. |
| A deposit is a verification, not an instruction | The user supplies a transaction hash, never an amount. The platform reads that transaction from Horizon and credits exactly what arrived, from exactly the wallet proved at SEP-10. An amount field would imply the number is theirs to choose. |
| Withdrawals debit before submitting, and reverse on failure | This can leave a user briefly debited for a payment that never went out. The alternative pays a user who never had the balance, and only one of those two failures is recoverable. |
| Rate limiting fails **open** when Redis is unreachable | The one place in the platform where failing open is right: the limiter guards against abuse, not against incorrect money movement, and every money path has its own authorization and idempotency behind it. A limiter that cannot reach its store must not become an API outage. |
| Missing Redis warns at boot rather than refusing to start | Failing closed would mean an operator who has not yet provisioned Redis cannot run the platform at all — trading a known, announced limitation for an outage. |
| Verification routing is a database row, not an env var | The moment a control needs tightening is the moment you cannot wait for a redeploy. Read per submission so a change applies to the next application, and audited with the value it was changed *from*, which is the question an auditor actually asks. |
| `auto` mode does not mean the model decides | AI stays advisory in every mode (Rules.md §6). `auto` means the deterministic policy may conclude without queueing a human; hard failures, conflicting evidence, and amounts above the ceiling still reach a person. |
| Business metrics are per currency, never summed | A cross-currency total needs an FX rate the platform does not have. A number that silently assumes 1 USD = 1 EUR is worse than no number. |
| The default rate counts resolved positions only | Counting still-running positions as successes flatters a young book, and an operator making a credit decision on that number is misled by their own dashboard. |
| Alerts carry rates and counts, never amounts or identities | An alerting pipeline fans out to pagers, chat channels, and third-party incident tools — the wrong place for a user id or a position's value (Rules.md §3). |
| Forward-only migrations, never edited after landing | Repairs ship as new numbered migrations (`0014`, `0015`), not edits to history. |
| Existing assets backfill as `unverified`, not verified | Nothing has ever been reviewed, so marking those rows verified would be a lie told by a migration. An already-tokenized asset reads unverified while its tokenization runs on untouched — the gate is at creation, so no live position is stranded. |
| The double-pledge check matches `assetRef` across owners | The classic invoice-financing fraud is the same receivable financed twice under two accounts. A per-owner unique constraint cannot see it. |
| Verification is refused at tokenization, not at purchase | Refusing later would leave a window in which an investor could subscribe to a deal that then fails review. The unverified deal never becomes investable at all. |
| A cooling-off cancellation cannot reclaim delivered units | The token contract requires `from.require_auth()`, so only the holder can move their own units back. Refusing a `Settled` holding is the contract's constraint surfaced honestly; the exit for a delivered position is the secondary market (§3.3). |
| A cancellation posts a reversal, never deletes the subscription | The ledger is append-only and is the system of record (Golden Rule #1). An unwound subscription is two facts — it happened, and it was reversed. |
| Investor limits default to unrestricted when unwired | A construction that forgot to pass them keeps its prior behaviour; only `app.ts` passes the configured numbers. Defaulting to production limits would silently change what existing tests assert about unrelated arithmetic. |
| A secondary trade credits `rwa_secondary_seller_payable`, not the issuer's payable | The issuer is not party to a holder-to-holder trade. Crediting their proceeds account would overstate what the platform owes them for a sale they had no part in. |
| A secondary price is agreed by the parties, never derived | An invoice near maturity is worth more than one just issued, and a disputed one less. The platform records the trade; it does not price or guarantee it. |
| The subscription ledger reference keys on the resulting unit total, not the increment | Once top-ups are possible, "buy 10 then 10 more" would build the same reference twice and the conflict path would hand over the second 10 free. The running total keeps each step distinct while a retry still converges. |
| Concentration is measured on the resulting position | Checking only the increment lets an investor walk past the cap in small steps, which is the one thing a concentration cap exists to stop. |
| `daysRemaining` is signed, not floored at zero | `daysBetween` floors, which would erase exactly the overdue case the field exists to surface. |
| Risk is carried on the list response, keyed by id | The marketplace renders every open deal at once; a detail fetch per card is how a risk disclosure ends up dropped for being slow. Keyed rather than positional so filtering cannot pair a card with another deal's risk. |
| An unrealized shortfall is not a realized loss | While a position is open a shortfall is a risk. Reporting it as a loss puts a number on the screen that is not yet true; it is realized only on write-off. |
| Counterparty reputation is advisory, never a gate | A counterparty with no history scores null, and refusing those would exclude the new sellers the platform exists to finance. |

---

## 6. Changelog

| Date | Change |
|---|---|
| 2026-09-04 | Frontend component tests (44, was zero) for the purchase, escrow-transition, and dispute flows; SQL invariant tests. Both run in CI (plane.md §4.6, §4.3). |
| 2026-09-04 | Business metrics and threshold alerting (plane.md §4.4). |
| 2026-09-04 | Operations console: metrics, queues, audit trail, and the verification routing policy (plane.md §4.7; migration `0022`). |
| 2026-09-04 | Redis-backed idempotency and rate limiting; Postgres KYC and reputation repositories (plane.md §4.1, §4.2). |
| 2026-09-04 | Per-user ledger accounts, money-safety invariants, and the treasury module that funds a balance (plane.md §4.5, §4.3; migrations `0020`, `0021`). Live testnet XLM transfer verified. |
| 2026-09-04 | RWA secondary market and risk surfacing (plane.md §3.3, §3.4; migration `0019`). |
| 2026-09-04 | RWA asset verification and investor protection (plane.md §3.1, §3.2; migration `0018`). |
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
