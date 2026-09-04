# StellarTrust — Industry-Grade Platform Plan

> **Purpose:** Turn StellarTrust from a feature demo into a platform that solves a
> real problem end to end. This file is the working checklist. Mark a box `[x]`
> only when the task is implemented **and** covered by a test that runs in CI.
>
> **Created:** 2026-09-03
> **Status legend:** `[ ]` not started · `[~]` in progress · `[x]` done (tested)
> **Severity:** 🔴 blocker (platform is not real without it) · 🟠 major · 🟡 polish
>
> **Decisions already made** live in §8 with their reasoning. Read it before
> proposing an alternative that was already weighed and set aside.

---

## 0. The diagnosis — why it currently reads as a demo

This plan is written against findings verified in the code on 2026-09-03, not
against impressions. Each is a specific, located defect.

| # | Finding | Where | Why it makes the platform a demo |
|---|---|---|---|
| D1 | **An investor purchase moves no money.** `purchaseUnits` creates a holding row and an audit entry. It never calls `LedgerService`. No debit from the investor, no credit to the issuer. | `rwa.service.ts` `purchaseUnits` | This is the whole point of tokenization — the seller gets cash early. Today units are given away and no one is charged. The issuer receives nothing. |
| D2 | **The payout pays out the wrong number.** On escrow release the *entire order amount* is distributed pro-rata to holders. | `payment.service.ts` `triggerRwaPayout` | Real invoice financing pays investors principal + agreed yield, and the balance goes to the seller. Paying 100% of the invoice to investors means the seller financed nothing and the platform earns nothing. |
| D3 | **Settlement is disconnected from escrow.** `SettlementDTO` has no `orderId`. | `shared/src/types` | A cross-border trade cannot actually be paid for through a corridor. The two headline features never touch. |
| D4 | **Disputes are invisible to RWA.** Zero references to dispute state in the RWA module. | `rwa.service.ts` | A disputed invoice still pays investors in full on release. Investors carry a risk nobody models. |
| D5 | **No maturity, default, or write-off.** A tokenization can never fail. | `TokenizationStatus` | Every real receivable can go late or bad. Without this there is no risk, so no genuine investment product. |
| D6 | **No secondary transfer.** Explicitly refused. | `rwa.service.ts:278` | Investors cannot exit before maturity. |
| D7 | **Asset valuation is self-asserted.** `valuationAmount` is typed by the issuer with no verification, no document, no lien check. | `AssetDTO` | Anyone can tokenize a $10M invoice that does not exist. This is the fraud surface a real platform exists to close. |
| D8 | **No investor protections at all** — no per-investor cap, no accreditation, no concentration limit, no cooling-off. | RWA module | Regulators require these; their absence is what makes it look like a toy. |

**One-line summary:** the *plumbing* (contracts, ledger, reconciliation, custody
modes) is genuinely well built. The *economics* are missing — nothing charges an
investor, nothing prices risk, and the four domains do not compose.

---

## 1. Domain model corrections (do these first — everything depends on them)

### 1.1 🔴 Make an investor purchase a real financial transaction
- [x] Add `RwaService.purchaseUnits` → `LedgerService.record()` posting:
      debit investor cash clearing, credit issuer proceeds, credit the
      investors' discount as a liability. Posted *before* any units move, so a
      failure hands out no ownership. `recordSubscriptionLedger` in
      `rwa.service.ts`.
- [x] Idempotency: the reference id is
      `rwa-subscription:{tokenizationId}:{investorId}:{units}` — derived from
      what caused the purchase, not a timestamp — so a retried click converges
      on one posting. A lost race recovers the existing id rather than failing.
- [x] Tests: balanced posting asserted via `isBalanced`; the discount split
      checked against exact minor units; separate investors charged separately;
      the audit entry carries the ledger transaction id so the trail leads to
      the money. (4 tests in `rwa.test.ts`.)
- [ ] Reject a purchase when the investor's ledger balance is insufficient.
      Needs per-user ledger accounts, which do not exist yet — every posting
      currently lands on system accounts. Blocked on §4.5.
- [ ] Make the whole purchase atomic: ledger post + holding row + on-chain
      transfer either all succeed or none do. Ordering now favours safety (money
      first, units second), but a chain failure after the posting still leaves a
      paid-for holding that never got its units — which the RWA reconciliation
      job reports rather than hiding.

