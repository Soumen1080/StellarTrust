<#
.SYNOPSIS
  Provision the testnet accounts and token contract that on-chain escrow needs.

.DESCRIPTION
  `deploy-testnet.ps1` uploads the contract WASM. This script provisions
  everything *around* it — the parts that must exist before the backend can be
  switched from the deterministic gateway to `soroban-rpc`:

    - an **arbiter** identity, funded. The backend signs with this key: it
      deploys one escrow instance per order and signs release/refund. It is what
      DEMO_SIGNER_SECRET points at.
    - an **issuer** identity, funded, which issues a test USDC asset. Using our
      own asset (rather than Circle's testnet USDC) means we can mint to any
      test buyer on demand instead of queueing at a faucet.
    - the **Stellar Asset Contract** for that asset. The escrow contract moves
      value by calling `token::Client` against a contract address, so the
      classic asset needs its SAC deployed before any escrow can hold it.

  Idempotent: existing identities are reused, and an already-deployed SAC is
  reported rather than treated as a failure. Re-run it freely.

  The escrow contract requires the SEP-41 token interface, which is why this
  wraps a classic asset instead of reusing `rwa_token` (that contract exposes
  `balance_of`/`units`, not `balance`/`transfer`, so `token::Client` cannot
  drive it).

.PARAMETER AssetCode
  Asset code to issue. Must match a CurrencyCode the ledger knows, because
  STELLAR_TOKEN_CONTRACTS is keyed by ledger currency.

.PARAMETER Prefix
  Prefix for the generated Stellar CLI identity names.

.PARAMETER EnvOut
  Optional path to write the resulting env block to, in addition to printing it.
#>
param(
  [string]$AssetCode = "USDC",
  [string]$Network = "testnet",
  [string]$Prefix = "stellartrust",
  [string]$EnvOut
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command stellar -ErrorAction SilentlyContinue)) {
  throw "Stellar CLI is required. Install it, then rerun."
}

if ($Network -ne "testnet" -and $Network -ne "futurenet" -and $Network -ne "local") {
  throw "Refusing to run against '$Network'. This script mints a test asset and writes a signing secret to disk; it is for test networks only."
}

# `stellar` writes progress and success notices to stderr; capturing them as
# output would corrupt every value we parse, so stderr goes to a file and we
# judge the call by its exit code.
#
# `$ErrorActionPreference = 'Continue'` around the call is load-bearing on
# Windows PowerShell 5.1: redirecting a native command's stderr turns each line
# into a NativeCommandError record, which under 'Stop' aborts the script even
# when the command exited 0.
function Invoke-StellarRaw {
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

  return [pscustomobject]@{
    ExitCode = $exitCode
    Output   = ($output | Where-Object { $_ } | Select-Object -Last 1)
    Stderr   = $stderrText
  }
}

function Invoke-Stellar {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [switch]$AllowFailure
  )

  $result = Invoke-StellarRaw -Arguments $Arguments
  if ($result.ExitCode -ne 0) {
    if ($AllowFailure) { return $null }
    throw "stellar $($Arguments -join ' ') failed (exit $($result.ExitCode)): $($result.Stderr)"
  }
  return $result.Output
}

# Not routed through Invoke-Stellar: this needs every line, not the last one,
# and `keys ls` writes its listing to stdout with nothing to suppress.
function Test-Identity {
  param([string]$Name)

  $existing = & stellar keys ls
  return @($existing | ForEach-Object { $_.Trim() }) -contains $Name
}

function New-FundedIdentity {
  param([string]$Name, [string]$Role)

  if (Test-Identity -Name $Name) {
    Write-Host "  reusing existing identity '$Name' ($Role)"
  }
  else {
    Write-Host "  generating and funding '$Name' ($Role)..."
    Invoke-Stellar @("keys", "generate", $Name, "--network", $Network, "--fund") | Out-Null
  }

  $address = Invoke-Stellar @("keys", "address", $Name)
  if (-not $address -or -not $address.StartsWith("G")) {
    throw "Could not resolve an address for identity '$Name' (got '$address')"
  }

  # A reused identity may predate this script and never have been funded, and an
  # unfunded arbiter fails at the first deploy rather than here. Friendbot
  # refuses an already-funded account, which is a success for our purposes.
  Invoke-Stellar @("keys", "fund", $Name, "--network", $Network) -AllowFailure | Out-Null

  return $address.Trim()
}

