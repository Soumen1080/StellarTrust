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

These contracts are **not** built by the Node/Python CI jobs. They require the
Rust + Soroban toolchain:

```bash
# 1. Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown       # or wasm32v1-none for newer SDKs

# 2. Stellar CLI (Soroban)
cargo install --locked stellar-cli

# 3. Build + test
cargo test                 # runs unit tests (soroban-sdk testutils)
stellar contract build     # produces optimized WASM in target/
```

## Testnet deploy (Phase 2 wires these into the backend)

```bash
stellar keys generate deployer --network testnet
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/escrow.wasm \
  --source deployer --network testnet
```

## Status

Phase 0 skeletons with unit tests. **Not compiled/tested in this environment**
(Rust toolchain unavailable / blocked here). Build + `cargo test` must run in a
Rust-enabled environment or a dedicated CI job before Phase 2 integration.