### 1.2 🔴 Introduce the financing economics

**Model decided (2026-09-03): discount / factoring.** Investors buy a claim
below face value and are repaid at face value on collection; their yield *is*
the discount. Chosen because invoices are the default asset type and the
working-capital problem the PRD describes, and because a single collection
event maps exactly onto the existing escrow-release trigger — no new scheduler.

**Applies to all four asset types.** Commodity, real estate, and other are
tokenized as a single-maturity claim, which is a real structure (a dated
purchase obligation). The recurring-income alternative is deferred to §8.1 and
must not be described as supported until it is built.

Worked example — a 100,000 USDC invoice at net-90, 80% advance, 4% discount,
1% platform fee:

| Step | Amount | Note |
|---|---|---|
| Financed (80% of face) | 80,000 | what investors subscribe |
| Seller receives at funding | 76,800 | financed less the 4% discount |
| **On collection of 100,000** | | |
| 1 — investors | 83,200 | principal 80,000 + 4% yield |
| 2 — platform | 800 | 1% fee |
| 3 — seller residual | 16,000 | the retained 20% first-loss |
| | **100,000** | balanced |

Add to `TokenizationDTO`:
- [x] `faceValueAmount` / `faceValueCurrency` — what the debtor owes at maturity.
- [x] `advanceRateBps` — share of face value financed (8000 = 80%); the
      remainder is the seller's retained first-loss.
- [x] `discountRateBps` — the investor yield.
- [x] `platformFeeBps` — the platform's take.
- [x] `maturityDate` — when collection is due.
- [x] `collectedAt` — when it actually happened, so late yield accrues against
      the real date rather than read-time `now()`.
- [x] Derive `pricePerUnit` from `faceValue × advanceRate ÷ totalUnits`. The
      route no longer accepts a price at all; the server computes it.
- [x] Validation: `0 < advanceRate ≤ 100%`, maturity in the future at creation,
      rates in range, single currency (enforced by a DB check constraint too),
      and a **payability check** — terms whose advance + yield + fee exceed the
      face value are refused at creation, because such a deal is insolvent by
      construction.
- [x] Tests: 40 tests in `rwa.financing.test.ts` covering exact minor-unit
      arithmetic, the rounding direction, and every rejection path.
- [x] Migration `0016` adds the columns, backfills existing rows at a 100%
      advance with zero yield (economically identical to the old model, so no
      existing tokenization changes value), and adds the range/payability
      constraints.
- [x] Frontend: the tokenize form collects face value, advance %, yield % and
      maturity, and shows a live preview of what the issuer actually receives,
      the derived unit price, and the residual — computed with the same
      round-half-up rule the server uses.

### 1.3 🔴 Fix the payout waterfall
Replace "distribute the whole order amount" with an ordered waterfall:
- [x] The arithmetic: `splitCollection` in `rwa.financing.ts` implements the
      strict priority — investors (principal + accrued yield), then the
      platform fee, then the seller's residual.
- [x] Partial collection pays investors as far as it reaches and leaves the
      platform and seller nothing; the unpaid remainder is reported as
      `shortfall`, which is the input to the default path in §1.4.
- [x] Late payment accrues yield per day past maturity, taken from the seller's
      residual rather than the investors' return — lateness costs the seller.
- [x] `proRataShares` distributes a total across holders with a largest-
      remainder method, so the shares sum to *exactly* the total. A ledger
      transaction whose legs miss the total is rejected outright, so
      "close enough" is not available.
- [x] Tests: full, partial, late, zero-residual, and zero-collection cases, each
      asserting the legs reconstitute the collection exactly.
- [x] **Wired into `PaymentService.triggerRwaPayout`.** `distributePayout` now
      runs the collection through `splitCollection` before anyone is paid: only
      `investorTotal` is distributed pro-rata, and the ledger posts three legs
      (investors, platform fee, seller residual) against one debit of what was
      collected. Legs that round to zero are omitted, since the ledger schema
      rejects a zero-amount entry and a partial collection legitimately leaves
      the platform and seller nothing. Defect D2 is closed.
- [x] The on-chain drift check is handed `investorTotal`, not the gross
      collection: the contract knows unit balances, not the waterfall, so
      asking it to split the full amount would have compared our shares against
      a number they were never computed from and failed every payout as drift.
