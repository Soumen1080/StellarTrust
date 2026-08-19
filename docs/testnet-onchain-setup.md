# Testnet on-chain escrow setup

How to take escrow from the in-memory simulator to real value moving on Stellar
testnet, and how to tell the difference.

## What changes

`ESCROW_GATEWAY` picks between two adapters behind one interface:

| | `deterministic` | `soroban-rpc` |
|---|---|---|
| Where escrow state lives | process memory | a Soroban contract, one instance per order |
| What a "transaction hash" is | `sha256(orderId:transition:uuid)` | a real ledger transaction |
| Who signs `lock` / `confirm` / `dispute` | nobody | the counterparty's wallet, in the browser |
| Who signs `release` / `refund` | nobody | the arbiter (this server by default) |
| Does 10 USDC move | no | yes |

Both enforce the same state machine, which is the point: a green test suite
against the deterministic adapter says something real about the deployed
contract. What it cannot say is whether *this deployment* is wired up — that is
what `npm run chain:preflight` is for.

## Current testnet provisioning

Already done, by `contracts/scripts/setup-testnet.ps1`:

| Role | Identity | Address |
|---|---|---|
| Arbiter / backend signer | `stellartrust-arbiter` | `GCD32N3MW23NYDOYNQ4OX5STW6COAQX3M5PN3BVV36SVHMUCKENRJW7I` |
| Test USDC issuer | `stellartrust-issuer` | `GC53S46OCINPU3WM5XNPMJUQED6ASJHSZ2X5TPNZZ6JPFL27OMIRZ6XQ` |
| Test buyer (5000 USDC) | `stellartrust-buyer` | `GDBTAOXNVMJKYCYTELDMIMHD6LRES7V46I52XJS2Y775RSL3OE5GHV7I` |
| Test seller (trustline only) | `stellartrust-seller` | `GBLQNLFMG6E7J56EPYRHQBMK7N7BNRHPS4UBJKRRPPMGVHR6GATTAV77` |

The USDC Stellar Asset Contract is
`CAB4KXQRRX5JJT5MMLSYDAA2WCJ6UKLNOBUZSKJ6MQI2MHZT3E766HQA`, wrapping
`USDC:GC53S46O…`. It reports 7 decimals, which is what `backend/.env` records.

This is a **test asset we issue ourselves**, not Circle's testnet USDC. That
means we can mint to any test account on demand instead of queueing at a faucet.
Nothing in the code inspects the issuer — `resolveToken` matches on contract id
and decimals only.

### Why not reuse `rwa_token`?

The escrow contract moves value through `token::Client`, which requires the
SEP-41 interface (`transfer`, `balance`, `decimals`). `rwa_token` exposes
`balance_of` and counts `units`, so it cannot be driven that way. A classic
asset wrapped as a SAC is the supported path.

## Remaining step: upload the contract WASM

```powershell
./contracts/scripts/deploy-testnet.ps1 -Source stellartrust-arbiter
```

Copy the `ESCROW_WASM_HASH` it prints into `backend/.env`. The backend deploys
one custody instance per order from this hash, so it needs the *hash*, not a
contract id — installing once and deploying many instances is both cheaper and
what the gateway is written against.

Until that value is set, the backend **will not boot** while
`ESCROW_GATEWAY=soroban-rpc`. That is deliberate: a gateway that cannot deploy
fails at the first `lock`, after a buyer has already signed. To keep working in
the meantime, set `ESCROW_GATEWAY=deterministic` and it boots as before.

## Verify before the first order

```powershell
npm run chain:preflight --prefix backend
```

Read-only — it simulates and reads ledger entries, submitting nothing. It asks
the network the questions config validation cannot:

- Is the RPC serving the same network `STELLAR_NETWORK` claims? A mismatch makes
  every signature invalid.
- Does the signing account exist, and can it afford deploys?
- Is `ESCROW_WASM_HASH` actually installed on-chain?
- Does each token contract exist, and does its `decimals()` match the config?
  A binding claiming 7 against a token reporting 2 would lock 10⁵ times the
  intended value.

