#![cfg(test)]
//! RWA token contract tests (run with `cargo test` once the Rust/Soroban
//! toolchain is installed — see contracts/README.md).

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env, String};

fn setup(env: &Env) -> (RwaTokenContractClient, Address) {
    env.mock_all_auths();
    let issuer = Address::generate(env);
    let contract_id = env.register(RwaTokenContract, ());
    let client = RwaTokenContractClient::new(env, &contract_id);
    client.initialize(&issuer, &String::from_str(env, "invoice:INV-001"), &1_000);
    (client, issuer)
}

#[test]
fn issuer_holds_all_units_initially() {
    let env = Env::default();
    let (client, issuer) = setup(&env);
    assert_eq!(client.balance_of(&issuer), 1_000);
}

#[test]
fn transfer_to_investor() {
    let env = Env::default();
    let (client, issuer) = setup(&env);
    let investor = Address::generate(&env);
    client.transfer(&issuer, &investor, &250);
    assert_eq!(client.balance_of(&investor), 250);
    assert_eq!(client.balance_of(&issuer), 750);
}

#[test]
fn payout_share_is_pro_rata() {
    let env = Env::default();
    let (client, issuer) = setup(&env);
    let investor = Address::generate(&env);
    client.transfer(&issuer, &investor, &250); // 25% of 1000 units
                                               // 25% of a 4_000 payout = 1_000.
    assert_eq!(client.payout_share(&investor, &4_000), 1_000);
}