- [x] Note on the denominator: shares are pro-rata of `totalUnits`, so unsold
      units' share of the investor leg is simply not paid. The ledger credits
      the sum of the per-holder records rather than `investorTotal`, so the
      posting still balances exactly against what was collected.
- [x] Tests: the §1.2 worked example end to end (832,000 / 10,000 / 158,000 on
      a 1,000,000 collection), partial collection paying investors only, the
      repaid transition, and a collection too small to pay anyone. (4 tests in
      `rwa.test.ts`.)

### 1.4 🔴 Complete the tokenization lifecycle
- [x] Statuses `Matured`, `Defaulted`, `WrittenOff`, `Repaid` (plus
      `PayoutHeld` for §2.2) were already declared in the shared enum and the
      Postgres type by migration 0016, but nothing in the backend referenced
      them. They are now reachable states rather than documentation.
- [x] `RwaLifecycleJob` (`rwa.lifecycle.job.ts`) moves `Funded` → `Matured` at
      `maturityDate`, following the `ReconciliationJob` start/stop/run shape and
      registered in `app.ts`/`index.ts`. The clock is injected, so tests pin a
      date instead of waiting on timers.
- [x] Grace window, then `Matured` → `Defaulted`. Configurable via
      `RWA_DEFAULT_GRACE_DAYS` (default 30 — a credit-policy decision, not a
      code one). Entering default emits a `warning` alert with counts only, no
      ids or amounts (Rules.md §3).
- [x] `RwaService.writeOffTokenization` distributes recovery pro-rata and closes
      the position. Recovery is split pro-rata *only* — the waterfall's priority
      exists to pay the platform and seller out of a surplus, and a write-off is
      the case where none exists; charging a fee against recovered principal
      would invert the first-loss structure. Operator-initiated, because judging
      a debt unrecoverable is a credit decision, not a timeout.
- [x] Both transitions are idempotent (they select on status + clock), and a
      position with `collectedAt` set is never matured — the payout owns it.
- [x] Both transitions are published on the event spine as
      `tokenization.matured` / `tokenization.defaulted` (§2.3). These types were
      declared in the event vocabulary from the start — §2.3 named
      `tokenization.matured` as a motivating example — and were published by
      nothing, which left the lifecycle as the one domain that changed state
      silently while every other announced its transitions. Payload carries
      dates, the grace window applied, and the linked order id only: no holder
      identities, no amounts (Rules.md §3). A spine failure is logged, not
      thrown — the status change has already committed, and derailing the sweep
      would strand every remaining position in the run.
- [x] Interaction with §2.2 checked: the sweep selects only `Funded`/`Matured`,
      so a position held under `PayoutHeld` for an open dispute is skipped
      rather than maturing underneath the hold.
- [x] Tests: each transition, the grace boundary held and crossed, idempotency,
      a collected position ignored, the refused paths (write-off before default,
      write-off without the compliance role), both events published with the
      right actor and payload, no PII in the payload, exactly one fact per
      transition across repeated sweeps, and the transition still applying when
      the spine is down. (15 tests in `rwa.lifecycle.test.ts`.)

---

## 2. Cross-domain synchronization (the "make it compose" work)

### 2.1 🔴 Link settlement to escrow orders
- [x] `orderId: string | null` on `SettlementDTO`, plus migration `0017`. The
      column carries a FK to `orders` and a **partial** unique index, so the
      ordinary settlement (no order) is unconstrained while a second attempt to
      fund an already-funded order fails at the database rather than on a read.
- [x] `POST /api/settlement` accepts an optional `orderId`; on completion it
      publishes `settlement.completed`, and the `payments.deposit-on-settlement`
      subscriber drives the order's `Deposit`. The buyer pays the corridor once
      instead of paying the corridor and then the escrow.
- [x] The credited amount must equal the order amount **exactly**, checked
      before the first leg runs — a corridor that has already moved money and
      only then discovers it cannot fund the order has left the user paying for
      nothing. Currency mismatch, non-buyer, unknown order, and already-funded
      are all refused at the same point.
