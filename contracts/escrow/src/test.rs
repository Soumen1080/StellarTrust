#![cfg(test)]
//! Escrow contract tests (run with `cargo test` once the Rust/Soroban toolchain
//! is installed — see contracts/README.md).

use super::*;
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env,
};

fn create_token<'a>(env: &Env, admin: &Address) -> (Address, TokenClient<'a>, StellarAssetClient<'a>) {
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let id = sac.address();
    (
        id.clone(),
        TokenClient::new(env, &id),
        StellarAssetClient::new(env, &id),
    )
}

fn setup(env: &Env) -> (EscrowContractClient, Address, Address, Address, TokenClient) {
    env.mock_all_auths();

    let admin = Address::generate(env);
    let buyer = Address::generate(env);
    let seller = Address::generate(env);
    let arbiter = Address::generate(env);

    let (token_id, token, token_admin) = create_token(env, &admin);
    token_admin.mint(&buyer, &1_000);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(env, &contract_id);

    client.initialize(&buyer, &seller, &arbiter, &token_id, &500);
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
fn release_pays_seller() {
    let env = Env::default();
    let (client, _buyer, seller, _arbiter, token) = setup(&env);
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
    client.release();
    // Second release must fail (state is no longer Locked/Disputed).
    client.release();
}
