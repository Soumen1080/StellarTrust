# Screenshots

Images referenced by the root [`README.md`](../../README.md). Filenames are
load-bearing — the README links them by exact name, so a new capture replaces a
file in place rather than arriving under a new name.

## Present

| File | Shows | Used in README as |
|---|---|---|
| `landing.png` | Landing hero, dark theme | Hero image at the top |
| `dashboard.png` | Account dashboard, SEP-10 wallet, recent orders | Account Dashboard |
| `escrow.png` | Escrow workspace, released orders, on-chain hashes, mismatch guard | Escrow Workspace |
| `settlement-completed.png` | Completed INR → USD path payment with rate/fee/slippage | Cross-Border Settlement |
| `settlement-empty.png` | Settlement empty state | Empty & Loading States |
| `rwa.png` | RWA tokenization marketplace with invest flow | RWA Tokenization |
| `wallet-connect.png` | Stellar Wallets Kit modal (Freighter, Albedo, xBull, …) | Wallet Connection |
| `mobile-landing.png` | Landing page at 390×844 | Mobile Responsive |
| `mobile-escrow.png` | Escrow page at 390×844 | Mobile Responsive |
| `lighthouse.png` | Lighthouse 98 / 96 / 100 / 100 on production | Performance |
| `ciCD.png` | GitHub Actions run, all jobs green | CI/CD Pipeline |

## Still needed

Drop these in with **exactly these filenames** and they render automatically —
no README edits required.

| File | What to capture | How |
|---|---|---|
| `user-interactions.png` | Proof of 10+ wallet interactions | Stellar Expert account/operations view, or the orders table filtered to real testnet runs |

The README's test-output and analytics evidence are pasted terminal captures
rather than images, so no `tests-passing.png` or `analytics.png` is required.

### Capturing the test output

```bash
cd backend && npm test
```

The summary block is the part worth capturing:

```
Test Files  26 passed (26)
     Tests  257 passed (257)
```

### Capturing mobile shots

Chrome DevTools → `Ctrl+Shift+M` → **iPhone 12 Pro** (390×844) → `Ctrl+Shift+P`
→ "Capture screenshot".

> Capture mobile shots against the **production** URL, not localhost — a
> localhost capture can surface CORS errors that make the app look broken.

## Loose captures in `docs/`

`docs/Screenshot 2026-08-23 033506.png` is a DevTools capture showing CORS
failures against the Render API, and is still tracked in git. It shows the app
failing to fetch and is referenced by nothing:

```bash
git rm "docs/Screenshot 2026-08-23 033506.png"
```

There is also an untracked duplicate, `docs/Screenshot 2026-08-24 005133 copy.png`,
safe to delete.