- [ ] One ledger transaction spanning both legs. Not done: the settlement legs
      and the escrow deposit still post as separate transactions. Spanning them
      needs a cross-module transaction boundary that does not exist yet, and
      forcing one through the event handler would make the deposit roll back a
      completed corridor payout. Deferred with §4.2/§4.3, where the transaction
      boundary work belongs.
- [x] Tests: the full corridor-funded order (accepted → deposited with no second
      payment), the link recorded both ways, an ordinary orderless settlement
      untouched, and five refusal paths each asserting no settlement was created.
      (8 tests in `settlement-order.test.ts`.)

### 2.2 🔴 Make disputes gate RWA payouts
- [x] `distributePayout` refuses on **two** independent checks: the durable
      `PayoutHeld` status (survives a restart) and a live `DisputeReader` read
      (catches the window where a dispute was filed but its event has not been
      handled). Either alone leaves a gap through which money reaches investors
      who may have to give it back.
- [x] `dispute.opened` flips a linked `Active`/`Funded` tokenization to
      `PayoutHeld`. Notification is left to §3's holder-comms work; the status is
      what the holder sees and what the payout refuses on.
- [x] Resolved for the buyer (refund) → `Defaulted`, which routes into the §1.4
      write-off/recovery path rather than paying a waterfall on money that went
      back to the buyer.
- [x] Resolved for the seller → the hold lifts to `Funded` and the payout
      resumes. Note the real sequence: resolving for the seller auto-executes the
      release, so the position passes through `Funded` and lands on `Repaid` in
      one go — `Funded` is a state it transits, not one it rests in.
- [x] Tests: all three outcomes plus the acceptance condition — a full
      dispute-and-refund cycle distributing **zero** payouts. (7 tests in
      `cross-domain.test.ts`, wired with real services exactly as `app.ts` does.)

### 2.3 🟠 One event spine across the four domains
- [x] `domain_events` (append-only, unique `dedupe_key`) and
      `domain_event_handled` (unique on `(event_id, handler)`) in migration
      `0017`, with in-memory and Postgres repositories. Both idempotency
      guarantees live in the **database**, not a convention: two API instances
      racing the same publish or handler are settled by a unique index, which is
      what Golden Rule #4 actually asks for.
- [x] Event types and dedupe-key construction are centralised in
      `event.types.ts` — a hand-typed event string is a subscriber that silently
      never fires.
- [x] `PaymentService.triggerRwaPayout` is superseded. Payments publishes
      `order.released`; RWA subscribes. Payments no longer imports RWA to react
      to its own state change. The old direct call is retained only as a
      fallback for constructions built without a bus, and is marked deprecated.
- [x] Handlers claim **before** running, retry with exponential backoff, and a
      handler that exhausts its attempts is recorded and counted in
      `domain_event_handlers_total{result="failed"}` rather than thrown back at
      a publisher whose own work already succeeded. The claim-then-run ordering
      is deliberate: between "possibly skipped, visibly" and "possibly
      duplicated, silently", only the first is safe when the handler moves money.
- [x] A durable re-dispatch loop for events whose handler never ran is **not**
      built — that is a queue, and belongs with the infrastructure work. The
      schema is shaped for it (`domain_events` left-joined against
      `domain_event_handled`).
- [x] Tests: the replay guarantee at both levels — a redelivered event runs a
      handler once (12 tests in `event.test.ts`), and a redelivered
      `order.released` distributes exactly one payout through the real wiring
      (`cross-domain.test.ts`).

### 2.4 🟠 Unified position view
- [x] `GET /api/positions` returns the caller's orders, settlements, disputes,
      and holdings, plus a `links` block keyed by order id. The links are the
      point: which settlement funded which order, which tokenizations that
      order's release pays out. Those are joins the client cannot compute from
      the four list endpoints. Caller-scoped with no compliance variant — a
      single endpoint returning any user's whole financial position would be a
      wider grant than any individual domain intends.
- [x] Frontend `LinkedPositions` on the dashboard renders only orders that
      actually reach into another domain; unlinked ones are already in the
      orders table above, and repeating them would bury the linked ones.
- [x] Tests: 4 in `positions.test.ts` covering the link assembly, an unlinked
      order, and per-order isolation when a user holds several.

---

## 3. Making the RWA section a real tokenization product

### 3.1 🔴 Asset verification before tokenization
- [ ] Require ≥1 supporting document reference per asset (invoice PDF, bill of
      lading, appraisal) stored as an opaque reference.
