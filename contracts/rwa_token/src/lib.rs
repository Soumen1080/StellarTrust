#![no_std]
//! StellarTrust RWA tokenization contract (Phase 0 skeleton).
//!
//! Opt-in module (NOT part of the escrow happy path — Rules.md §3). An issuer
//! tokenizes a real-world asset into a fixed supply of fractional units;
//! investors hold units; when the buyer pays (off-chain, through escrow), the
//! issuer distributes a payout pro-rata to holders.
//!
//! Full issuance/transfer-rule richness (SEP-8 style compliance controls) is
//! deferred to Phase 5; this skeleton establishes the storage model + core ops.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, Env, Map,
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Meta,
    /// Balances: Address -> units held.
    Balances,
}

#[contracttype]
#[derive(Clone)]
pub struct Meta {
    pub issuer: Address,
    pub asset_ref: soroban_sdk::String,
    pub total_units: i128,
    pub distributed: bool,
}

#[contracterror]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidAmount = 3,
    InsufficientUnits = 4,
    Unauthorized = 5,
    AlreadyDistributed = 6,
}

#[contract]
pub struct RwaTokenContract;

#[contractimpl]
impl RwaTokenContract {
    /// Create the tokenization. The issuer initially holds all units.
    pub fn initialize(
        env: Env,
        issuer: Address,
        asset_ref: soroban_sdk::String,
        total_units: i128,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Meta) {
            return Err(Error::AlreadyInitialized);
        }
        if total_units <= 0 {
            return Err(Error::InvalidAmount);
        }
        issuer.require_auth();

        let mut balances: Map<Address, i128> = Map::new(&env);
        balances.set(issuer.clone(), total_units);

        let meta = Meta {
            issuer,
            asset_ref,
            total_units,
            distributed: false,
        };
        env.storage().instance().set(&DataKey::Meta, &meta);
        env.storage().instance().set(&DataKey::Balances, &balances);
        Ok(())
    }

    /// Transfer units (e.g. issuer -> investor on purchase, or investor resale).
    pub fn transfer(env: Env, from: Address, to: Address, units: i128) -> Result<(), Error> {
        if units <= 0 {
            return Err(Error::InvalidAmount);
        }
        from.require_auth();

        let mut balances = Self::balances(&env)?;
        let from_bal = balances.get(from.clone()).unwrap_or(0);
        if from_bal < units {
            return Err(Error::InsufficientUnits);
        }
        balances.set(from.clone(), from_bal - units);
        let to_bal = balances.get(to.clone()).unwrap_or(0);
        balances.set(to, to_bal + units);
        env.storage().instance().set(&DataKey::Balances, &balances);
        Ok(())
    }

    pub fn balance_of(env: Env, holder: Address) -> Result<i128, Error> {
        Ok(Self::balances(&env)?.get(holder).unwrap_or(0))
    }

    /// Compute a holder's pro-rata share of a payout amount.
    /// Distribution of actual funds is orchestrated off-chain via the ledger;
    /// this returns the entitlement so the backend can post balanced entries.
    pub fn payout_share(env: Env, holder: Address, payout: i128) -> Result<i128, Error> {
        if payout < 0 {
            return Err(Error::InvalidAmount);
        }
        let meta = Self::load_meta(&env)?;
        let units = Self::balances(&env)?.get(holder).unwrap_or(0);
        Ok(payout * units / meta.total_units)
    }

    /// Mark the payout as distributed (idempotency guard; only issuer).
    pub fn mark_distributed(env: Env) -> Result<(), Error> {
        let mut meta = Self::load_meta(&env)?;
        meta.issuer.require_auth();
        if meta.distributed {
            return Err(Error::AlreadyDistributed);
        }
        meta.distributed = true;
        env.storage().instance().set(&DataKey::Meta, &meta);
        Ok(())
    }

    pub fn get_meta(env: Env) -> Result<Meta, Error> {
        Self::load_meta(&env)
    }

    fn load_meta(env: &Env) -> Result<Meta, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Meta)
            .ok_or(Error::NotInitialized)
    }
        env.storage()
            .instance()
            .get(&DataKey::Balances)
            .ok_or(Error::NotInitialized)
    }
}

#[cfg(test)]
mod test;
