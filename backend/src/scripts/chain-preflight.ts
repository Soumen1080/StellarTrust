/**
 * Pre-flight check for on-chain escrow (`npm run chain:preflight`).
 *
 * Config validation at boot proves the environment is *shaped* correctly — that
 * a WASM hash is 64 hex characters and a contract id starts with `C`. It cannot
 * prove the WASM was ever uploaded, that the token contract exists, that its
 * `decimals()` matches what we configured, or that the account we sign with has
 * the XLM to pay for a deploy. Every one of those fails at the first `lock`
 * instead, after a buyer has signed and expects their funds to move.
 *
 * This asks the network those questions up front. It is read-only: it simulates
 * and reads ledger entries, and submits nothing.
 */
import {
  BASE_FEE,
  Contract,
  Horizon,
  TransactionBuilder,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";

/** One question asked of the network, and what it answered. */
interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** What to do about it. Only shown when the check failed. */
  hint?: string;
}

const checks: Check[] = [];

function record(check: Check): Check {
  checks.push(check);
  const mark = check.ok ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${check.name}: ${check.detail}`);
  if (!check.ok && check.hint) console.log(`         → ${check.hint}`);
  return check;
}

/**
 * Narrow an unknown thrown value to something printable.
 *
 * Soroban RPC rejections arrive as plain objects, not Errors; `String(err)` on
 * those yields "[object Object]", which tells an operator nothing about what
 * the network actually refused.
 */
function reason(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}

/**
 * Read a no-argument value off a contract by simulating a call to it.
 *
 * Deliberately not `contract.Client.from`: that fetches the contract's spec
 * from its uploaded WASM, and a Stellar Asset Contract has none — its
 * executable is the built-in SAC, so spec introspection fails on exactly the
 * token contracts escrow is most likely to hold.
 */
async function readContractValue(
  server: rpc.Server,
  contractId: string,
  method: string,
  sourceAddress: string,
  passphrase: string,
): Promise<unknown> {
  const account = await server.getAccount(sourceAddress);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(new Contract(contractId).call(method))
    .setTimeout(30)
    .build();

  const simulation = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(simulation.error);
  }
  if (!simulation.result) {
    throw new Error(`${method}() returned no value`);
  }
  return scValToNative(simulation.result.retval);
}

async function main(): Promise<void> {
  console.log("StellarTrust on-chain escrow preflight\n");

  // Imported dynamically so an invalid environment is reported as a readable
  // failure rather than an unhandled module-load throw.
  let config: typeof import("../config/index.js").config;
  try {
    ({ config } = await import("../config/index.js"));
  } catch (err) {
    console.error(`Configuration is invalid:\n${reason(err)}`);
    process.exit(1);
  }

  const { networkPassphrase } = await import("../modules/stellar/stellar.client.js");
  const { getRpcServer } = await import("../modules/stellar/soroban.client.js");
  const { createSigner } = await import("../modules/stellar/signer.js");

  console.log(`  network:  ${config.STELLAR_NETWORK}`);
  console.log(`  rpc:      ${config.SOROBAN_RPC_URL}`);
  console.log(`  horizon:  ${config.HORIZON_URL}`);
  console.log(`  gateway:  ${config.ESCROW_GATEWAY}\n`);

  // ── Gateway ───────────────────────────────────────────────────────────────
  if (config.ESCROW_GATEWAY !== "soroban-rpc") {
    record({
      name: "escrow gateway",
      ok: false,
      detail: `ESCROW_GATEWAY=${config.ESCROW_GATEWAY} — escrow is simulated in memory, nothing moves on-chain`,
      hint: "Set ESCROW_GATEWAY=soroban-rpc to settle against the network.",
    });
    // Every remaining check describes chain wiring this deployment will not
    // use. Reporting them as failures would be noise, so stop here.
    console.log("\nNothing further to check while the deterministic gateway is active.");
    process.exit(1);
  }
  record({
    name: "escrow gateway",
    ok: true,
    detail: "soroban-rpc (transactions settle on-chain)",
  });

  // ── RPC reachability and network identity ─────────────────────────────────
  const server = getRpcServer();
  let rpcOk = false;
  try {
    const network = await server.getNetwork();
    const expected = networkPassphrase();
    rpcOk = network.passphrase === expected;
    record({
      name: "soroban rpc",
      ok: rpcOk,
      detail: rpcOk
        ? `reachable, passphrase matches ${config.STELLAR_NETWORK}`
        : `serves "${network.passphrase}" but STELLAR_NETWORK=${config.STELLAR_NETWORK} expects "${expected}"`,
      hint: "SOROBAN_RPC_URL points at a different network than STELLAR_NETWORK. Every signature would be rejected.",
    });
  } catch (err) {
    record({
      name: "soroban rpc",
      ok: false,
      detail: `unreachable — ${reason(err)}`,
      hint: "Check SOROBAN_RPC_URL and your network connection.",
    });
  }

  // ── Signer / arbiter account ──────────────────────────────────────────────
  if (config.SIGNER_PROVIDER === "local-stub" && !config.DEMO_MODE) {
    record({
      name: "signer",
      ok: false,
      detail:
        "SIGNER_PROVIDER=local-stub without DEMO_MODE generates a random key at every boot",
      hint:
        "That account has never been funded and cannot deploy an escrow. Set DEMO_MODE=true and DEMO_SIGNER_SECRET to a funded testnet key.",
    });
  }

  let signerAddress: string | undefined;
  try {
    signerAddress = await createSigner().getPublicKey();
    record({
      name: "signer",
      ok: true,
      detail: `signs as ${signerAddress}`,
    });
  } catch (err) {
    record({
      name: "signer",
      ok: false,
      detail: `unavailable — ${reason(err)}`,
      hint: "Configure DEMO_MODE + DEMO_SIGNER_SECRET (testnet) or a KMS signer.",
    });
  }

  // The account that actually pays for deploys is the server signer, whether or
  // not settlement authority sits elsewhere.
  if (signerAddress) {
    try {
      const horizon = new Horizon.Server(config.HORIZON_URL);
      const account = await horizon.loadAccount(signerAddress);
      const xlm =
        account.balances.find((b) => b.asset_type === "native")?.balance ?? "0";
      // A deploy plus its Soroban resource fees costs well under 1 XLM, but an
      // account near the base reserve cannot spend what it appears to hold.
      const funded = Number(xlm) >= 5;
      record({
        name: "signer funding",
        ok: funded,
        detail: `${xlm} XLM`,
        hint: "Too low to deploy escrow instances reliably. Fund it via friendbot.",
      });
    } catch (err) {
      record({
        name: "signer funding",
        ok: false,
        detail: `account not found on ${config.STELLAR_NETWORK} — ${reason(err)}`,
        hint: "The signing account does not exist. Fund it via friendbot before any escrow can deploy.",
      });
    }
  }

  // ── Settlement authority ──────────────────────────────────────────────────
  const arbiter = config.ESCROW_ARBITER_ADDRESS ?? signerAddress;
  if (config.ESCROW_ARBITER_ADDRESS && config.ESCROW_ARBITER_ADDRESS !== signerAddress) {
    record({
      name: "arbiter",
      ok: true,
      detail: `external (${config.ESCROW_ARBITER_ADDRESS}) — release/refund need a wallet signature, not this server's`,
    });
  } else {
    record({
      name: "arbiter",
      ok: true,
      detail: `this server (${arbiter ?? "unknown"}) — release/refund are server-signed`,
    });
  }

  // ── Escrow WASM ───────────────────────────────────────────────────────────
  if (!config.ESCROW_WASM_HASH) {
    record({
      name: "escrow wasm",
      ok: false,
      detail: "ESCROW_WASM_HASH is not set",
      hint: "Run contracts/scripts/deploy-testnet.ps1 and set the hash it prints.",
    });
  } else if (rpcOk) {
    try {
      const wasm = await server.getContractWasmByHash(config.ESCROW_WASM_HASH, "hex");
      record({
        name: "escrow wasm",
        ok: true,
        detail: `installed on-chain (${wasm.length} bytes)`,
      });
    } catch (err) {
      record({
        name: "escrow wasm",
        ok: false,
        detail: `${config.ESCROW_WASM_HASH} is not installed on ${config.STELLAR_NETWORK} — ${reason(err)}`,
        hint: "Upload it with contracts/scripts/deploy-testnet.ps1. Every lock would fail at deploy.",
      });
    }
  }

  // ── Token contracts ───────────────────────────────────────────────────────
  const bindings = Object.entries(config.STELLAR_TOKEN_CONTRACTS);
  if (bindings.length === 0) {
    record({
      name: "token contracts",
      ok: false,
      detail: "STELLAR_TOKEN_CONTRACTS is empty",
      hint: "No currency can reach on-chain escrow. Set at least one binding.",
    });
  }

  for (const [currency, binding] of bindings) {
    if (!rpcOk || !signerAddress) break;
    try {
      // `decimals()` is the check that matters: the ledger↔token conversion is
      // a power of ten derived from this number. A binding claiming 7 against a
      // token that reports 2 would lock 10^5 times the intended value.
      const onChain = Number(
        await readContractValue(
          server,
          binding.contractId,
          "decimals",
          // Simulation needs a source account that exists; the signer is the
          // one account this deployment knows is funded.
          signerAddress,
          networkPassphrase(),
        ),
      );
      const matches = onChain === binding.decimals;
      record({
        name: `token ${currency}`,
        ok: matches,
        detail: matches
          ? `${binding.contractId} reports ${onChain} decimals, as configured`
          : `${binding.contractId} reports ${onChain} decimals but config says ${binding.decimals}`,
        hint: `Set decimals to ${onChain} for ${currency}, or point at the right contract. As configured, every locked amount would be off by a factor of 10^${Math.abs(onChain - binding.decimals)}.`,
      });
    } catch (err) {
      record({
        name: `token ${currency}`,
        ok: false,
        detail: `${binding.contractId} could not be read — ${reason(err)}`,
        hint: "The token contract does not exist on this network, or the RPC is unavailable.",
      });
    }
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  const failed = checks.filter((c) => !c.ok);
  console.log("");
  if (failed.length === 0) {
    console.log("All checks passed. On-chain escrow is ready to settle real testnet value.");
    return;
  }
  console.log(
    `${failed.length} check${failed.length === 1 ? "" : "s"} failed: ${failed
      .map((c) => c.name)
      .join(", ")}`,
  );
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error(`Preflight could not complete: ${reason(err)}`);
  process.exit(1);
});
