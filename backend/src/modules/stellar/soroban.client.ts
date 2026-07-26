/**
 * Soroban contract-invocation helper (Phase 5 chain wiring).
 *
 * Wraps the stellar-sdk high-level `contract.Client` so the RWA/escrow gateways
 * depend on our narrow interface rather than the SDK directly (Rules.md §2:
 * external systems behind adapters). The `contract.Client`:
 *   - fetches the contract spec from chain and auto-converts native JS args,
 *   - simulates read calls (no signature) and returns parsed results,
 *   - assembles + signs + submits write calls, polling to completion.
 *
 * All signing is delegated to the {@link Signer} boundary (Golden Rule #2 — no
 * secret keys here). For contract functions whose auth root is the transaction
 * source (issuer/arbiter operations), the server signer's own signature covers
 * the required `require_auth()`; multi-party auth (e.g. a buyer authorizing an
 * escrow lock) needs client-side signing and is out of scope for this adapter.
 */
import { contract } from "@stellar/stellar-sdk";
import { config } from "../../config/index.js";
import { networkPassphrase } from "./stellar.client.js";
import type { Signer } from "./signer.js";

/** An assembled (built + simulated) contract transaction. */
export type ContractTx<T> = contract.AssembledTransaction<T>;
/** Rust `Result<T, E>` as parsed by the contract spec. */
export type ContractResult<T> = contract.Result<T>;

function allowHttp(): boolean {
  return config.SOROBAN_RPC_URL.startsWith("http://");
}

/**
 * Adapt the {@link Signer} boundary to the SDK's `signTransaction` callback
 * (the same shape SEP-43 wallets expose). Secret material never leaves the
 * signer; we only pass base64 XDR across the boundary.
 */
export function toSignTransaction(signer: Signer): contract.SignTransaction {
  const passphrase = networkPassphrase();
  return async (xdr, opts) => {
    const signedTxXdr = await signer.signTransactionXdr(
      xdr,
      opts?.networkPassphrase ?? passphrase,
    );
    return { signedTxXdr, signerAddress: await signer.getPublicKey() };
  };
}

/**
 * Build a spec-aware client for an already-deployed contract. The `publicKey`
 * is the transaction source for simulation and the signing account for writes.
 */
export async function getContractClient(
  contractId: string,
  signer: Signer,
): Promise<contract.Client> {
  const publicKey = await signer.getPublicKey();
  return contract.Client.from({
    contractId,
    rpcUrl: config.SOROBAN_RPC_URL,
    networkPassphrase: networkPassphrase(),
    allowHttp: allowHttp(),
    publicKey,
    signTransaction: toSignTransaction(signer),
  });
}

/**
 * Deploy a new contract instance from an already-installed WASM hash and return
 * its contract ID. The contract's own `initialize` (not a `__constructor`) is
 * invoked separately by the caller, mirroring how these contracts are deployed
 * via the Stellar CLI.
 *
 * @param wasmHash - hex-encoded hash of the WASM previously uploaded on-chain.
 */
export async function deployFromWasmHash(
  wasmHash: string,
  signer: Signer,
): Promise<string> {
  const publicKey = await signer.getPublicKey();
  const deployTx = await contract.Client.deploy(null, {
    wasmHash,
    format: "hex",
    rpcUrl: config.SOROBAN_RPC_URL,
    networkPassphrase: networkPassphrase(),
    allowHttp: allowHttp(),
    publicKey,
    signTransaction: toSignTransaction(signer),
  });
  const sent = await deployTx.signAndSend();
  return sent.result.options.contractId;
}
