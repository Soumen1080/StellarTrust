# Submission TODO — what is left, and who can do it

The root [`README.md`](../README.md) is written and structured. What remains is
work only a human with a funded testnet account and real users can produce: live
contract instances, real wallet interactions, and real feedback.

**Last verified:** 2026-09-03, against the repository tree and a full local run
of `vitest run`, `cargo test`, and `tsc --noEmit`.

Find every remaining placeholder:

```bash
grep -n "REPLACE_WITH\|REPLACE_TX" README.md    # 14 lines, 17 distinct tokens
```

---

## 1. Fill in the placeholders

### On-Chain Deployment table

Both WASM hashes and both asset contract IDs are already filled from the backend
environment. What is missing is *runtime* output — a fresh escrow instance is
deployed per order, so these cannot come from `.env`.

| Placeholder | Where to get it |
|---|---|
| `REPLACE_WITH_ESCROW_CONTRACT_ID` | Run a real testnet order with `ESCROW_GATEWAY=soroban-rpc`, then copy the deployed instance ID |
| `REPLACE_WITH_RWA_CONTRACT_ID` | Same, from a real tokenization deploy |
| `REPLACE_WITH_TX_HASH` | The transaction hash from a real escrow lock or release |

Confirm which mode you are actually in before capturing anything:

```bash
cd backend && npm run chain:preflight
```

### User Onboarding & Feedback

| Placeholder | Notes |
|---|---|
| `REPLACE_WITH_USER_COUNT` | Must be 10 or more |
| `REPLACE_WITH_WALLET_1..3` + `REPLACE_TX_1..3` | Extend the table to 10+ rows |
| `REPLACE_WITH_FEEDBACK_COUNT` | Count of responses actually received |
| `REPLACE_WITH_POSITIVE_1..2`, `_REQUEST_1..2`, `_CHANGE_1..2` | Real quotes and real changes |

The in-app feedback wall is built and live (see §3), so the response count can
come from the product itself rather than only the Google Form.

---

## 2. Add the remaining screenshot

11 of 12 referenced captures are in [`docs/screenshots/`](screenshots/). Only
`user-interactions.png` is still missing — proof of 10+ wallet interactions,
from Stellar Expert or the orders table.

Exact filenames and capture instructions live in
[`docs/screenshots/README.md`](screenshots/README.md). Files render automatically
once they exist.

---

## 3. Built since the last revision of this file

Two items previously listed as real gaps now exist in the codebase:

- **User feedback collection** — a full in-app feedback wall, not a form link.
  Backend module at [`backend/src/modules/feedback/`](../backend/src/modules/feedback/)
  (`GET /api/feedback`, `GET /api/feedback/me`, `POST /api/feedback`), table
  `product_feedback` from migration `0013`, RLS added in a later commit to protect
  contact PII, and the UI at
  [`frontend/src/features/feedback/`](../frontend/src/features/feedback/). Contact
  fields (email, wallet) are stored and never returned; one entry per account.
- **CI screenshot** — `docs/screenshots/ciCD.png` is captured and wired in.

**Analytics and error tracking** remain unaddressed by a third-party SDK, and
this is deliberate: `/metrics` exposes Prometheus counters and latency
histograms per route, `/health/ready` reports reconciliation drift, and Pino logs
carry request IDs. The README documents this as the analytics story rather than
claiming a dashboard that is not installed. If a hosted dashboard is wanted,
Vercel Analytics or PostHog on the frontend is the smallest addition.

---

## 4. Onboard 10+ real users

Each needs a genuine SEP-10 wallet interaction on testnet. Give them funded
testnet accounts so they can complete a real escrow. Record wallet address and
transaction hash per user for the README table.

---

## 5. Housekeeping

### Add a LICENSE file

The README links to `LICENSE` and states MIT; **the file does not exist**. Until
it does, the license claim is unbacked. GitHub can generate one:
**Add file → Create new file → type `LICENSE` → Choose a license template**.

### Commit the example env files

The README's setup steps say to copy `backend/.env.render.example` and
`frontend/.env.vercel.example`. **Neither file exists in the working tree**, so
those instructions currently fail for anyone cloning. Note that `.gitignore`
ends with a blanket `.env*` rule that overrides the earlier `!.env.example`
negation — fix the ignore rule before trying to commit them, or the add will be
silently refused.

Only `ai/.env.example` and `infra/.env.example` exist today.

### Remove committed debug scratch files

13 scratch files are tracked in `backend/`:

```bash
git rm --cached backend/_apply_0007.mjs backend/_body.json \
  backend/_diag_dispute_err.mjs backend/_diag_http.mjs backend/_diag_order.mjs \
  backend/_diag_probe_deployed.mjs backend/_diag_schema.mjs backend/_genkey.mjs \
  backend/_mkseller.mjs backend/test-create-order.js backend/test-db-connection.js \
  backend/test-full-order-flow.js backend/tmp-db-check.mjs

printf '\n# local debug scratch\nbackend/_*\nbackend/tmp-*\nbackend/test-*.js\n' >> .gitignore
git add .gitignore && git commit -m "chore: remove local debug scratch files from version control"
```

### Reconcile the USDC contract ID

The README and [`docs/testnet-onchain-setup.md`](testnet-onchain-setup.md) must
name the same USDC Stellar Asset Contract. Decide which is current and make every
document agree; the value is deployment configuration read from
`STELLAR_TOKEN_CONTRACTS`, so the environment is the tiebreaker.

### Verify the deployment claim

The README says the frontend deploys to Vercel and the backend to Render from
`main`. Confirm both auto-deploy hooks are connected — if the backend is deployed
manually, reword that line.

Check that the Vercel project linked to this repo is the **frontend**, not a
stale `stellar-trust-backend` project mapped to `backend/`, or the live demo URL
will not be what you expect.

### Confirm the repo is public

Settings → General → Danger Zone → Change visibility.

---

## 6. Optional but scores well

- **Frontend tests** — there are currently zero. Even five component tests with
  Vitest + Testing Library would close a stated requirement. The backend has 257.
- **Event streaming** — both contracts emit events, but nothing consumes them. An
  SSE endpoint streaming escrow state changes would satisfy "real-time updates".
- **CD workflow** — deployment is platform-triggered. A `deploy.yml` gated on
  green CI would make the CI/CD claim stronger.
