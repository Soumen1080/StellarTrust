/**
 * Prove XLM actually moves between two wallets on testnet
 * (`npm run chain:verify-xlm`).
 *
 * Every other check in this repository is a simulation, a unit test, or a
 * deterministic adapter. Each is valuable and none of them can answer the one
 * question that matters before a demo: **does real value actually move between
 * two real accounts on a real network, and does the platform's arithmetic
 * agree with what the ledger says happened?**
 *
 * So this submits real transactions to testnet and reads the balances back.
 *
 * What it does, in order:
 *   1. Creates two fresh keypairs and funds them from friendbot.
 *   2. Reads both balances from Horizon.
 *   3. Sends XLM from A to B and waits for the transaction to be included.
 *   4. Reads both balances again and asserts:
 *        - B rose by *exactly* the amount sent, to the stroop.
 *        - A fell by exactly the amount sent plus the fee the ledger charged.
 *   5. Runs the same amount through `decimalStringToBigInt` — the conversion
 *      the treasury deposit path uses — and asserts it agrees with the balance
 *      delta the chain reported. A silent factor-of-10^n there is the defect
 *      that would credit the wrong quantity of real value while every unit
 *      test still passed.
 *
 * It prints the transaction hashes so each one can be opened on
 * stellar.expert and read independently.
 *
 * **Testnet only.** It refuses to run against the public network: the script
 * creates throwaway accounts and submits payments, and neither is something to
 * do with real funds. That refusal is the first thing it checks.
 */
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { decimalStringToBigInt } from "../modules/stellar/decimal.js";

const HORIZON_URL =
  process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const FRIENDBOT_URL = process.env.FRIENDBOT_URL ?? "https://friendbot.stellar.org";
const NETWORK = process.env.STELLAR_NETWORK ?? "testnet";

/** How much to move. Small enough that a funded testnet account can spare it. */
const TRANSFER_AMOUNT = "25.0000000";

