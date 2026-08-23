# Screenshots

Images referenced by the root `README.md`.

## ✅ Already here

| File | Shows | Used in README as |
|---|---|---|
| `landing.png` | Landing page hero, dark theme | Hero image at the top |
| `dashboard.png` | Account dashboard, SEP-10 wallet, recent orders | Account Dashboard |
| `escrow.png` | Escrow workspace, released orders, on-chain hashes, mismatch guard | Escrow Workspace |
| `settlement-completed.png` | Completed INR → USD path payment with rate/fee/slippage | Cross-Border Settlement |
| `settlement-empty.png` | Settlement empty state | Empty & Loading States |
| `rwa.png` | RWA tokenization marketplace with invest flow | RWA Tokenization |
| `wallet-connect.png` | Stellar Wallets Kit modal (Freighter, Albedo, xBull, …) | Wallet Connection |
| `mobile-landing.png` | Landing page at 390×844 | Mobile Responsive |
| `mobile-escrow.png` | Escrow page at 390×844 | Mobile Responsive |
| `lighthouse.png` | Lighthouse 98 / 96 / 100 / 100 on production | Performance |

## ⬜ Still needed

Drop these in with **exactly these filenames** and they render automatically —
no README edits required.

| File | What to capture | How |
|---|---|---|
| `cicd-pipeline.png` | GitHub Actions run with all 5 jobs green | Open the [Actions tab](https://github.com/Soumen1080/StellarTrust/actions), click the latest green run on `main`, screenshot the job list |
| `tests-passing.png` | Terminal showing `197 passed` | `cd backend && npm test` — capture the summary block |
| `analytics.png` | Analytics or error-tracking dashboard with real data | Requires installing analytics first — see `docs/SUBMISSION_TODO.md` |
| `video-thumbnail.png` | Still frame from the demo video | Any clear frame; it becomes the clickable play image |
| `user-interactions.png` | Proof of 10+ wallet interactions | Stellar Expert account/operations view, or your own orders table |
| `feedback.png` | Feedback form or collected responses | Requires building feedback collection first |

### Capturing the test output

```bash
cd backend && npm test
```

Make sure these lines are visible:

```
Test Files  23 passed (23)
     Tests  197 passed (197)
```

### Capturing mobile shots

Chrome DevTools → `Ctrl+Shift+M` → **iPhone 12 Pro** (390×844) → `Ctrl+Shift+P`
→ "Capture screenshot".

> ⚠️ Capture mobile shots against the **production** URL, not localhost — a
> localhost capture can surface CORS errors that make the app look broken.

## 🗑 Not used

`docs/Screenshot 2026-08-23 033506.png` is a DevTools capture showing CORS
failures against the Render API. It is still tracked in git. Recommend deleting
it before submission — it shows the app failing to fetch:

```bash
git rm "docs/Screenshot 2026-08-23 033506.png"
```

There is also an untracked duplicate, `docs/Screenshot 2026-08-24 005133 copy.png`,
safe to delete.
