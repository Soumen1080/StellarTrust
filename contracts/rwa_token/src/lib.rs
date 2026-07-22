#![no_std]
//! StellarTrust RWA tokenization contract (Phase 5).
//!
//! Opt-in module (NOT part of the escrow happy path — Rules.md §3). An issuer
//! tokenizes a real-world asset into a fixed supply of fractional units;
//! investors hold units; when the buyer pays (off-chain, through escrow), the
//! issuer distributes a payout pro-rata to holders.
//!
//! Phase 5 adds:
//! - Transfer restrictions (frozen state)
//! - Compliance controls (authorized addresses)
//! - Enhanced metadata (asset type, description)
//! - Transfer event logging
//! - Admin operations (freeze/unfreeze)

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, Map, String, Vec};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Meta,
    /// Balances: Address -> units held.
    Balances,
    /// Authorized addresses for compliance (optional whitelist).
    Authorized,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AssetType {
    Invoice,
    Commodity,
    RealEstate,
    Other,
}

#[contracttype]
#[derive(Clone)]
pub struct Meta {
    pub issuer: Address,
    pub asset_ref: String,
    pub asset_type: AssetType,
    pub description: String,
    pub total_units: i128,
    pub distributed: bool,
    pub frozen: bool,
    pub require_authorization: bool,
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
    TransfersFrozen = 7,
    NotAuthorized = 8,
    InvalidAssetType = 9,
}

#[contract]
pub struct RwaTokenContract;

#[contractimpl]
impl RwaTokenContract {
    /// Create the tokenization. The issuer initially holds all units.
    pub fn initialize(
        env: Env,
        issuer: Address,
        asset_ref: String,
        asset_type: AssetType,
        description: String,
        total_units: i128,
        require_authorization: bool,
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

        // If authorization is required, automatically authorize the issuer
        if require_authorization {
            let mut authorized: Map<Address, bool> = Map::new(&env);
            authorized.set(issuer.clone(), true);
            env.storage().instance().set(&DataKey::Authorized, &authorized);
        }

        let meta = Meta {
            issuer,
            asset_ref,
            asset_type,
            description,
            total_units,
            distributed: false,
            frozen: false,
            require_authorization,
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

        let meta = Self::load_meta(&env)?;
        
        // Check if transfers are frozen
        if meta.frozen {
            return Err(Error::TransfersFrozen);
        }

        // Check authorization if required
        if meta.require_authorization {
            Self::check_authorized(&env, &from)?;
            Self::check_authorized(&env, &to)?;
        }

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
        if units == 0 {
            return Ok(0);
        }
        Ok(payout * units / meta.total_units)
    }

    /// Get all payout shares for non-zero holders.
    pub fn all_payout_shares(env: Env, payout: i128) -> Result<Vec<(Address, i128)>, Error> {
        if payout < 0 {
            return Err(Error::InvalidAmount);
        }
        let meta = Self::load_meta(&env)?;
        let balances = Self::balances(&env)?;
        let mut shares = Vec::new(&env);
        
        for (holder, units) in balances.iter() {
            if units > 0 {
                let share = payout * units / meta.total_units;
                shares.push_back((holder, share));
            }
        }
        Ok(shares)
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

    /// Freeze all transfers (compliance control, only issuer).
    pub fn freeze(env: Env) -> Result<(), Error> {
        let mut meta = Self::load_meta(&env)?;
        meta.issuer.require_auth();
        meta.frozen = true;
        env.storage().instance().set(&DataKey::Meta, &meta);
        Ok(())
    }

    /// Unfreeze transfers (only issuer).
    pub fn unfreeze(env: Env) -> Result<(), Error> {
        let mut meta = Self::load_meta(&env)?;
        meta.issuer.require_auth();
        meta.frozen = false;
        env.storage().instance().set(&DataKey::Meta, &meta);
        Ok(())
    }

    /// Authorize an address for transfers (only issuer, only if require_authorization is enabled).
    pub fn authorize(env: Env, address: Address) -> Result<(), Error> {
        let meta = Self::load_meta(&env)?;
        meta.issuer.require_auth();
        if !meta.require_authorization {
            return Ok(()); // No-op if authorization not required
        }
        let mut authorized = Self::authorized(&env);
        authorized.set(address, true);
        env.storage().instance().set(&DataKey::Authorized, &authorized);
        Ok(())
    }

    /// Revoke authorization (only issuer).
    pub fn revoke_authorization(env: Env, address: Address) -> Result<(), Error> {
        let meta = Self::load_meta(&env)?;
        meta.issuer.require_auth();
        if !meta.require_authorization {
            return Ok(()); // No-op if authorization not required
        }
        let mut authorized = Self::authorized(&env);
        authorized.set(address, false);
        env.storage().instance().set(&DataKey::Authorized, &authorized);
        Ok(())
    }

    /// Check if an address is authorized.
    pub fn is_authorized(env: Env, address: Address) -> Result<bool, Error> {
        let meta = Self::load_meta(&env)?;
        if !meta.require_authorization {
            return Ok(true); // Everyone authorized if not required
        }
        Ok(Self::authorized(&env).get(address).unwrap_or(false))
    }

    pub fn get_meta(env: Env) -> Result<Meta, Error> {
        Self::load_meta(&env)
    }

    /// Get list of all holders with non-zero balances.
    pub fn get_holders(env: Env) -> Result<Vec<Address>, Error> {
        let balances = Self::balances(&env)?;
        let mut holders = Vec::new(&env);
        for (addr, balance) in balances.iter() {
            if balance > 0 {
                holders.push_back(addr);
            }
        }
        Ok(holders)
    }

    fn load_meta(env: &Env) -> Result<Meta, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Meta)
            .ok_or(Error::NotInitialized)
    }

    fn balances(env: &Env) -> Result<Map<Address, i128>, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Balances)
            .ok_or(Error::NotInitialized)
    }

    fn authorized(env: &Env) -> Map<Address, bool> {
        env.storage()
            .instance()
            .get(&DataKey::Authorized)
            .unwrap_or(Map::new(env))
    }

    fn check_authorized(env: &Env, address: &Address) -> Result<(), Error> {
        let authorized = Self::authorized(env);
        if !authorized.get(address.clone()).unwrap_or(false) {
            return Err(Error::NotAuthorized);
        }
        Ok(())
    }
}

#[cfg(test)]
mod test;
