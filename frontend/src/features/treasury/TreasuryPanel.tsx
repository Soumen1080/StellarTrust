"use client";

/**
 * Funding and withdrawing a platform balance (plane.md §4.5).
 *
 * Since per-user ledger accounts landed, an investor cannot buy units without
 * a balance — the purchase is refused for want of funds, correctly. This is
 * where a balance comes from, and it has to be honest about what a deposit
 * actually is.
 *
 * **A deposit is a claim the platform verifies, not an instruction it obeys.**
 * The user sends XLM from their own wallet to the platform's address, then
 * gives the transaction hash. The platform reads that transaction from the
 * chain and credits exactly what arrived, from exactly the wallet they signed
 * in with. There is no amount field, deliberately — an amount field would
 * imply the number is theirs to choose, and the first thing someone would try
 * is a larger one.
 */
import { useCallback, useEffect, useState } from "react";
import {
  LEDGER_CURRENCY_DECIMALS,
  type CurrencyCode,
  type TreasuryBalanceDTO,
  type TreasuryMovementDTO,
} from "@stellartrust/shared";
import { api } from "@/lib/api";
import { useIdentity } from "@/components/IdentityProvider";
import { StatusPill } from "@/components/StatusPill";
import { fromMinorUnits, toMinorUnits } from "@/lib/money";
import { WalletBalances } from "@/features/wallet/WalletBalances";

/** Currencies a balance can be held in. XLM is always available on testnet. */
const FUNDABLE: CurrencyCode[] = ["XLM", "USDC"] as CurrencyCode[];