Expected output once the WASM hash is in place:

```
  [PASS] escrow gateway: soroban-rpc (transactions settle on-chain)
  [PASS] soroban rpc: reachable, passphrase matches testnet
  [PASS] signer: signs as GCD32N3M…
  [PASS] signer funding: 10000.0000000 XLM
  [PASS] arbiter: this server (GCD32N3M…) — release/refund are server-signed
  [PASS] escrow wasm: installed on-chain (… bytes)
  [PASS] token USDC: CAB4KXQR… reports 7 decimals, as configured
```

## Onboarding a wallet

Both counterparties need setting up, and they need different things.

The **buyer** is the transaction source for `initialize`: it pays its own fees
and must hold the asset. The **seller** never signs, but `release` transfers to
its account — and a classic asset cannot land in an account with no trustline.
A seller without one turns a release into an on-chain failure *after* the
buyer's funds are already in custody.

```powershell
# A Stellar CLI identity — created, funded, trustline added automatically.
./contracts/scripts/fund-wallet.ps1 -Identity my-tester -Usdc 1000

# A wallet you hold in Freighter.
./contracts/scripts/fund-wallet.ps1 -Address GABC... -Usdc 1000

# A seller needs the trustline, not a balance.
./contracts/scripts/fund-wallet.ps1 -Identity my-seller -Usdc 0
```

Trustlines are authorized by the account itself, so for a Freighter wallet the
script cannot add one. It detects the gap and prints the code and issuer to
enter under *Manage Assets → Add asset*; rerun it afterwards to receive the
balance.

## Signing in

Buyer and seller must each sign in with the wallet they will settle with.
`IdentityWalletAddressResolver` maps a user id to the account proved via SEP-10
— never a client-supplied address, which would let a caller redirect custody to
an account they chose. No connected wallet means a `409` at lock time, not a
silent fallback.

`AUTH_DEMO_WALLET` is left unset in `backend/.env`. The placeholder that used to
sit there was not a valid Ed25519 address, so config validation rejected it and
the backend could not boot at all. It also matters for on-chain escrow: the dev
bypass maps every request to that address, and a made-up account has no XLM and
no trustline. To use the bypass on-chain, set it to a real testnet account you
can also sign with in Freighter, then run `fund-wallet.ps1` against it.

## Proving it actually moved

Run one order through: create → accept → lock → confirm → release. Then check
the chain rather than the UI:

1. Look the lock transaction hash up on a testnet explorer. Under the
   deterministic gateway it resolves to nothing; a real one resolves.
2. Buyer's USDC balance drops by 10 after lock; seller's rises by 10 after
   release.
3. In between, the deployed escrow contract holds the 10.

Then let the reconciliation job run. It reads live custody and compares state
*and* value against the books, so a clean pass is real evidence — under the
deterministic gateway it was comparing the simulator against itself.

Also worth exercising: `refund` pays the buyer back, and an arbiter `release`
requires moving the escrow to `Disputed` first. Arbiter authority alone is not
sufficient, by design.

## Notes

- **Amount scaling is handled.** The ledger records USDC at 2dp, the SAC uses 7,
  and `toTokenAmount` shifts by exactly 10⁵. 10 USDC = `"1000"` minor units →
  `100000000` on-chain. Do not "fix" this by setting `decimals: 2`.
- **Value mismatches fail closed.** `assertCustodyValueMatches` compares what
  custody holds against what the transition claims, so a wrong contract id or
  decimals throws instead of mis-settling.
- **Prepared transactions expire in 300s.** Slow wallet interaction means
  re-preparing, not a stuck order.
- **"Contract not found" and "RPC is down" are distinguished** on purpose. If
  reconciliation throws during testnet RPC flakiness, that is the guard working:
  an outage is not evidence about custody.
- **`DEMO_SIGNER_SECRET` is a testnet key.** It belongs in `backend/.env`
  (gitignored) and nowhere else. Production signing goes through the KMS
  boundary; the demo signer refuses to sign on the public network.