- [ ] Verification workflow: `Unverified → UnderReview → Verified | Rejected`.
      Only a `Verified` asset may be tokenized.
- [ ] Duplicate-asset guard: the same `assetRef` cannot be tokenized twice while
      an active tokenization exists — this is double-pledging, the classic
      invoice-financing fraud.
- [ ] Counterparty (the invoice debtor) recorded and reputation-scored.
- [ ] Tests: unverified asset refused; double-pledge refused.

### 3.2 🟠 Investor protection and compliance
- [ ] Investor must be KYC-verified before any purchase (today it is not
      checked in the RWA path).
- [ ] Per-investor concentration limit (max % of one tokenization).
- [ ] Per-investor exposure cap across all tokenizations.
- [ ] Minimum ticket size and unit granularity.
- [ ] Cooling-off window during which a purchase can be cancelled.
- [ ] Tests for each limit at its boundary.

### 3.3 🟠 Secondary market (replaces the D6 refusal)
- [ ] Allow an existing holder to increase their position.
- [ ] Holder-to-holder transfer at an agreed price, honouring the authorization
      allowlist and the frozen flag.
- [ ] Ledger posts both legs; on-chain transfer follows the custody mode.
- [ ] Tests: transfer to an unauthorized holder refused; frozen token refused.

### 3.4 🟠 Risk surfacing in the UI
- [ ] Every tokenization card shows: advance rate, yield, maturity, days
      remaining, issuer reputation, and dispute state.
- [ ] Explicit risk disclosure before the purchase confirm step.
- [ ] Portfolio shows accrued yield, overdue positions, and realized losses —
      not just "total invested".

---

## 4. Platform-wide industrial concerns

### 4.1 🔴 Cross-instance idempotency (the standing Golden Rule #4 hole)
- [ ] Redis-backed `IdempotencyStore` replacing the in-memory one.
- [ ] Same for the rate limiter so limits are global, not per-process.
- [ ] Documented single-instance constraint removed once done.

### 4.2 🔴 Remaining persistence gaps
- [ ] `PgKycRepository` — KYC state currently dies on restart.
- [ ] `PgReputationRepository` — same.

### 4.3 🟠 Money-safety invariants at the database layer
- [ ] Constraint: `units_sold <= total_units` (exists — verify it survived the
      repair migrations).
- [ ] Constraint: a holding's units cannot exceed the tokenization's supply.
- [ ] Constraint: payout distributions per tokenization cannot exceed collected
      funds.
- [ ] SQL invariant tests in `infra/supabase/tests/` for each.

### 4.4 🟠 Observability that matches the domain
- [ ] Business metrics beside the HTTP ones: total value locked, active
      tokenizations, default rate, average days-to-collect, dispute rate.
- [ ] Alert when default rate or dispute rate crosses a threshold.

### 4.5 🔴 Per-user ledger accounts

Discovered while wiring §1.1. Every ledger posting in the platform lands on
*system* accounts (`rwa_investor_cash_clearing`, `escrow_holding`, …). There is
no per-user account, so there is no such thing as "this investor's balance" to
check against — which is why the insufficient-funds check in §1.1 could not be
written.

This is a structural gap, not an RWA one: the same absence means no user has a
statement, and no balance can be proven without scanning transitions.

- [ ] Per-user ledger accounts keyed on `owner_ref = user:<id>`, created on
      demand per currency (the schema already supports this — `ledger_accounts`
      is unique on `(owner_ref, currency, name)` and `owner_ref` already
      documents `user:<id>` as a valid shape).
- [ ] A balance read that sums entries for an account.
- [ ] Postings that today credit or debit a clearing account move to the user's
      own account where the money is genuinely theirs.
- [ ] Insufficient-funds checks on subscription (§1.1) and any other user-funded
      operation.
- [ ] `GET /api/ledger/balances` so a user can see their own position.
- [ ] Tests: a balance reflects postings; an overdraw is refused.

### 4.6 🟡 Frontend quality
- [ ] Component tests (currently zero) for the purchase flow, the escrow
      transition flow, and the dispute form.
- [ ] Replace the 12s polling with contract-event streaming over SSE.
- [ ] Break up the dense single-line JSX in `RwaConsole.tsx`,
      `EscrowDashboard.tsx`, `KycOnboarding.tsx`.

