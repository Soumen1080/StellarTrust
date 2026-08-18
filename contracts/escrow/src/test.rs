#![cfg(test)]
//! Escrow contract tests (run with `cargo test` once the Rust/Soroban toolchain
//! is installed — see contracts/README.md).

use super::*;
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env, String,
};

const ORDER_REF: &str = "8b1f0f2e-0b6e-4a1e-9f6b-1f2a3b4c5d6e";

fn create_token<'a>(
    env: &Env,
    admin: &Address,
) -> (Address, TokenClient<'a>, StellarAssetClient<'a>) {
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let id = sac.address();
    (
        id.clone(),
        TokenClient::new(env, &id),
        StellarAssetClient::new(env, &id),
    )
}

fn setup(env: &Env) -> (EscrowContractClient<'_>, Address, Address, Address, TokenClient<'_>) {
    env.mock_all_auths();

    let admin = Address::generate(env);
    let buyer = Address::generate(env);
    let seller = Address::generate(env);
    let arbiter = Address::generate(env);

    let (token_id, token, token_admin) = create_token(env, &admin);
    token_admin.mint(&buyer, &1_000);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(env, &contract_id);

    client.initialize(
        &buyer,
        &seller,
        &arbiter,
        &token_id,
        &500,
        &String::from_str(env, ORDER_REF),
    );
    (client, buyer, seller, arbiter, token)
}

#[test]
fn initialize_locks_funds() {
    let env = Env::default();
    let (client, buyer, _seller, _arbiter, token) = setup(&env);
    assert_eq!(client.state(), State::Locked);
    assert_eq!(token.balance(&buyer), 500);
    assert_eq!(token.balance(&client.address), 500);
}

#[test]
fn initialize_records_the_order_reference() {
    let env = Env::default();
    let (client, _buyer, _seller, _arbiter, _token) = setup(&env);
    // Reconciliation asserts a contract id really belongs to the order it is
    // recorded against, so the binding has to survive on-chain.
    assert_eq!(client.get().order_ref, String::from_str(&env, ORDER_REF));
}

#[test]
fn arbiter_can_dispute_then_release_an_unconfirmed_escrow() {
    let env = Env::default();
    let (client, _buyer, seller, arbiter, token) = setup(&env);
    // Compliance settlement path: no buyer confirmation, no counterparty
    // cooperation — the arbiter freezes the deal and then resolves it.
    client.dispute(&arbiter);
    assert_eq!(client.state(), State::Disputed);
    client.release();
    assert_eq!(client.state(), State::Released);
    assert_eq!(token.balance(&seller), 500);
}

#[test]
fn dispute_by_a_stranger_fails() {
    let env = Env::default();
    let (client, _buyer, _seller, _arbiter, _token) = setup(&env);
    let stranger = Address::generate(&env);
    assert_eq!(
        client.try_dispute(&stranger),
        Err(Ok(Error::Unauthorized)),
    );
}

#[test]
fn release_pays_seller_after_buyer_confirmation() {
    let env = Env::default();
    let (client, _buyer, seller, _arbiter, token) = setup(&env);
    client.confirm_delivery();
    client.release();
    assert_eq!(client.state(), State::Released);
    assert_eq!(token.balance(&seller), 500);
}

#[test]
fn refund_pays_buyer() {
    let env = Env::default();
    let (client, buyer, _seller, _arbiter, token) = setup(&env);
    client.refund();
    assert_eq!(client.state(), State::Refunded);
    assert_eq!(token.balance(&buyer), 1_000);
}

#[test]
fn dispute_then_release() {
    let env = Env::default();
    let (client, buyer, seller, _arbiter, token) = setup(&env);
    client.dispute(&buyer);
    assert_eq!(client.state(), State::Disputed);
    client.release();
    assert_eq!(token.balance(&seller), 500);
}

#[test]
#[should_panic]
fn double_release_fails() {
    let env = Env::default();
    let (client, _buyer, _seller, _arbiter, _token) = setup(&env);
    client.confirm_delivery();
    client.release();
    // Second release must fail (state is no longer Locked/Disputed).
    client.release();
}


#[test]
#[should_panic]
fn release_without_buyer_confirmation_fails() {
    let env = Env::default();
    let (client, _buyer, _seller, _arbiter, _token) = setup(&env);
    client.release();
}