export function TreasuryPanel() {
  const { session } = useIdentity();
  const accessToken = session?.accessToken;

  const [balances, setBalances] = useState<TreasuryBalanceDTO[]>([]);
  const [movements, setMovements] = useState<TreasuryMovementDTO[]>([]);
  const [depositAddress, setDepositAddress] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) {
      setLoading(false);
      return;
    }
    try {
      const [balanceResponse, movementResponse, address] = await Promise.all([
        api.treasuryBalances(accessToken),
        api.treasuryMovements(accessToken),
        api.treasuryDepositAddress(accessToken),
      ]);
      setBalances(balanceResponse.balances);
      setMovements(movementResponse.movements);
      setDepositAddress(address.address);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your balance");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!accessToken) {
    return (
      <section className="panel-dark p-lg">
        <h2 className="font-semibold text-on-dark">Balance</h2>
        <p className="mt-sm text-sm text-muted-strong">
          Connect a wallet to fund an account balance.
        </p>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-lg">
      <section className="panel-dark p-lg">
        <h2 className="font-semibold text-on-dark">Your balance</h2>
        <p className="mt-xs text-sm text-muted-strong">
          What you can invest with. Held in the platform&rsquo;s double-entry
          ledger, backed by funds you deposited on-chain.
        </p>

        {loading ? (
          <p className="mt-md text-sm text-muted">Loading…</p>
        ) : balances.length === 0 ? (
          <p className="mt-md text-sm text-muted">
            No balance yet. Deposit below to start investing.
          </p>
        ) : (
          <dl className="mt-md grid gap-md sm:grid-cols-2">
            {balances.map((balance) => (
              <div
                key={balance.currency}
                className="rounded-lg border border-hairline-dark p-md"
              >
                <dt className="text-xs font-medium uppercase tracking-wider text-muted-strong">
                  {balance.currency}
                </dt>
                <dd className="mt-xs font-mono text-2xl font-bold tabular-nums text-on-dark">
                  {fromMinorUnits(
                    balance.balance,
                    balance.currency,
                  ).toLocaleString(undefined, {
                    maximumFractionDigits:
                      LEDGER_CURRENCY_DECIMALS[balance.currency],
                  })}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-status-rejected/30 bg-status-rejected/5 px-md py-sm text-sm text-status-rejected"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p
          role="status"
          className="rounded-md border border-value-up/30 bg-value-up/5 px-md py-sm text-sm text-value-up"
        >
          {notice}
        </p>
      ) : null}

      <div className="grid gap-lg lg:grid-cols-2">
        <DepositForm
          accessToken={accessToken}
          depositAddress={depositAddress}
          onDone={(message) => {
            setNotice(message);
            setError(null);
            void load();
          }}
          onError={(message) => {
            setError(message);
            setNotice(null);
          }}
        />
        <WithdrawForm
          accessToken={accessToken}
          balances={balances}
          onDone={(message) => {
            setNotice(message);
            setError(null);
            void load();
          }}
          onError={(message) => {
            setError(message);
            setNotice(null);
          }}
        />
      </div>

      {/* The wallet's own on-chain balances, distinct from the platform
          balance above: one is what the user holds themselves, the other is
          what they have deposited to invest with. Showing them together is
          what makes the difference legible — and it is how someone checks they
          actually have the XLM to deposit in the first place. */}
      <WalletBalances accessToken={accessToken} refreshKey={movements.length} />

      <section className="panel-dark p-lg">
        <h2 className="font-semibold text-on-dark">Movements</h2>
        {movements.length === 0 ? (
          <p className="mt-sm text-sm text-muted">Nothing yet.</p>
        ) : (
          <div className="mt-md overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-hairline-dark">
                  {["Direction", "Amount", "Status", "Transaction", "When"].map(
                    (column) => (
                      <th
                        key={column}
                        scope="col"
                        className="pb-xs pr-md text-xs font-medium uppercase tracking-wider text-muted-strong"
                      >
                        {column}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {movements.map((movement) => (
                  <tr
                    key={movement.id}
                    className="border-b border-hairline-dark/50 last:border-0"
                  >
                    <td className="py-sm pr-md capitalize text-body">
                      {movement.direction}
                    </td>
                    <td className="py-sm pr-md font-mono tabular-nums text-body">
                      {fromMinorUnits(
                        movement.amount,
                        movement.currency,
                      ).toLocaleString()}{" "}
                      <span className="text-xs text-muted">
                        {movement.currency}
                      </span>
                    </td>
                    <td className="py-sm pr-md">
                      <StatusPill status={movement.status} />
                      {movement.failureReason ? (
                        <span className="mt-xxs block text-xs text-muted">
                          {movement.failureReason}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-sm pr-md">
                      {movement.stellarTxHash ? (
                        <a
                          href={`https://stellar.expert/explorer/testnet/tx/${movement.stellarTxHash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-xs text-primary hover:underline"
                        >
                          {movement.stellarTxHash.slice(0, 10)}…
                        </a>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="py-sm pr-md font-mono text-xs text-muted-strong">
                      {new Date(movement.createdAt).toLocaleString(undefined, {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function DepositForm({
  accessToken,
  depositAddress,
  onDone,
  onError,
}: {
  accessToken: string;
  depositAddress: string | null;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [txHash, setTxHash] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const movement = await api.claimDeposit(accessToken, crypto.randomUUID(), {
        stellarTxHash: txHash.trim(),
      });
      setTxHash("");
      onDone(
        `Credited ${fromMinorUnits(movement.amount, movement.currency)} ${
          movement.currency
        }.`,
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not credit that deposit");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="panel-dark p-lg">
      <h2 className="font-semibold text-on-dark">Deposit</h2>
      <ol className="mt-md flex flex-col gap-md text-sm text-muted-strong">
        <li>
          <span className="font-medium text-body">
            1. Send funds to the platform
          </span>
          <p className="mt-xs">
            From the wallet you signed in with — a payment from any other wallet
            cannot be credited to you.
          </p>
          {depositAddress ? (
            <div className="mt-xs flex items-center gap-xs">
              <code className="min-w-0 flex-1 break-all rounded-md border border-hairline-dark bg-canvas-dark px-sm py-xs font-mono text-xs text-body">
                {depositAddress}
              </code>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(depositAddress);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 2000);
                }}
                className="shrink-0 rounded-md border border-hairline-dark px-sm py-xs text-xs text-muted-strong transition-colors hover:text-on-dark"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          ) : (
            <p className="mt-xs text-xs text-muted">Loading address…</p>
          )}
        </li>
        <li>
          <span className="font-medium text-body">
            2. Paste the transaction hash
          </span>
          <p className="mt-xs">
            The platform reads that transaction from the chain and credits
            exactly what arrived. There is no amount to enter — the chain is the
            source of truth, not this form.
          </p>
        </li>
      </ol>

      <form onSubmit={submit} className="mt-md flex flex-col gap-sm">
        <label htmlFor="deposit-tx" className="sr-only">
          Stellar transaction hash
        </label>
        <input
          id="deposit-tx"
          type="text"
          value={txHash}
          onChange={(event) => setTxHash(event.target.value)}
          placeholder="64-character transaction hash"
          spellCheck={false}
          className="w-full rounded-md border border-hairline-dark bg-canvas-dark px-sm py-sm font-mono text-sm text-body placeholder:text-muted"
        />
        <button
          type="submit"
          disabled={submitting || !/^[0-9a-fA-F]{64}$/.test(txHash.trim())}
          className="btn-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? "Verifying…" : "Credit deposit"}
        </button>
      </form>
    </section>
  );
}

function WithdrawForm({
  accessToken,
  balances,
  onDone,
  onError,
}: {
  accessToken: string;
  balances: TreasuryBalanceDTO[];
  onDone: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [currency, setCurrency] = useState<CurrencyCode>(
    (balances[0]?.currency ?? "XLM") as CurrencyCode,
  );
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const held = balances.find((balance) => balance.currency === currency);
  const minor = toMinorUnits(amount, currency);
  const overBalance =
    minor !== null && held !== undefined && BigInt(minor) > BigInt(held.balance);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (minor === null) return;
    setSubmitting(true);
    try {
      const movement = await api.withdraw(accessToken, crypto.randomUUID(), {
        amount: minor,
        currency,
        // Blank means "the wallet I signed in with", which the server resolves
        // itself. Sending an empty string would fail address validation.
        ...(destination.trim() ? { destinationAddress: destination.trim() } : {}),
      });
      setAmount("");
      setDestination("");
      onDone(
        movement.status === "pending"
          ? "Withdrawal submitted for compliance review. Nothing has been debited yet."
          : `Sent ${fromMinorUnits(movement.amount, movement.currency)} ${
              movement.currency
            }.`,
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not withdraw");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="panel-dark p-lg">
      <h2 className="font-semibold text-on-dark">Withdraw</h2>
      <p className="mt-xs text-sm text-muted-strong">
        Paid out on-chain. Large withdrawals wait for a compliance decision
        before any funds move.
      </p>

      <form onSubmit={submit} className="mt-md flex flex-col gap-sm">
        <div className="flex gap-sm">
          <div className="flex-1">
            <label
              htmlFor="withdraw-amount"
              className="block text-sm font-medium text-body"
            >
              Amount
            </label>
            <input
              id="withdraw-amount"
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0.00"
              className="mt-xs w-full rounded-md border border-hairline-dark bg-canvas-dark px-sm py-sm font-mono text-sm text-body placeholder:text-muted"
            />
          </div>
          <div>
            <label
              htmlFor="withdraw-currency"
              className="block text-sm font-medium text-body"
            >
              Currency
            </label>
            <select
              id="withdraw-currency"
              value={currency}
              onChange={(event) =>
                setCurrency(event.target.value as CurrencyCode)
              }
              className="mt-xs rounded-md border border-hairline-dark bg-canvas-dark px-sm py-sm text-sm text-body"
            >
              {FUNDABLE.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label
            htmlFor="withdraw-destination"
            className="block text-sm font-medium text-body"
          >
            Destination{" "}
            <span className="font-normal text-muted">
              (optional — defaults to your wallet)
            </span>
          </label>
          <input
            id="withdraw-destination"
            type="text"
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            placeholder="G…"
            spellCheck={false}
            className="mt-xs w-full rounded-md border border-hairline-dark bg-canvas-dark px-sm py-sm font-mono text-sm text-body placeholder:text-muted"
          />
        </div>

        {held ? (
          <p className="text-xs text-muted">
            Available:{" "}
            <span className="font-mono">
              {fromMinorUnits(held.balance, currency).toLocaleString()}{" "}
              {currency}
            </span>
          </p>
        ) : (
          <p className="text-xs text-muted">
            You hold no {currency} balance yet.
          </p>
        )}
        {overBalance ? (
          <p role="alert" className="text-xs text-value-down">
            That is more than you hold.
          </p>
        ) : null}
        {amount.trim() && minor === null ? (
          <p role="alert" className="text-xs text-value-down">
            {currency} amounts take at most{" "}
            {LEDGER_CURRENCY_DECIMALS[currency]} decimal places.
          </p>
        ) : null}

        <button
          type="submit"
          disabled={submitting || minor === null || minor === "0" || overBalance}
          className="btn-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? "Submitting…" : "Withdraw"}
        </button>
      </form>
    </section>
  );
}
