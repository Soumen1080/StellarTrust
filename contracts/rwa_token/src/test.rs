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
    client.initialize(
        &issuer,
        &String::from_str(env, "invoice:INV-001"),
        &AssetType::Invoice,
        &String::from_str(env, "Test invoice tokenization"),
        &1_000,
        &false, // no authorization required
    );
    (client, issuer)
}

fn setup_with_auth(env: &Env) -> (RwaTokenContractClient, Address) {
    env.mock_all_auths();
    let issuer = Address::generate(env);
    let contract_id = env.register(RwaTokenContract, ());
    let client = RwaTokenContractClient::new(env, &contract_id);
    client.initialize(
        &issuer,
        &String::from_str(env, "invoice:INV-002"),
        &AssetType::Invoice,
        &String::from_str(env, "Authorized invoice"),
        &1_000,
        &true, // authorization required
    );
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

#[test]
fn zero_balance_gets_zero_payout() {
    let env = Env::default();
    let (client, _issuer) = setup(&env);
    let non_holder = Address::generate(&env);
    assert_eq!(client.payout_share(&non_holder, &4_000), 0);
}

#[test]
fn all_payout_shares_returns_all_holders() {
    let env = Env::default();
    let (client, issuer) = setup(&env);
    let inv1 = Address::generate(&env);
    let inv2 = Address::generate(&env);
    
    client.transfer(&issuer, &inv1, &300); // 30%
    client.transfer(&issuer, &inv2, &200); // 20%
    // Issuer retains 50%
    
    let shares = client.all_payout_shares(&10_000);
    assert_eq!(shares.len(), 3);
    
    // Verify total adds up to payout
    let total: i128 = shares.iter().map(|(_, share)| share).sum();
    assert_eq!(total, 10_000);
}

#[test]
fn metadata_stored_correctly() {
    let env = Env::default();
    let (client, issuer) = setup(&env);
    let meta = client.get_meta();
    assert_eq!(meta.issuer, issuer);
    assert_eq!(meta.asset_type, AssetType::Invoice);
    assert_eq!(meta.total_units, 1_000);
    assert_eq!(meta.distributed, false);
    assert_eq!(meta.frozen, false);
}

#[test]
fn freeze_blocks_transfers() {
    let env = Env::default();
    let (client, issuer) = setup(&env);
    let investor = Address::generate(&env);
    
    client.freeze();
    
    // Transfer should fail
    let result = client.try_transfer(&issuer, &investor, &100);
    assert_eq!(result, Err(Ok(Error::TransfersFrozen)));
}

#[test]
fn unfreeze_allows_transfers() {
    let env = Env::default();
    let (client, issuer) = setup(&env);
    let investor = Address::generate(&env);
    
    client.freeze();
    client.unfreeze();
    
    // Transfer should succeed
    client.transfer(&issuer, &investor, &100);
    assert_eq!(client.balance_of(&investor), 100);
}

#[test]
fn authorization_required_blocks_unauthorized() {
    let env = Env::default();
    let (client, issuer) = setup_with_auth(&env);
    let investor = Address::generate(&env);
    
    // Issuer is auto-authorized, but investor is not
    let result = client.try_transfer(&issuer, &investor, &100);
    assert_eq!(result, Err(Ok(Error::NotAuthorized)));
}

#[test]
fn authorization_allows_transfer() {
    let env = Env::default();
    let (client, issuer) = setup_with_auth(&env);
    let investor = Address::generate(&env);
    
    // Authorize investor
    client.authorize(&investor);
    
    // Transfer should succeed
    client.transfer(&issuer, &investor, &100);
    assert_eq!(client.balance_of(&investor), 100);
}

#[test]
fn revoke_authorization_blocks_transfer() {
    let env = Env::default();
    let (client, issuer) = setup_with_auth(&env);
    let inv1 = Address::generate(&env);
    let inv2 = Address::generate(&env);
    
    client.authorize(&inv1);
    client.transfer(&issuer, &inv1, &100);
    
    // Revoke and try secondary transfer
    client.revoke_authorization(&inv1);
    let result = client.try_transfer(&inv1, &inv2, &50);
    assert_eq!(result, Err(Ok(Error::NotAuthorized)));
}

#[test]
fn is_authorized_returns_correct_status() {
    let env = Env::default();
    let (client, issuer) = setup_with_auth(&env);
    let investor = Address::generate(&env);
    
    assert_eq!(client.is_authorized(&issuer), true);
    assert_eq!(client.is_authorized(&investor), false);
    
    client.authorize(&investor);
    assert_eq!(client.is_authorized(&investor), true);
}

#[test]
fn get_holders_returns_non_zero_balances() {
    let env = Env::default();
    let (client, issuer) = setup(&env);
    let inv1 = Address::generate(&env);
    let inv2 = Address::generate(&env);
    
    client.transfer(&issuer, &inv1, &300);
    client.transfer(&issuer, &inv2, &200);
    
    let holders = client.get_holders();
    assert_eq!(holders.len(), 3); // issuer + 2 investors
}

#[test]
fn mark_distributed_is_idempotent() {
    let env = Env::default();
    let (client, _issuer) = setup(&env);
    
    client.mark_distributed();
    let result = client.try_mark_distributed();
    assert_eq!(result, Err(Ok(Error::AlreadyDistributed)));
}

#[test]
#[should_panic(expected = "InvalidAmount")]
fn negative_transfer_fails() {
    let env = Env::default();
    let (client, issuer) = setup(&env);
    let investor = Address::generate(&env);
    
    client.transfer(&issuer, &investor, &-100);
}

#[test]
#[should_panic(expected = "InsufficientUnits")]
fn insufficient_balance_fails() {
    let env = Env::default();
    let (client, issuer) = setup(&env);
    let investor = Address::generate(&env);
    
    client.transfer(&issuer, &investor, &2_000); // Only 1000 available
}

#[test]
fn commodity_tokenization() {
    let env = Env::default();
    env.mock_all_auths();
    let issuer = Address::generate(&env);
    let contract_id = env.register(RwaTokenContract, ());
    let client = RwaTokenContractClient::new(&env, &contract_id);
    
    client.initialize(
        &issuer,
        &String::from_str(&env, "commodity:GOLD-100KG"),
        &AssetType::Commodity,
        &String::from_str(&env, "100kg gold bar tokenization"),
        &100,
        &false,
    );
    
    let meta = client.get_meta();
    assert_eq!(meta.asset_type, AssetType::Commodity);
    assert_eq!(meta.total_units, 100);
}

#[test]
fn real_estate_tokenization() {
    let env = Env::default();
    env.mock_all_auths();
    let issuer = Address::generate(&env);
    let contract_id = env.register(RwaTokenContract, ());
    let client = RwaTokenContractClient::new(&env, &contract_id);
    
    client.initialize(
        &issuer,
        &String::from_str(&env, "property:123-Main-St"),
        &AssetType::RealEstate,
        &String::from_str(&env, "Commercial building fractional ownership"),
        &10_000,
        &true, // Real estate typically requires authorization
    );
    
    let meta = client.get_meta();
    assert_eq!(meta.asset_type, AssetType::RealEstate);
    assert_eq!(meta.require_authorization, true);
}

