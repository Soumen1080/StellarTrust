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

These contracts require Rust + the Stellar CLI. The Windows machine used for
this update cannot compile Soroban dependencies reliably, so CI/Linux remains
the authoritative contract test environment.

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

## Status

Phase 2 contract logic is implemented with lock, buyer-authenticated delivery
confirmation, arbiter-authorized release/refund, dispute handling, and unit
coverage including rejection of release without confirmation. The application
uses a deterministic contract adapter locally. Public-testnet deployment and
smoke verification remain manual because they require funded identities and a
working Stellar CLI/toolchain.
