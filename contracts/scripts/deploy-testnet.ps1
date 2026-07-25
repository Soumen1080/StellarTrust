param(
  [string]$Source = "stellartrust-deployer",
  [string]$Network = "testnet"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command stellar -ErrorAction SilentlyContinue)) {
  throw "Stellar CLI is required. Install it, configure a funded testnet identity, then rerun."
}

Write-Host "Building escrow contract..."
stellar contract build --package escrow

# Stellar CLI 23+ (SDK 21.1+/protocol 21+) builds to the wasm32v1-none target;
# older toolchains used wasm32-unknown-unknown. Accept whichever is produced.
$targetRoot = Join-Path $PSScriptRoot "..\target"
$wasm = @(
  (Join-Path $targetRoot "wasm32v1-none\release\escrow.wasm"),
  (Join-Path $targetRoot "wasm32-unknown-unknown\release\escrow.wasm")
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $wasm) {
  throw "Escrow WASM was not produced under $targetRoot (checked wasm32v1-none and wasm32-unknown-unknown)"
}

Write-Host "Deploying escrow contract to $Network using the configured '$Source' identity..."
$contractId = stellar contract deploy --wasm $wasm --source $Source --network $Network
if (-not $contractId) {
  throw "Stellar CLI did not return a contract ID"
}

Write-Output $contractId
Write-Host "Deployment complete. Store this public contract ID as deployment configuration; never store the source secret in the repository."
