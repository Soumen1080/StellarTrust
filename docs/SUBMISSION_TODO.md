# Submission TODO — what you must do manually

The root `README.md` is written and structured. Everything left is something
only you can produce: a real deployment, real screenshots, real users.

Search the README for `REPLACE_WITH_` to find every placeholder. There are 21.

```bash
grep -n "REPLACE_WITH\|REPLACE_TX" README.md
```

---

## 1. Fill in the placeholders

### Live Demo & Deployment table

| Placeholder | Where to get it |
|---|---|
| ~~`REPLACE_WITH_VERCEL_URL`~~ | ✅ Done — `https://stellar-trust-frontend.vercel.app` |
| `REPLACE_WITH_VIDEO_URL` | YouTube / Loom link (appears twice — table + demo section) |

### On-Chain Deployment table

| Placeholder | Where to get it |
|---|---|
| `REPLACE_WITH_ESCROW_WASM_HASH` | `ESCROW_WASM_HASH` in `backend/.env` |
| `REPLACE_WITH_RWA_WASM_HASH` | `RWA_WASM_HASH` in `backend/.env` |
| `REPLACE_WITH_ESCROW_CONTRACT_ID` | Run a real testnet order, then copy the deployed instance ID |
| `REPLACE_WITH_RWA_CONTRACT_ID` | Same, from a real tokenization |
| `REPLACE_WITH_TX_HASH` | The transaction hash from a real escrow lock or release |

### Monitoring & Analytics table

| Placeholder | Notes |
|---|---|
| `REPLACE_WITH_ANALYTICS_TOOL` / `_LINK` | Requires actually installing analytics first — see step 3 |
| `REPLACE_WITH_ERROR_TOOL` / `_LINK` | Requires installing error tracking — see step 3 |

### User Onboarding & Feedback

| Placeholder | Notes |
|---|---|
| `REPLACE_WITH_USER_COUNT` | Must be 10 or more |
| `REPLACE_WITH_WALLET_1..3` + `REPLACE_TX_1..3` | Extend the table to 10+ rows |
| `REPLACE_WITH_FEEDBACK_METHOD` / `_COUNT` | e.g. "a Google Form" |
| `REPLACE_WITH_POSITIVE_1..2`, `_REQUEST_1..2`, `_CHANGE_1..2` | Real quotes and real changes |

---

## 2. Add the remaining screenshots

**10 of 16 are done** — your existing captures were renamed into
[`docs/screenshots/`](screenshots/) and wired into the README.

Still needed: `cicd-pipeline.png`, `tests-passing.png`, `analytics.png`,
`video-thumbnail.png`, `user-interactions.png`, `feedback.png`.

Exact filenames and capture instructions are in
[`docs/screenshots/README.md`](screenshots/README.md). They render
automatically once the files exist.

Also recommended: delete `docs/Screenshot 2026-08-23 033506.png` — it is a
DevTools capture showing CORS errors and the app failing to fetch.

```bash
git rm "docs/Screenshot 2026-08-23 033506.png"
rm "docs/Screenshot 2026-08-24 005133 copy.png"
```

---

## 3. Build the two things that do not exist yet

These are **real gaps**, not just missing links. Filling in the README rows
without doing the work would be a false claim.

### Analytics + error tracking (Level 4 requirement #20)

Nothing is installed on the frontend today. Pick one of:

- **Vercel Analytics** — easiest if you are already on Vercel:
  `npm i @vercel/analytics`, then add `<Analytics />` to the root layout
- **PostHog** — better for funnels and wallet-connect conversion
- **Sentry** — best for error tracking; covers both frontend and backend

Then screenshot the dashboard with real traffic in it.

### User feedback collection (Level 4 requirement #14)

There is no feedback surface in the app. Cheapest path that satisfies the
requirement: a Google Form linked from a button in the dashboard header.
Better: a small in-app modal that POSTs to a `feedback` table.

---

## 4. Onboard 10+ real users

Each needs a genuine SEP-10 wallet interaction on testnet. Give them funded
testnet accounts so they can complete a real escrow. Record wallet address and
transaction hash per user for the README table.

---

## 5. Housekeeping

### Add a LICENSE file

The README links to one and it does not exist yet. From the repo root:

```bash
# then commit it
```

Use MIT unless you have a reason not to. GitHub can generate it:
**Add file → Create new file → type `LICENSE` → Choose a license template**.

### Remove committed debug files

13 scratch files are tracked in `backend/` and hurt the "project structure"
score:

```bash
git rm --cached backend/_apply_0007.mjs backend/_body.json \
  backend/_diag_dispute_err.mjs backend/_diag_http.mjs backend/_diag_order.mjs \
  backend/_diag_probe_deployed.mjs backend/_diag_schema.mjs backend/_genkey.mjs \
  backend/_mkseller.mjs backend/test-create-order.js backend/test-db-connection.js \
  backend/test-full-order-flow.js backend/tmp-db-check.mjs

printf '\n# local debug scratch\nbackend/_*\nbackend/tmp-*\nbackend/test-*.js\n' >> .gitignore
git add .gitignore && git commit -m "chore: remove local debug scratch files from version control"
```

### Fix the USDC contract ID mismatch

`backend/.env.render.example` line 70 says `CAM2DIT4LPF55FTMA2LXSFI5UXZB75PAKIFC4QMF37XBRRKMJYWWN2LG`
but `docs/testnet-onchain-setup.md` says `CAB4KXQRRX5JJT5MMLSYDAA2WCJ6UKLNOBUZSKJ6MQI2MHZT3E766HQA`.
One is stale. Decide which is correct and make them agree — the README quotes
the docs value.

### Verify the deployment claim

The README says the frontend deploys to Vercel and the backend to Render from
`main`. Confirm both auto-deploy hooks are actually connected — if the backend
is deployed manually, reword that line or wire up the hook.

Note: `.vercel/repo.json` currently points at a Vercel project named
`stellar-trust-backend` mapped to the `backend/` directory, while the live API
is on Render. Make sure the Vercel project linked to this repo is the
**frontend**, or the live demo URL will not be what you expect.

### Confirm the repo is public

Settings → General → Danger Zone → Change visibility.

### Commit the example env files

`backend/.env.render.example` and `frontend/.env.vercel.example` exist locally
but are **not tracked in git**, so the setup instructions in the README will
fail for anyone cloning. Check `.gitignore` is not excluding them, then commit.

---

## 6. Optional but scores well

- **Frontend tests** — there are currently zero. Even 5 component tests with
  Vitest + Testing Library would close a stated requirement.
- **Event streaming** — contracts emit events, but nothing consumes them. An SSE
  endpoint that streams escrow state changes would satisfy the "real-time
  updates" requirement.
- **CD workflow** — deployment is currently manual/platform-triggered. A
  `deploy.yml` that runs on green CI makes the "CI/CD" claim stronger.
