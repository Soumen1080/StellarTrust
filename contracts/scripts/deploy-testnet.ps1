<#
.SYNOPSIS
  Build and install the StellarTrust contracts, emitting the WASM hashes the
  backend needs.

.DESCRIPTION
  The backend does not take a contract *id* for escrow or RWA: it deploys a
  fresh instance per order / per tokenization, so what it needs configured is
  the WASM *hash* of an already-uploaded contract. That comes from
  `stellar contract upload`, not `stellar contract deploy` — installing once and
  deploying many instances from the same hash is both cheaper and what the
  gateways are written against.

  Outputs the env lines to copy into the backend configuration.

.PARAMETER Source
  A funded Stellar CLI identity to pay the upload fees.

.PARAMETER Deploy
  Also deploy one standalone instance of each contract. Not needed by the
  backend; useful for poking at a contract by hand.
#>
param(
  [string]$Source = "stellartrust-deployer",
  [string]$Network = "testnet",
  [switch]$Deploy
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command stellar -ErrorAction SilentlyContinue)) {
  throw "Stellar CLI is required. Install it, configure a funded testnet identity, then rerun."
}

$targetRoot = Join-Path $PSScriptRoot "..\target"

function Get-ContractWasm {
  param([string]$Package)

  Write-Host "Building $Package..."
  stellar contract build --package $Package
  if ($LASTEXITCODE -ne 0) { throw "stellar contract build failed for $Package" }

  # Stellar CLI 23+ (SDK 21.1+/protocol 21+) builds to the wasm32v1-none target;
  # older toolchains used wasm32-unknown-unknown. Accept whichever is produced.
  $wasm = @(
    (Join-Path $targetRoot "wasm32v1-none\release\$Package.wasm"),
    (Join-Path $targetRoot "wasm32-unknown-unknown\release\$Package.wasm")
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1

  if (-not $wasm) {
    throw "$Package WASM was not produced under $targetRoot (checked wasm32v1-none and wasm32-unknown-unknown)"
  }
  return $wasm
}

$results = @{}

foreach ($package in @("escrow", "rwa_token")) {
  $wasm = Get-ContractWasm -Package $package

  Write-Host "Uploading $package to $Network using the '$Source' identity..."
  $hash = stellar contract upload --wasm $wasm --source $Source --network $Network
  if ($LASTEXITCODE -ne 0 -or -not $hash) {
    throw "stellar contract upload did not return a WASM hash for $package"
  }
  $results[$package] = ($hash | Select-Object -Last 1).Trim()

  if ($Deploy) {
    Write-Host "Deploying a standalone $package instance..."
    $contractId = stellar contract deploy --wasm-hash $results[$package] --source $Source --network $Network
    if ($contractId) {
      Write-Host "  $package contract id: $($contractId | Select-Object -Last 1)"
    }
  }
}

Write-Host ""
Write-Host "Add these to the backend environment:" -ForegroundColor Green
Write-Output "ESCROW_WASM_HASH=$($results['escrow'])"
Write-Output "RWA_WASM_HASH=$($results['rwa_token'])"
Write-Host ""
Write-Host "Escrow also needs a token contract per currency, e.g.:" -ForegroundColor Green
Write-Host '  STELLAR_TOKEN_CONTRACTS={"USDC":{"contractId":"C...","decimals":7}}'
Write-Host ""
Write-Host "WASM hashes and contract ids are public configuration. The source identity's secret is not — never commit it." -ForegroundColor Yellow
