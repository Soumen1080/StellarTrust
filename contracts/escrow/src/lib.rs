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

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, token, Address, Env};

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
        };
        env.storage().instance().set(&DataKey::Escrow, &escrow);
        Ok(())
    }

    /// Release locked funds to the seller. Only the arbiter may authorize.
    pub fn release(env: Env) -> Result<(), Error> {
        let mut escrow = Self::load(&env)?;
        if escrow.state != State::Locked && escrow.state != State::Disputed {
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
}

#[cfg(test)]
mod test;
