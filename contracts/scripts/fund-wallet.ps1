<#
.SYNOPSIS
  Give a testnet wallet what it needs to take part in an on-chain escrow: XLM
  for fees, a trustline for the test asset, and a balance of it.

.DESCRIPTION
  Both counterparties need setting up before an escrow can settle, and they need
  different things:

    - The **buyer** is the transaction source for `initialize`, so it pays its
      own fees (XLM) and must hold the asset being locked.
    - The **seller** never signs, but `release` transfers to its account — and a
      classic asset cannot land in an account with no trustline. A seller
      without one turns a release into an on-chain failure *after* the buyer's
      funds are already in custody.

  Trustlines are authorized by the account itself. For a wallet held in
  Freighter this script cannot add one; it detects the gap and prints exactly
  what to add. For a Stellar CLI identity (`-Identity`), it adds the trustline
  itself.

.PARAMETER Address
  A `G…` account to fund. Use for real wallets (Freighter) that you sign with.

.PARAMETER Identity
  A Stellar CLI identity name to fund. Unlike -Address, the trustline can be
  added automatically because this script can sign for it.

.PARAMETER Usdc
  How much of the test asset to send, in whole units. 0 skips the transfer,
  which is what you want for a seller: it needs the trustline, not a balance.
#>
param(
  [string]$Address,
  [string]$Identity,
  [string]$AssetCode = "USDC",
  [decimal]$Usdc = 1000,
  [string]$Network = "testnet",
  [string]$Prefix = "stellartrust"
)

$ErrorActionPreference = "Stop"

if (-not $Address -and -not $Identity) {
  throw "Pass -Address <G...> for a wallet you hold elsewhere, or -Identity <name> for a Stellar CLI identity."
}
if ($Address -and $Identity) {
  throw "Pass either -Address or -Identity, not both."
}
if ($Network -ne "testnet" -and $Network -ne "futurenet") {
  throw "Refusing to run against '$Network'. This script mints a test asset; it is for test networks only."
}

$horizon = if ($Network -eq "testnet") {
  "https://horizon-testnet.stellar.org"
} else {
  "https://horizon-futurenet.stellar.org"
}

# `stellar` writes progress and success notices to stderr, so it is redirected
# away from the values we parse. Flipping $ErrorActionPreference around the call
# is load-bearing on Windows PowerShell 5.1: redirecting a native command's
# stderr turns each line into a NativeCommandError record, which under 'Stop'
# aborts the script even when the command exited 0.
function Invoke-Stellar {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  $stderrFile = [System.IO.Path]::GetTempFileName()
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & stellar @Arguments 2>$stderrFile
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previous
  }

  $stderrText = Get-Content -Path $stderrFile -Raw -ErrorAction SilentlyContinue
  Remove-Item -Path $stderrFile -Force -ErrorAction SilentlyContinue

  if ($exitCode -ne 0) {
    throw "stellar $($Arguments -join ' ') failed (exit $exitCode): $stderrText"
  }
  return ($output | Where-Object { $_ } | Select-Object -Last 1)
}

function Get-Account {
  param([string]$AccountId)

  try {
    return Invoke-RestMethod -Uri "$horizon/accounts/$AccountId" -Method Get -TimeoutSec 30
  }
  catch {
    # A 404 means the account has never been funded — a real, expected state
    # here, not an error. Anything else (network, Horizon down) must surface.
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode.value__ -eq 404) {
      return $null
    }
    throw
  }
}

$issuerName = "$Prefix-issuer"
$issuerAddress = Invoke-Stellar @("keys", "address", $issuerName)
if (-not $issuerAddress) {
  throw "No issuer identity '$issuerName'. Run setup-testnet.ps1 first."
}
$issuerAddress = $issuerAddress.Trim()

$target = if ($Identity) {
  # Create the identity on first use. A test counterparty that does not exist
  # yet is the normal starting state, not an error worth stopping for.
  $known = @((& stellar keys ls) | ForEach-Object { $_.Trim() })
  if ($known -notcontains $Identity) {
    Write-Host "  creating identity '$Identity'..."
    Invoke-Stellar @("keys", "generate", $Identity, "--network", $Network, "--fund") | Out-Null
  }
  (Invoke-Stellar @("keys", "address", $Identity)).Trim()
} else {
  $Address.Trim()
}
if ($target -notmatch "^G[A-Z2-7]{55}$") {
  throw "'$target' is not a Stellar account address."
}

Write-Host "Funding $target on $Network..." -ForegroundColor Cyan
Write-Host "  asset: ${AssetCode}:$issuerAddress"
Write-Host ""

# ── XLM ───────────────────────────────────────────────────────────────────────
$account = Get-Account -AccountId $target
if (-not $account) {
  Write-Host "  account does not exist yet; funding with friendbot..."
  try {
    Invoke-RestMethod -Uri "https://friendbot.stellar.org/?addr=$target" -Method Get -TimeoutSec 60 | Out-Null
  }
  catch {
    throw "Friendbot could not fund $target : $($_.Exception.Message)"
  }
  $account = Get-Account -AccountId $target
  if (-not $account) {
    throw "Friendbot reported success but $target still does not exist on $Network."
  }
  Write-Host "  funded." -ForegroundColor Green
}
else {
  $xlm = ($account.balances | Where-Object { $_.asset_type -eq "native" }).balance
  Write-Host "  XLM balance: $xlm"
}

# ── Trustline ─────────────────────────────────────────────────────────────────
$hasTrustline = $null -ne ($account.balances | Where-Object {
    $_.asset_code -eq $AssetCode -and $_.asset_issuer -eq $issuerAddress
  })

if (-not $hasTrustline) {
  if ($Identity) {
    Write-Host "  adding $AssetCode trustline..."
    Invoke-Stellar @(
      "tx", "new", "change-trust",
      "--line", "${AssetCode}:$issuerAddress",
      "--source-account", $Identity,
      "--network", $Network
    ) | Out-Null
    Write-Host "  trustline added." -ForegroundColor Green
  }
  else {
    Write-Host ""
    Write-Host "  This account has no $AssetCode trustline, and only the account itself can add one." -ForegroundColor Yellow
    Write-Host "  In Freighter: Manage Assets -> Add asset, then enter:" -ForegroundColor Yellow
    Write-Host "     code:   $AssetCode"
    Write-Host "     issuer: $issuerAddress"
    Write-Host ""
    Write-Host "  Then rerun this script to receive the balance." -ForegroundColor Yellow
    exit 1
  }
}
else {
  Write-Host "  $AssetCode trustline present."
}

# ── Asset ─────────────────────────────────────────────────────────────────────
if ($Usdc -gt 0) {
  # Horizon and the CLI both denominate classic assets in stroops (1e7),
  # independent of how many decimals the ledger records for the currency.
  $stroops = [long]([decimal]$Usdc * 10000000)
  Write-Host "  sending $Usdc $AssetCode..."
  Invoke-Stellar @(
    "tx", "new", "payment",
    "--destination", $target,
    "--asset", "${AssetCode}:$issuerAddress",
    "--amount", "$stroops",
    "--source-account", $issuerName,
    "--network", $Network
  ) | Out-Null
  Write-Host "  sent." -ForegroundColor Green
}
else {
  Write-Host "  skipping transfer (-Usdc 0); trustline only."
}

$final = Get-Account -AccountId $target
$balance = ($final.balances | Where-Object {
    $_.asset_code -eq $AssetCode -and $_.asset_issuer -eq $issuerAddress
  }).balance

Write-Host ""
Write-Host "Done. $target now holds $balance $AssetCode." -ForegroundColor Green
