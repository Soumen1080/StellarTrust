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
server holds exactly one key. That constrains deployment in ways worth stating
plainly:

- **Escrow arbiter.** `release` and `refund` call `arbiter.require_auth()`, and
  the gateway signs them with the server signer. `ESCROW_ARBITER_ADDRESS` must
  therefore be that signer's account; pointing it at a multi-sig produces
  escrows nobody can settle. The gateway refuses at lock time rather than
  discovering this at release time.
- **RWA issuer.** `initialize` and every admin operation call
  `issuer.require_auth()`, and `transfer` calls `from.require_auth()`. The
  on-chain issuer is therefore the server signer, not the user recorded as
  issuer in the database — a custodial arrangement. The gateway exposes this as
  `custodianAddress()` and refuses calls naming any other address instead of
  silently substituting one.

Both are honest limits of a single-key server signer, not contract bugs. Moving
past them needs a prepare/sign/submit round trip for the account in question.

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