Write-Host "Provisioning StellarTrust escrow accounts on $Network..." -ForegroundColor Cyan
Write-Host ""

Write-Host "Identities:"
$arbiterName = "$Prefix-arbiter"
$issuerName = "$Prefix-issuer"
$arbiterAddress = New-FundedIdentity -Name $arbiterName -Role "backend signer / on-chain arbiter"
$issuerAddress = New-FundedIdentity -Name $issuerName -Role "test $AssetCode issuer"

Write-Host ""
Write-Host "  arbiter: $arbiterAddress"
Write-Host "  issuer:  $issuerAddress"

$asset = "${AssetCode}:${issuerAddress}"

Write-Host ""
Write-Host "Stellar Asset Contract for $asset :"

# The SAC id is deterministic from the asset and network passphrase, so it can
# be read whether or not the deploy in this run is the one that created it.
$contractId = Invoke-Stellar @("contract", "id", "asset", "--asset", $asset, "--network", $Network)
Write-Host "  contract id: $contractId"

$deploy = Invoke-StellarRaw -Arguments @(
  "contract", "asset", "deploy",
  "--asset", $asset,
  "--source-account", $issuerName,
  "--network", $Network
)

if ($deploy.ExitCode -eq 0) {
  Write-Host "  deployed." -ForegroundColor Green
}
else {
  # A failed deploy and an already-deployed SAC are indistinguishable from the
  # message alone across CLI versions. Ask the network instead: if the contract
  # answers, the only thing that failed is a redundant deploy.
  $probe = Invoke-StellarRaw -Arguments @(
    "contract", "info", "interface", "--contract-id", $contractId, "--network", $Network
  )
  if ($probe.ExitCode -eq 0) {
    Write-Host "  already deployed (reusing)." -ForegroundColor Green
  }
  else {
    throw "Could not deploy the $asset contract, and no contract answers at ${contractId}: $($deploy.Stderr)"
  }
}

$arbiterSecret = Invoke-Stellar @("keys", "secret", $arbiterName)
if (-not $arbiterSecret -or -not $arbiterSecret.StartsWith("S")) {
  throw "Could not read the arbiter secret for '$arbiterName'"
}

$envBlock = @"
# Generated by contracts/scripts/setup-testnet.ps1 on $(Get-Date -Format "yyyy-MM-dd HH:mm")
ESCROW_GATEWAY=soroban-rpc
STELLAR_NETWORK=$Network
STELLAR_TOKEN_CONTRACTS={"$AssetCode":{"contractId":"$contractId","decimals":7}}
DEMO_MODE=true
DEMO_SIGNER_SECRET=$arbiterSecret
# Still required: upload the escrow WASM (deploy-testnet.ps1) and set its hash.
# ESCROW_WASM_HASH=
"@

Write-Host ""
Write-Host "Add these to backend/.env:" -ForegroundColor Green
Write-Host ""
Write-Output $envBlock
Write-Host ""

if ($EnvOut) {
  $envBlock | Out-File -FilePath $EnvOut -Encoding utf8
  Write-Host "Written to $EnvOut" -ForegroundColor Green
}

Write-Host "Test asset for funding wallets:" -ForegroundColor Cyan
Write-Host "  asset:  $asset"
Write-Host "  issuer identity: $issuerName"
Write-Host ""
Write-Host "Next:" -ForegroundColor Cyan
Write-Host "  1. ./contracts/scripts/deploy-testnet.ps1 -Source $arbiterName   # sets ESCROW_WASM_HASH"
Write-Host "  2. ./contracts/scripts/fund-wallet.ps1 -Address <buyer G...>     # trustline + test $AssetCode"
Write-Host "  3. npm run chain:preflight --prefix backend                      # verify before first order"
Write-Host ""
Write-Host "DEMO_SIGNER_SECRET is a testnet signing key. It belongs in backend/.env (gitignored) and nowhere else." -ForegroundColor Yellow
