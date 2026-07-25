#![no_std]
//! StellarTrust escrow contract (Phase 0 skeleton).
//!
//! Trustless custody for the buyer→seller happy path: funds are locked, then
//! either released to the seller or refunded to the buyer, authorized by a
//! designated `arbiter` (the backend oracle / multi-sig, per Architecture §7).
//!
//! The double-entry ledger in Postgres remains the system of record; this
//! contract is the on-chain custody mechanism that reconciliation asserts
//! against. State transitions here mirror `EscrowState` in @stellartrust/shared:
//! Locked -> Released | Refunded | Disputed.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env,
};

// ── Storage TTL management ──────────────────────────────────────────────────
// Soroban archives contract instance storage once its TTL lapses. An escrow
// holds custody of funds, so its state must not be allowed to expire while a
// deal is in flight. Every state-mutating entry point bumps the instance TTL,
// keeping the entry (and its balance) live for ~30 days past the last activity.
// ~17280 ledgers/day at the 5s close target.
const DAY_IN_LEDGERS: u32 = 17_280;
const INSTANCE_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_LIFETIME_THRESHOLD: u32 = INSTANCE_BUMP_AMOUNT - DAY_IN_LEDGERS;

#[contracttype]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum State {
    Locked,
    Released,
    Refunded,
    Disputed,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Escrow,
}

#[contracttype]
#[derive(Clone)]
pub struct Escrow {
    pub buyer: Address,
    pub seller: Address,
    /// Authorized to release/refund (backend oracle or multi-sig).
    pub arbiter: Address,
    pub token: Address,
    pub amount: i128,
    pub state: State,
    /// Buyer-authenticated delivery confirmation required for happy-path release.
    pub delivery_confirmed: bool,
}

#[contracterror]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidAmount = 3,
    InvalidState = 4,
}

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// Initialize the escrow and pull `amount` from the buyer into the contract.
    /// Requires the buyer's authorization for the token transfer.
    pub fn initialize(
        env: Env,
        buyer: Address,
        seller: Address,
        arbiter: Address,
        token_id: Address,
        amount: i128,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Escrow) {
            return Err(Error::AlreadyInitialized);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        buyer.require_auth();

        // Move funds into the contract's custody.
        let client = token::Client::new(&env, &token_id);
        client.transfer(&buyer, &env.current_contract_address(), &amount);

        let escrow = Escrow {
            buyer,
            seller,
            arbiter,
            token: token_id,
            amount,
            state: State::Locked,
            delivery_confirmed: false,
        };
        env.storage().instance().set(&DataKey::Escrow, &escrow);
        Self::extend_ttl(&env);
        env.events().publish(
            (symbol_short!("lock"),),
            (escrow.buyer.clone(), escrow.seller.clone(), amount),
        );
        Ok(())
    }

    /// Record buyer-authenticated delivery confirmation on-chain.
    pub fn confirm_delivery(env: Env) -> Result<(), Error> {
        let mut escrow = Self::load(&env)?;
        if escrow.state != State::Locked || escrow.delivery_confirmed {
            return Err(Error::InvalidState);
        }
        escrow.buyer.require_auth();
        escrow.delivery_confirmed = true;
        env.storage().instance().set(&DataKey::Escrow, &escrow);
        Self::extend_ttl(&env);
        env.events()
            .publish((symbol_short!("confirm"),), escrow.buyer.clone());
        Ok(())
    }

    /// Release funds to the seller. The arbiter signs the movement, but a
    /// happy-path release also requires the buyer's prior on-chain confirmation.
    /// A disputed escrow follows the separately audited arbiter resolution path.
    pub fn release(env: Env) -> Result<(), Error> {
        let mut escrow = Self::load(&env)?;
        if escrow.state != State::Disputed
            && (escrow.state != State::Locked || !escrow.delivery_confirmed)
        {
            return Err(Error::InvalidState);
        }
        escrow.arbiter.require_auth();

        let client = token::Client::new(&env, &escrow.token);
        client.transfer(
            &env.current_contract_address(),
            &escrow.seller,
            &escrow.amount,
        );

        escrow.state = State::Released;
        env.storage().instance().set(&DataKey::Escrow, &escrow);
        Self::extend_ttl(&env);
        env.events().publish(
            (symbol_short!("release"),),
            (escrow.seller.clone(), escrow.amount),
        );
        Ok(())
    }

    /// Refund locked funds to the buyer. Only the arbiter may authorize.
    pub fn refund(env: Env) -> Result<(), Error> {
        let mut escrow = Self::load(&env)?;
        if escrow.state != State::Locked && escrow.state != State::Disputed {
            return Err(Error::InvalidState);
        }
        escrow.arbiter.require_auth();

        let client = token::Client::new(&env, &escrow.token);
        client.transfer(
            &env.current_contract_address(),
            &escrow.buyer,
            &escrow.amount,
        );

        escrow.state = State::Refunded;
        env.storage().instance().set(&DataKey::Escrow, &escrow);
        Self::extend_ttl(&env);
        env.events().publish(
            (symbol_short!("refund"),),
            (escrow.buyer.clone(), escrow.amount),
        );
        Ok(())
    }

    /// Mark the escrow disputed (opens the evidence window off-chain).
    /// Either the buyer or the seller may raise a dispute.
    pub fn dispute(env: Env, by: Address) -> Result<(), Error> {
        let mut escrow = Self::load(&env)?;
        if escrow.state != State::Locked {
            return Err(Error::InvalidState);
        }
        if by != escrow.buyer && by != escrow.seller {
            return Err(Error::InvalidState);
        }
        by.require_auth();
        escrow.state = State::Disputed;
        env.storage().instance().set(&DataKey::Escrow, &escrow);
        Self::extend_ttl(&env);
        env.events().publish((symbol_short!("dispute"),), by);
        Ok(())
    }

    pub fn state(env: Env) -> Result<State, Error> {
        Ok(Self::load(&env)?.state)
    }

    pub fn get(env: Env) -> Result<Escrow, Error> {
        Self::load(&env)
    }

    fn load(env: &Env) -> Result<Escrow, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Escrow)
            .ok_or(Error::NotInitialized)
    }

    /// Keep the instance entry (and the custodied balance it tracks) from being
    /// archived while a deal is active.
    fn extend_ttl(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    }
}

#[cfg(test)]
mod test;