---

## 5. Sequencing

Do them in this order; later work depends on earlier work.

| Wave | Contents | Why first |
|---|---|---|
| **1** | §1.1, §1.2, §1.3 | Without money movement and correct economics, everything above it is decoration. |
| **2** | §1.4, §2.2, §3.1 | Risk and fraud controls — what makes it a real product rather than a marketplace of assertions. |
| **3** | §2.1, §2.3, §2.4 | Composition across domains. |
| **4** | §3.2, §3.3, §4.1, §4.2, §4.5 | Compliance, liquidity, per-user balances, and the durability gaps. |
| **5** | §3.4, §4.3, §4.4, §4.6 | Surfacing and hardening. |

---

## 6. Definition of done (applies to every box)

- [ ] Input validated at the boundary with a shared schema.
- [ ] Money paths post balanced double-entry ledger entries.
- [ ] Money-mutating endpoints are idempotent.
- [ ] Failures fail closed — never a partial money movement.
- [ ] Covered by a test that runs in CI.
- [ ] `docs/Memory.md` updated (status, decision log, changelog).

---

## 7. Explicitly out of scope

- Becoming a licensed money transmitter or securities broker.
- Real fiat rails beyond the anchor interface already defined.
- Mainnet deployment with real user funds.
- Non-Stellar chains.

> These bound the work. Several items above (accreditation, concentration
> limits) approximate regulatory controls so the architecture is *shaped*
> correctly; they are not legal compliance and must not be described as such.

---

## 8. Deferred options — decided against for now, revisit later

Recorded so the reasoning is not lost and so a later contributor does not
re-litigate a settled decision or, worse, assume these are supported.

### 8.1 🟠 Fixed-coupon / income-share financing model

**Status: deferred 2026-09-03.** Wave 1 implements discount financing only
(§1.2). This is the alternative that was considered and set aside.

**What it is.** Investors hold units earning a stated periodic yield (say 6%
annual, paid quarterly) from an asset that produces recurring income, with no
single maturity and no single collection. Exit happens through redemption or a
secondary sale rather than through collection.

**Why it was not chosen first.** Three reasons, in order of weight:
1. It does not map onto the existing escrow-release trigger. Discount financing
   has exactly one collection event, which is the `Release` transition already
   wired up. A coupon needs a recurring distribution scheduler that does not
   exist.
2. Invoices are the default asset type in the UI and the working-capital
   problem the PRD leads with. Discount financing is the correct model for them.
3. It roughly doubles Wave 1 — two waterfalls, two lifecycles, two triggers —
   before any money moves correctly even once.

**Which assets actually want it.** Real estate (rental income) and some
commodity structures (storage/lease yield). Under the current decision these are
tokenized as a single-maturity claim instead, which is a real structure but not
the most natural one for an income-producing property.

**What building it would take, if revisited:**
- [ ] `financingModel: 'discount' | 'coupon'` discriminator on the tokenization,
      with the terms columns becoming model-specific.
- [ ] `couponRateBps` + `couponPeriod` (monthly / quarterly / annual) +
      `nextCouponDate`.
- [ ] A recurring distribution job — the first genuinely scheduled money
      movement in the platform, so it needs its own idempotency story: a coupon
      period must pay exactly once even if the job runs twice.
- [ ] A separate redemption path so investors can exit without a maturity.
- [ ] A second waterfall: income → platform fee → holders pro-rata, with no
      principal repayment leg.
- [ ] UI that distinguishes the two products, since "yield" means a different
      thing in each and conflating them would mislead an investor.
- [ ] Per-model tests, plus tests that a discount tokenization cannot be paid a
      coupon and vice versa.

**Do not** describe the platform as supporting recurring-income assets until
every box above is ticked.

### 8.2 🟡 Restricting asset types to those the model fits

Also considered: refusing `real_estate` and `other` at tokenization until §8.1
exists. Rejected because it removes two options that work in the UI today for a
theoretical benefit — a dated claim on a property is a legitimate structure, not
a misrepresentation, provided the terms are shown honestly (§3.4).

Revisit if user feedback shows people expect rental-income behaviour from a
real-estate tokenization and are surprised by a maturity date.
