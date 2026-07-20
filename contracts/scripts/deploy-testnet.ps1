param(
  [string]$Source = "stellartrust-deployer",
  [string]$Network = "testnet"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command stellar -ErrorAction SilentlyContinue)) {
  throw "Stellar CLI is required. Install it, configure a funded testnet identity, then rerun."
}

Write-Host "Building escrow contract..."
stellar contract build --package stellartrust-escrow

$wasm = Join-Path $PSScriptRoot "..\target\wasm32-unknown-unknown\release\stellartrust_escrow.wasm"
if (-not (Test-Path $wasm)) {
  throw "Escrow WASM was not produced at $wasm"
}

Write-Host "Deploying escrow contract to $Network using the configured '$Source' identity..."
$contractId = stellar contract deploy --wasm $wasm --source $Source --network $Network
if (-not $contractId) {
  throw "Stellar CLI did not return a contract ID"
}

Write-Output $contractId
Write-Host "Deployment complete. Store this public contract ID as deployment configuration; never store the source secret in the repository."