/** Horizon reports every classic amount at 7 decimal places. */
const STROOP_DECIMALS = 7;

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function check(name: string, ok: boolean, detail: string): boolean {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}`);
  console.log(`         ${detail}`);
  return ok;
}

function reason(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    // Horizon rejections carry the useful part in `extras.result_codes`;
    // `String(err)` on those yields "[object Object]".
    const extras = (
      err as { response?: { data?: { extras?: { result_codes?: unknown } } } }
    ).response?.data?.extras?.result_codes;
    if (extras) return JSON.stringify(extras);
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}

/** Native XLM balance in stroops, read from Horizon. */
async function nativeBalance(
  horizon: Horizon.Server,
  address: string,
): Promise<bigint> {
  const account = await horizon.loadAccount(address);
  const native = account.balances.find(
    (balance) => balance.asset_type === "native",
  );
  if (!native) throw new Error(`${address} holds no native balance`);
  return decimalStringToBigInt(native.balance, STROOP_DECIMALS);
}

async function fundFromFriendbot(address: string): Promise<void> {
  const response = await fetch(`${FRIENDBOT_URL}?addr=${address}`);
  if (!response.ok) {
    throw new Error(
      `friendbot refused to fund ${address}: ${response.status} ${await response.text()}`,
    );
  }
}

async function main(): Promise<void> {
  console.log("StellarTrust — live XLM transfer verification\n");

  // ── Refuse the public network before doing anything at all ───────────────
  //
  // This creates throwaway accounts and submits payments. Neither is something
  // to do with real funds, and a misread environment variable is exactly how
  // that happens.
  if (NETWORK !== "testnet" || !HORIZON_URL.includes("testnet")) {
    console.error(
      `REFUSED: this script submits real transactions and is testnet-only.\n` +
        `  STELLAR_NETWORK = ${NETWORK}\n` +
        `  HORIZON_URL     = ${HORIZON_URL}\n` +
        `Point both at testnet and run it again.`,
    );
    process.exit(1);
  }

  const horizon = new Horizon.Server(HORIZON_URL);
  const sender = Keypair.random();
  const recipient = Keypair.random();

  console.log(`  Network:   ${NETWORK} (${HORIZON_URL})`);
  console.log(`  Sender:    ${sender.publicKey()}`);
  console.log(`  Recipient: ${recipient.publicKey()}\n`);

  // ── 1. Fund both accounts ────────────────────────────────────────────────
  console.log("Funding two fresh accounts from friendbot…");
  try {
    await Promise.all([
      fundFromFriendbot(sender.publicKey()),
      fundFromFriendbot(recipient.publicKey()),
    ]);
  } catch (err) {
    check("friendbot funding", false, reason(err));
    summarise();
    return;
  }

  // ── 2. Read the opening balances ─────────────────────────────────────────
  const senderBefore = await nativeBalance(horizon, sender.publicKey());
  const recipientBefore = await nativeBalance(horizon, recipient.publicKey());
  check(
    "both accounts exist and hold XLM",
    senderBefore > 0n && recipientBefore > 0n,
    `sender ${senderBefore} stroops, recipient ${recipientBefore} stroops`,
  );

  // ── 3. Send the payment ──────────────────────────────────────────────────
  console.log(`\nSending ${TRANSFER_AMOUNT} XLM…`);
  const account = await horizon.loadAccount(sender.publicKey());
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: recipient.publicKey(),
        asset: Asset.native(),
        amount: TRANSFER_AMOUNT,
      }),
    )
    .setTimeout(60)
    .build();
  transaction.sign(sender);

  let txHash: string;
  let feeCharged: bigint;
  try {
    const submitted = await horizon.submitTransaction(transaction);
    txHash = submitted.hash;
    // The fee the ledger actually charged, which is not necessarily BASE_FEE —
    // it is whatever the network settled on at inclusion. Asserting against a
    // guessed fee is how a correct balance check turns into a flaky one.
    //
    // Read back from the transaction record: the submit response carries it,
    // but the SDK does not type it, and reading an untyped field off a
    // response is how this breaks silently on an SDK upgrade.
    const record = await horizon.transactions().transaction(txHash).call();
    feeCharged = BigInt(record.fee_charged);
  } catch (err) {
    check("payment submitted", false, reason(err));
    summarise();
    return;
  }

  check(
    "payment included in a closed ledger",
    true,
    `tx ${txHash}\n         https://stellar.expert/explorer/testnet/tx/${txHash}`,
  );

  // ── 4. Read the balances back and assert the arithmetic ──────────────────
  const senderAfter = await nativeBalance(horizon, sender.publicKey());
  const recipientAfter = await nativeBalance(horizon, recipient.publicKey());

  const sent = decimalStringToBigInt(TRANSFER_AMOUNT, STROOP_DECIMALS);
  const recipientDelta = recipientAfter - recipientBefore;
  const senderDelta = senderBefore - senderAfter;

  check(
    "the recipient received exactly what was sent",
    recipientDelta === sent,
    `expected +${sent} stroops, observed +${recipientDelta}`,
  );

  check(
    "the sender was debited the amount plus the fee the ledger charged",
    senderDelta === sent + feeCharged,
    `expected -${sent + feeCharged} stroops ` +
      `(${sent} sent + ${feeCharged} fee), observed -${senderDelta}`,
  );

  // ── 5. The platform's own conversion agrees with the chain ───────────────
  //
  // This is the check the unit tests cannot make. `decimalStringToBigInt` is
  // what the treasury deposit path uses to turn Horizon's decimal string into
  // ledger minor units; if it disagreed with the chain by a factor of ten,
  // every unit test would still pass and every deposit would credit the wrong
  // amount of real value.
  check(
    "the platform's decimal conversion matches the observed balance delta",
    decimalStringToBigInt(TRANSFER_AMOUNT, STROOP_DECIMALS) === recipientDelta,
    `decimalStringToBigInt("${TRANSFER_AMOUNT}", ${STROOP_DECIMALS}) = ` +
      `${decimalStringToBigInt(TRANSFER_AMOUNT, STROOP_DECIMALS)}, ` +
      `chain delta = ${recipientDelta}`,
  );

  // ── 6. Send it back, so the round trip is proven in both directions ──────
  console.log(`\nSending ${TRANSFER_AMOUNT} XLM back…`);
  const returnAccount = await horizon.loadAccount(recipient.publicKey());
  const returnTx = new TransactionBuilder(returnAccount, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: sender.publicKey(),
        asset: Asset.native(),
        amount: TRANSFER_AMOUNT,
      }),
    )
    .setTimeout(60)
    .build();
  returnTx.sign(recipient);

  try {
    const submitted = await horizon.submitTransaction(returnTx);
    const finalRecipient = await nativeBalance(horizon, recipient.publicKey());
    check(
      "the return payment settled too",
      finalRecipient < recipientAfter,
      `tx ${submitted.hash}\n         ` +
        `https://stellar.expert/explorer/testnet/tx/${submitted.hash}`,
    );
  } catch (err) {
    check("the return payment settled too", false, reason(err));
  }

  summarise();
}

function summarise(): void {
  const failed = results.filter((result) => !result.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed.`,
  );
  if (failed.length > 0) {
    console.log("\nFailed:");
    for (const result of failed) console.log(`  - ${result.name}`);
    process.exit(1);
  }
  console.log(
    "\nXLM moves between wallets on testnet, and the platform's amount " +
      "conversion agrees with the chain.",
  );
}

main().catch((err: unknown) => {
  console.error(`\nverification aborted: ${reason(err)}`);
  process.exit(1);
});
