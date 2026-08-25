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
import { contract, rpc, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { ChainTxStatus } from "@stellartrust/shared";
import { config } from "../../config/index.js";
import { ChainError } from "../../lib/errors.js";
import { networkPassphrase } from "./stellar.client.js";
import type { Signer } from "./signer.js";

/** An assembled (built + simulated) contract transaction. */
export type ContractTx<T> = contract.AssembledTransaction<T>;
/** Rust `Result<T, E>` as parsed by the contract spec. */
export type ContractResult<T> = contract.Result<T>;

function allowHttp(): boolean {
  return config.SOROBAN_RPC_URL.startsWith("http://");
}

/** Shared RPC handle for raw submission and transaction lookups. */
let rpcServer: rpc.Server | undefined;
export function getRpcServer(): rpc.Server {
  rpcServer ??= new rpc.Server(config.SOROBAN_RPC_URL, {
    allowHttp: allowHttp(),
  });
  return rpcServer;
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
 * Reject a contract id this adapter can never talk to, before the SDK does.
 *
 * Records written while a gateway ran in its deterministic local mode carry
 * synthetic ids (`escrow-contract-<uuid>`, `rwa-contract-<uuid>`), and those
 * rows outlive the switch to `soroban-rpc`. Handed one, `Client.from` throws a
 * bare `Error: Invalid contract ID`, which is untyped and so reaches the
 * boundary as a 500 "Internal server error" — the operator learns nothing and
 * the user is told the server is broken when the row simply predates the
 * chain. A typed {@link ChainError} names the id and the reason instead.
 */
function assertDeployedContractId(contractId: string): void {
  if (!StrKey.isValidContract(contractId)) {
    throw new ChainError(
      `Contract id '${contractId}' is not a deployed Soroban contract. ` +
        "It was recorded by the local gateway, so it exists in the database " +
        "but not on chain; redeploy this record's contract to transact on it.",
    );
  }
}

/**
 * Build a spec-aware client for an already-deployed contract. The `publicKey`
 * is the transaction source for simulation and the signing account for writes.
 */
export async function getContractClient(
  contractId: string,
  signer: Signer,
): Promise<contract.Client> {
  assertDeployedContractId(contractId);
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
 * Build a spec-aware client whose transaction source is an arbitrary account
 * the server holds no key for. Used to assemble transactions a *user's* wallet
 * will sign: the contract's `require_auth()` on that address is satisfied by
 * the source-account credentials Soroban derives from the envelope signature,
 * so no separate auth-entry signing is needed.
 *
 * No `signTransaction` is supplied — this client can simulate and build, and
 * will throw if anything tries to make it sign.
 */
export async function getUnsignedContractClient(
  contractId: string,
  sourceAddress: string,
): Promise<contract.Client> {
  assertDeployedContractId(contractId);
  return contract.Client.from({
    contractId,
    rpcUrl: config.SOROBAN_RPC_URL,
    networkPassphrase: networkPassphrase(),
    allowHttp: allowHttp(),
    publicKey: sourceAddress,
  });
}

/** A built-and-simulated transaction awaiting a wallet signature. */
export interface UnsignedTransaction {
  xdr: string;
  networkPassphrase: string;
  sourceAddress: string;
}

/**
 * Serialize an assembled transaction for client-side signing.
 *
 * Guards the assumption the whole wallet-signing flow rests on: that the
 * envelope signature alone authorizes the call. If simulation produced auth
 * entries belonging to any *other* address, a plain envelope signature is not
 * enough and submitting would fail on-chain after the user had already signed.
 * Failing here instead keeps that impossible.
 */
export function toUnsignedTransaction<T>(
  tx: ContractTx<T>,
  sourceAddress: string,
): UnsignedTransaction {
  const others = tx.needsNonInvokerSigningBy();
  if (others.length > 0) {
    throw new ChainError(
      "This contract call needs signatures from additional addresses " +
        `(${others.join(", ")}); a single wallet signature cannot authorize it.`,
    );
  }
  return {
    xdr: tx.toXDR(),
    networkPassphrase: networkPassphrase(),
    sourceAddress,
  };
}

/**
 * Does this error mean "no such contract", as opposed to "we could not ask"?
 *
 * `contract.Client.from` fetches the contract spec over RPC, so its failures
 * cover two very different situations: a contract id that genuinely is not on
 * the network, and a network that did not answer. Treating the second as the
 * first is how a reconciliation run reports "matched" during an RPC outage —
 * it reads every custody instance as unknown and skips the comparison. Only
 * the first is safe to swallow.
 */
export function isMissingContractError(err: unknown): boolean {
  if (err instanceof ChainError) return false;
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /not found|no such contract|MissingValue|invalid contract id|could not obtain contract|does not exist/i.test(
    message,
  );
}

/**
 * Unwrap a contract call's `Result<T, E>`, turning a contract-level `Err` into
 * a {@link ChainError} naming the call.
 *
 * The spec-generated client does NOT throw for a Rust `Err` return: it parses
 * it into the result. A write whose result is never inspected therefore
 * "succeeds" in TypeScript while the contract refused it — the books then
 * record a movement the chain declined.
 */
export function unwrapContractResult<T>(label: string, result: unknown): T {
  if (!isContractResult<T>(result)) {
    // A non-Result return type (e.g. a plain value): nothing to unwrap.
    return result as T;
  }
  if (result.isErr()) {
    const error: unknown = result.unwrapErr();
    const detail =
      error instanceof Error
        ? error.message
        : typeof error === "object" && error !== null && "message" in error
          ? String((error as { message: unknown }).message)
          : String(error);
    throw new ChainError(`The contract rejected ${label}: ${detail}`);
  }
  return result.unwrap();
}

/**
 * Sign, submit, and *verify* a contract write, returning the transaction hash.
 *
 * Three things have to hold before a write may be recorded as having happened:
 * the simulation did not come back as a contract `Err`, the network accepted
 * the envelope, and the settled invocation did not itself return `Err`. Any
 * write that skips these checks can silently no-op.
 */
export async function signAndSendChecked<T>(
  label: string,
  tx: ContractTx<T>,
): Promise<string> {
  // Simulation result: a contract-level rejection is visible here, before any
  // fee is paid and before the books are told anything happened.
  unwrapContractResult(label, tx.result);

  const sent = await tx.signAndSend();
  const hash = sent.sendTransactionResponse?.hash;
  if (!hash) {
    throw new ChainError(`The ${label} transaction was not accepted by the network`);
  }
  // Settled result: simulation is a prediction, this is what actually ran.
  unwrapContractResult(label, sent.result);
  return hash;
}

function isContractResult<T>(value: unknown): value is contract.Result<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "isErr" in value &&
    typeof (value as { isErr: unknown }).isErr === "function"
  );
}

export interface SubmittedTransaction {
  hash: string;
  status: ChainTxStatus;
}

/**
 * Submit a wallet-signed envelope and wait for the ledger to close on it.
 *
 * Deliberately synchronous-until-final: the caller commits ledger entries based
 * on the outcome, and recording a release against a transaction that later
 * fails would put the ledger out of step with custody.
 */
export async function submitSignedTransaction(
  signedXdr: string,
): Promise<SubmittedTransaction> {
  const passphrase = networkPassphrase();
  let envelope;
  try {
    envelope = TransactionBuilder.fromXDR(signedXdr, passphrase);
  } catch (err) {
    throw new ChainError("Signed transaction envelope is not valid XDR", err);
  }

  const server = getRpcServer();
  const sent = await server.sendTransaction(envelope);
  if (sent.status === "ERROR") {
    throw new ChainError(
      "Stellar rejected the transaction: " +
        (sent.errorResult?.result().switch().name ?? "unknown error"),
    );
  }
  if (sent.status === "TRY_AGAIN_LATER") {
    throw new ChainError(
      "Stellar is congested and asked us to retry; the transaction was not " +
        "submitted. Sign and submit again.",
    );
  }
  // PENDING or DUPLICATE: the network has the transaction, so poll it to a
  // final state. DUPLICATE means a retry of an already-submitted envelope,
  // which is exactly what we want to be idempotent about.

  const settled = await server.pollTransaction(sent.hash, {
    attempts: 30,
    sleepStrategy: () => 1_000,
  });
  return { hash: sent.hash, status: toChainTxStatus(settled.status) };
}

/** Look a transaction up on-chain. `undefined` means the RPC has never seen it. */
export async function getTransactionStatus(
  hash: string,
): Promise<ChainTxStatus | undefined> {
  const result = await getRpcServer().getTransaction(hash);
  return result.status === rpc.Api.GetTransactionStatus.NOT_FOUND
    ? undefined
    : toChainTxStatus(result.status);
}

function toChainTxStatus(status: rpc.Api.GetTransactionStatus): ChainTxStatus {
  switch (status) {
    case rpc.Api.GetTransactionStatus.SUCCESS:
      return ChainTxStatus.Success;
    case rpc.Api.GetTransactionStatus.FAILED:
      return ChainTxStatus.Failed;
    default:
      return ChainTxStatus.Pending;
  }
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
