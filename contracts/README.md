# StellarTrust Soroban Contracts

Trustless on-chain logic (Rust → WASM):

- `escrow/` — lock / release / refund / dispute custody for the buyer→seller
  happy path. Release/refund are authorized by a designated `arbiter` (the
  backend oracle / multi-sig, per `Architecture.md` §7).
- `rwa_token/` — opt-in RWA tokenization: issuance, fractional transfer, and
  pro-rata payout entitlement. **Not** part of the escrow happy path.

> The double-entry ledger in Postgres remains the system of record. These
> contracts are the on-chain custody/asset mechanism that the reconciliation job
> asserts against (`Rules.md` #1, #7).

## Toolchain

These contracts target **soroban-sdk 27** and require Rust + the Stellar CLI 27
(protocol 23). The Windows machine used for this update cannot compile Soroban
dependencies (a system Application Control policy blocks the freshly-built
proc-macro/build-script binaries), so CI/Linux remains the authoritative
contract test environment.

```bash
# 1. Rust (>= 1.91 for soroban-sdk 27)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32v1-none        # SDK 27 / Stellar CLI 27 build target

# 2. Stellar CLI (Soroban) — v27 to match the SDK
cargo install --locked stellar-cli

# 3. Build + test
cargo test                 # runs unit tests (soroban-sdk testutils)
stellar contract build     # produces optimized WASM in target/wasm32v1-none/
```

## Binding drift

The backend does not use generated bindings. Both gateways cast the SDK's
dynamic `contract.Client` to a hand-written TypeScript interface, so nothing in
`tsc` or `cargo test` notices when a Rust signature changes — the first failure
would be a real transaction rejected at simulation.

`contract-spec.json` closes that gap. It is the function names and argument
lists read out of the built WASM's `contractspecv0` section, and the backend
test `src/modules/stellar/contract-spec.test.ts` asserts the calls its gateways
make against it. CI regenerates and diffs it on every run.

```bash
cargo build --release --target wasm32v1-none
node scripts/check-bindings.mjs            # verify (what CI runs)
node scripts/check-bindings.mjs --write    # accept a deliberate Rust change
```

Changing a contract signature is therefore a three-step, visible edit: change
the Rust, regenerate the manifest, update the TypeScript interface the failing
test names.

## Testnet deploy (manual Phase 2 operation)

The contract code and unit tests are implemented. A real public-testnet deploy
requires a manually created/funded Stellar CLI identity; no secret seed belongs
in this repository.

```powershell
stellar keys generate stellartrust-deployer --network testnet
stellar keys fund stellartrust-deployer --network testnet
.\contracts\scripts\deploy-testnet.ps1 -Source stellartrust-deployer
```

Save the returned **public contract ID** in deployment configuration. Then run
initialize/confirm/release against testnet using buyer, seller, token, and
arbiter test identities before checking off the operational criteria in
`Phases.md`.

### Who the backend can act as

Both contracts gate their privileged entry points with `require_auth()`, and the
server holds one key. Whether that key is the authority is a deployment choice,
and both contracts support either answer.

**Escrow arbiter** — `release` and `refund` call `arbiter.require_auth()`.

| `ESCROW_ARBITER_ADDRESS` | How settlement works |
| --- | --- |
| unset (default) | The server signer is the arbiter. Release and refund are a single server-signed call, and a resolved dispute auto-executes. |
| a separate account | The server cannot sign. Release and refund become `POST /orders/:id/{release,refund}/prepare` → sign → `/submit`, and dispute resolution stops and hands the transaction to the key holders. |

For a multi-sig arbiter, collect signatures on the returned XDR and submit the
fully-signed envelope; Stellar enforces the account's thresholds. The tradeoff
is deliberate — no single compromised process can move custodied funds, and the
cost is that settlement is no longer automatic.

**RWA issuer** — `initialize`, `freeze`, `authorize`, and `mark_distributed`
call `issuer.require_auth()`; `transfer` calls `from.require_auth()`.

| `RWA_CUSTODY` | Who holds the supply |
| --- | --- |
| `platform` (default) | The server signer is the on-chain issuer and holds every unit. One call per operation. Entirely custodial: the issuer in our tables owns nothing on-chain. |
| `issuer` | The issuer's own SEP-10 wallet is the on-chain issuer and holds the supply. Operations go through `POST /rwa/tokenizations/:id/<op>/prepare` → sign → `/submit`. |

Under `issuer`, three things follow from the contract and are handled rather
than hidden: a purchase is a **pending** holding until the issuer signs the
transfer (it earns no payout and is reported as outstanding); compliance cannot
freeze the token on-chain, only platform-side; and the one-shot payout guard is
left for the issuer to arm. Each divergence is surfaced by the RWA
reconciliation job instead of passing silently.

Ask `GET /api/payments/capabilities` and `GET /api/rwa/capabilities` rather than
assuming a mode — both report the signing model per operation.

## Status

Phase 2 contract logic is implemented with lock, buyer-authenticated delivery
confirmation, arbiter-authorized release/refund, dispute handling, and unit
coverage including rejection of release without confirmation. The application
uses a deterministic contract adapter locally. Public-testnet deployment and
smoke verification remain manual because they require funded identities and a
working Stellar CLI/toolchain.

Both contracts now pin **soroban-sdk 27** (the previous 22.0.0 pin no longer
compiles on current Rust — `soroban-env-common` hit an `E0119` trait conflict,
which broke CI and blocked builds). Each state-mutating entry point bumps the
instance-storage TTL so a deployed contract's balances/metadata are not archived
while a deal is active, and emits an event (`lock`/`confirm`/`release`/`refund`/
`dispute` for escrow; `init`/`transfer`/`freeze`/`unfreeze`/`authorize`/`revoke`/
`distrib` for the RWA token) so the reconciliation job can observe on-chain
state transitions.
