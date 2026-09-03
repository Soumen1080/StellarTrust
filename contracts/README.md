# StellarTrust Soroban Contracts

Trustless on-chain logic (Rust → WASM):

- `escrow/` — lock / confirm / release / refund / dispute custody for the
  buyer→seller path. One instance is deployed **per order**, so each order has
  isolated custody. Release and refund are authorized by a designated `arbiter`.
- `rwa_token/` — opt-in RWA tokenization: issuance, fractional transfer,
  allowlist and freeze controls, and pro-rata payout entitlement. **Not** part of
  the escrow happy path.

> The double-entry ledger in Postgres remains the system of record. These
> contracts are the on-chain custody/asset mechanism that the reconciliation job
> asserts against (`Rules.md` #1, #7).

## Toolchain

Both contracts pin **soroban-sdk 27.0.2** and require Rust ≥ 1.91 plus the
Stellar CLI 27 (protocol 23).

```bash
# 1. Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32v1-none        # SDK 27 / Stellar CLI 27 build target

# 2. Stellar CLI (Soroban) — v27 to match the SDK
cargo install --locked stellar-cli

# 3. Build + test
cargo test                 # 27 unit tests (soroban-sdk testutils)
stellar contract build     # optimized WASM in target/wasm32v1-none/
```

Test coverage: **9 escrow + 18 rwa_token = 27 passing.**

## Escrow contract

| Function | Auth | Description |
|---|---|---|
| `initialize(...)` | deployer | Sets buyer, seller, arbiter, token, amount, deadline; pulls funds into custody |
| `confirm_delivery()` | buyer | Buyer confirms goods received |
| `release()` | arbiter | Transfers escrowed funds to the seller |
| `refund()` | arbiter | Returns escrowed funds to the buyer |
| `dispute(by)` | buyer or seller | Moves the escrow into a disputed state |
| `state()` | public | Current lifecycle state |
| `get()` | public | Full escrow record |

Value moves by calling into the **SEP-41 token interface** (`token::Client`) of
the asset's Stellar Asset Contract — a real cross-contract invocation.

Release without buyer confirmation is rejected, double release is rejected, and
a dispute raised by anyone other than the two counterparties is rejected. Each is
covered by a test.

## RWA token contract

| Function | Description |
|---|---|
| `initialize(...)` | Creates the tokenized asset; the issuer holds all units initially |
| `transfer(from, to, units)` | Moves units between authorized holders |
| `balance_of(holder)` | Units held by an address |
| `payout_share(holder, payout)` | Pro-rata share of a payout for one holder |
| `all_payout_shares(payout)` | Full pro-rata distribution table |
| `mark_distributed()` | One-shot guard recording that a payout was distributed |
| `freeze()` / `unfreeze()` | Issuer-level transfer controls |
| `authorize(addr)` / `revoke_authorization(addr)` | Allowlist management |
| `is_authorized(addr)` | Allowlist check |
| `get_meta()` / `get_holders()` | Asset metadata and holder registry |

## Events

Both contracts emit **Protocol 23 typed events** (`#[contractevent]`), migrated
from the deprecated `env.events().publish(...)` API with topic symbols and data
payloads preserved.

| Contract | Topic | Data |
|---|---|---|
| escrow | `lock` | `[buyer, seller, amount]` |
| escrow | `confirm` | `buyer` |
| escrow | `release` | `[seller, amount]` |
| escrow | `refund` | `[buyer, amount]` |
| escrow | `dispute` | the disputing party |
| rwa_token | `init` | `[issuer, total_units]` |
| rwa_token | `transfer` (topics: `transfer, from, to`) | `units` |
| rwa_token | `freeze` / `unfreeze` | — |
| rwa_token | `authorize` / `revoke` | address |
| rwa_token | `distrib` | — |

Every state-mutating entry point also bumps the instance-storage TTL, so a
deployed contract's balances and metadata are not archived while a deal is
active.

## Binding drift

The backend does not use generated bindings. Both gateways cast the SDK's
dynamic `contract.Client` to a hand-written TypeScript interface, so neither
`tsc` nor `cargo test` notices when a Rust signature changes — the first failure
would be a real transaction rejected at simulation.

`contract-spec.json` closes that gap. It holds the function names and argument
lists read out of the built WASM's `contractspecv0` section, and the backend test
`src/modules/stellar/contract-spec.test.ts` (20 tests) asserts the calls its
gateways make against it. CI regenerates and diffs it on every run.

```bash
cargo build --release --target wasm32v1-none
node scripts/check-bindings.mjs            # verify (what CI runs)
node scripts/check-bindings.mjs --write    # accept a deliberate Rust change
```

Changing a contract signature is therefore a three-step, visible edit: change the
Rust, regenerate the manifest, update the TypeScript interface the failing test
names.

## Testnet deploy

No secret seed belongs in this repository; deploying needs a manually created and
funded Stellar CLI identity.

```powershell
# provision identities, funded accounts, and the test asset
.\contracts\scripts\setup-testnet.ps1

# build + install both WASMs, printing their hashes
.\contracts\scripts\deploy-testnet.ps1 -Source stellartrust-arbiter
```

Copy the printed hashes into `ESCROW_WASM_HASH` and `RWA_WASM_HASH` in the
backend environment. The backend deploys a fresh contract *instance* from those
hashes per order and per tokenization, so there is no single long-lived contract
ID to record.

Then confirm the deployment is actually wired up:

```bash
cd backend && npm run chain:preflight
```

Full walkthrough: [`docs/testnet-onchain-setup.md`](../docs/testnet-onchain-setup.md).

## Who the backend can act as

Both contracts gate their privileged entry points with `require_auth()`, and the
server holds one key. Whether that key is the authority is a deployment choice,
and both contracts support either answer.

**Escrow arbiter** — `release` and `refund` call `arbiter.require_auth()`.

| `ESCROW_ARBITER_ADDRESS` | How settlement works |
| --- | --- |
| unset (default) | The server signer is the arbiter. Release and refund are a single server-signed call, and a resolved dispute auto-executes. |
| a separate account | The server cannot sign. Release and refund become `POST /orders/:id/{release,refund}/prepare` → sign → `/submit`, and dispute resolution stops and hands the transaction to the key holders. |

For a multi-sig arbiter, collect signatures on the returned XDR and submit the
fully-signed envelope; Stellar enforces the account's thresholds. The tradeoff is
deliberate — no single compromised process can move custodied funds, and the cost
is that settlement is no longer automatic.

**RWA issuer** — `initialize`, `freeze`, `authorize`, and `mark_distributed` call
`issuer.require_auth()`; `transfer` calls `from.require_auth()`.

| `RWA_CUSTODY` | Who holds the supply |
| --- | --- |
| `platform` (default) | The server signer is the on-chain issuer and holds every unit. One call per operation. Entirely custodial: the issuer in our tables owns nothing on-chain. |
| `issuer` | The issuer's own SEP-10 wallet is the on-chain issuer and holds the supply. Operations go through `POST /rwa/tokenizations/:id/<op>/prepare` → sign → `/submit`. |

Under `issuer`, three things follow from the contract and are handled rather than
hidden: a purchase is a **pending** holding until the issuer signs the transfer
(it earns no payout and is reported as outstanding); compliance cannot freeze the
token on-chain, only platform-side; and the one-shot payout guard is left for the
issuer to arm. Each divergence is surfaced by the RWA reconciliation job instead
of passing silently.

Ask `GET /api/payments/capabilities` and `GET /api/rwa/capabilities` rather than
assuming a mode — both report the signing model per operation.

## Windows note

The Windows machine used during development cannot compile Soroban dependencies
when an Application Control policy blocks freshly-built proc-macro/build-script
binaries. CI (Linux) is the authoritative contract test environment when that
applies.
