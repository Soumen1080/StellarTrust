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
- **Current phase:** Phase 0 — Foundations (not started; docs authored).
- **Repo state:** Documentation only. No application code scaffolded yet.

### Canonical docs
- `docs/PRD.md` — product requirements, users, features.
- `docs/Architecture.md` — architecture, flow, structure, stack, data model.
- `docs/Rules.md` — engineering rules, libraries, error handling, AI guardrails.
- `docs/Phases.md` — phased roadmap + acceptance criteria.
- `docs/Design.md` — colors, fonts, typography, UI system.
- `docs/Memory.md` — this file.

---

## 2. Current Focus

- **Currently working on:** Project documentation set (PRD, Architecture, Rules,
  Phases, Design, Memory).
- **File(s) in progress:** `docs/Memory.md` (final doc).
- **Next up:** Decide open questions (launch corridors, anchor partner, custody
  model, auto-resolve thresholds), then begin **Phase 0** scaffold
  (separate folders per portion: `frontend`, `backend`, `ai`, `contracts`,
  `shared`, `infra` + Supabase schema with double-entry ledger + Stellar testnet
  setup).

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
- Toolchain check (Node/pnpm/Rust+stellar-cli/Python 3.11+): **not yet verified.**
- No secrets committed. KMS/HSM not yet configured.

---

## 7. Changelog

| Date | Change |
|---|---|
| 2026-07-18 | Authored initial docs: PRD, Architecture, Rules, Phases, Design, Memory. |
| 2026-07-18 | Locked production-track decisions D1–D11 (see Decision Log). |
| 2026-07-18 | Restructured to fully separate top-level folders per portion: `frontend/`, `backend/`, `ai/`, `contracts/`, `shared/`, `infra/`. `frontend` & `backend` are independent projects (own `package.json`/build/deploy). Updated Architecture, Rules, Phases, Design accordingly (D9). |

---

## 8. How To Use This File (for AI agents & contributors)

1. **On session start:** read this file + `docs/Rules.md` before acting.
2. **Before coding:** confirm current phase + focus here.
3. **After any change:** update Section 2 (Current Focus), add to Changelog,
   record new decisions (Section 3) and complications (Section 4).
4. **When a file becomes the active work item:** note it in "File(s) in
   progress."
5. Keep entries concise and factual. This file is the project's memory.
