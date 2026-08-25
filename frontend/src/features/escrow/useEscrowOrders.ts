"use client";

/**
 * Escrow order state, live refresh, and the escrow action runner.
 *
 * Two things make this more than a fetch-and-render list:
 *
 *  1. Some steps need the user's own wallet. The escrow contract gates
 *     `initialize`, `confirm_delivery`, and `dispute` with the calling party's
 *     `require_auth()`, so those run prepare → sign → submit instead of a
 *     single request. Which steps those are is read from the server rather
 *     than hard-coded, because it depends on the configured gateway.
 *
 *  2. An order changes because of what a *counterparty* does — a seller
 *     accepting, an arbiter settling — with no event reaching this tab. So
 *     orders are polled while any of them is mid-flight, and the tab stops
 *     polling when it is hidden.
 */
import {
  OrderStatus,
  PaymentTransition,
  type AuthSessionResponse,
  type DisputeDTO,
  type OrderDetailsResponse,
  type PaymentCapabilitiesResponse,
} from "@stellartrust/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiClientError, type WalletSignedAction } from "@/lib/api";
import { signPreparedTransaction } from "@/lib/wallet-auth";

export type EscrowAction =
  | "accept"
  | "deposit"
  | "lock"
  | "confirm"
  | "release"
  | "dispute";

/** Where a running action has got to, so the UI can say something truthful. */
export type ActionPhase = "preparing" | "signing" | "submitting";

export interface RunningAction {
  orderId: string;
  action: EscrowAction;
  phase: ActionPhase;
}

/** Statuses that can still change without this user doing anything. */
const IN_FLIGHT: readonly string[] = [
  OrderStatus.Created,
  OrderStatus.Accepted,
  OrderStatus.Deposited,
  OrderStatus.Locked,
  OrderStatus.Confirmed,
  OrderStatus.Disputed,
];

const POLL_INTERVAL_MS = 12_000;

export const PHASE_LABEL: Record<ActionPhase, string> = {
  preparing: "Preparing transaction…",
  signing: "Confirm in your wallet…",
  submitting: "Submitting to Stellar…",
};

export function useEscrowOrders(session: AuthSessionResponse | null) {
  const [orders, setOrders] = useState<OrderDetailsResponse[]>([]);
  // Claims filed on these orders, by either side. An escrow card that cannot
  // say "there is a dispute on this order" sends the user hunting through a
  // separate page for a UUID they have to copy by hand.
  const [disputes, setDisputes] = useState<DisputeDTO[]>([]);
  const [capabilities, setCapabilities] =
    useState<PaymentCapabilitiesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<RunningAction | null>(null);
  // Guards against a slow in-flight refresh overwriting fresher state.
  const requestVersion = useRef(0);

  const refresh = useCallback(async () => {
    if (!session) return;
    const version = ++requestVersion.current;
    const [response, claims] = await Promise.all([
      api.listOrders(session.accessToken),
      // Dispute context is decoration on an order card: a failure here must
      // not take the orders down with it.
      api.listDisputes(session.accessToken).catch(() => ({ disputes: [] })),
    ]);
    if (version === requestVersion.current) {
      setOrders(response.orders);
      setDisputes(claims.disputes);
    }
  }, [session]);

  useEffect(() => {
    if (!session) {
      setOrders([]);
      setDisputes([]);
      setCapabilities(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [list, caps, claims] = await Promise.all([
          api.listOrders(session.accessToken),
          // Capabilities are advisory for the UI: if the lookup fails we still
          // show orders and fall back to the single-call path.
          api
            .paymentCapabilities(session.accessToken)
            .catch(() => null),
          api
            .listDisputes(session.accessToken)
            .catch(() => ({ disputes: [] })),
        ]);
        if (cancelled) return;
        setOrders(list.orders);
        setCapabilities(caps);
        setDisputes(claims.disputes);
      } catch (err) {
        if (!cancelled) setError(describe(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  const hasInFlight = useMemo(
    () => orders.some((item) => IN_FLIGHT.includes(String(item.order.status))),
    [orders],
  );

  // Live refresh. Only while something can actually change, only while the tab
  // is visible, and never on top of a running action (which refreshes itself).
  useEffect(() => {
    if (!session || !hasInFlight || running) return;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void refresh().catch(() => {
        // A transient poll failure is not worth interrupting the user over;
        // the next tick, or their next action, will surface a real problem.
      });
    };
    const timer = window.setInterval(tick, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [hasInFlight, refresh, running, session]);

  /**
   * True when this deployment requires a wallet signature for the step. Not a
   * type predicate: a `false` here means "the configured gateway signs this
   * server-side", not "this action can never need a wallet".
   */
  const needsWallet = useCallback(
    (action: EscrowAction): boolean =>
      capabilities?.walletSignedTransitions.includes(
        action as PaymentTransition,
      ) ?? false,
    [capabilities],
  );

  const runAction = useCallback(
    async (orderId: string, action: EscrowAction) => {
      if (!session || running) return;
      setError(null);
      try {
        if (needsWallet(action)) {
          const walletAction = action as WalletSignedAction;
          setRunning({ orderId, action, phase: "preparing" });
          const prepared = await api.prepareTransition(
            session.accessToken,
            orderId,
            walletAction,
          );

          setRunning({ orderId, action, phase: "signing" });
          const signedXdr = await signPreparedTransaction(
            prepared.unsignedXdr,
            prepared.networkPassphrase,
            prepared.signerAddress,
          );

          setRunning({ orderId, action, phase: "submitting" });
          await api.submitSignedTransition(
            session.accessToken,
            orderId,
            walletAction,
            crypto.randomUUID(),
            signedXdr,
          );
        } else if (action === "dispute") {
          // Server-signed deployments have their own dispute route. It reaches
          // the same contract call, which is what makes the escrow settleable
          // later — the contract's `release` accepts `Disputed` or a buyer
          // confirmation and nothing else.
          setRunning({ orderId, action, phase: "submitting" });
          await api.raiseDispute(
            session.accessToken,
            orderId,
            crypto.randomUUID(),
          );
        } else {
          setRunning({ orderId, action, phase: "submitting" });
          await api.transitionOrder(
            session.accessToken,
            orderId,
            action,
            crypto.randomUUID(),
          );
        }
        await refresh();
      } catch (err) {
        setError(describe(err));
        // The step may have landed on-chain even if the response did not reach
        // us, so re-read rather than leaving the row showing stale state.
        await refresh().catch(() => undefined);
      } finally {
        setRunning(null);
      }
    },
    [needsWallet, refresh, running, session],
  );

  /**
   * The dispute on an order, if any. Newest wins: an order can be disputed,
   * resolved, and disputed again, and the current claim is the relevant one.
   */
  const disputeForOrder = useMemo(() => {
    const byOrder = new Map<string, DisputeDTO>();
    for (const dispute of [...disputes].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    )) {
      byOrder.set(dispute.orderId, dispute);
    }
    return byOrder;
  }, [disputes]);

  return {
    orders,
    disputeForOrder,
    capabilities,
    loading,
    error,
    running,
    needsWallet,
    runAction,
    refresh,
    clearError: useCallback(() => setError(null), []),
  };
}

function describe(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  if (error instanceof Error) {
    // Wallet extensions reject with their own shapes; the common case is the
    // user closing the signing prompt, which is not an error worth alarming
    // them about.
    if (/user (rejected|declined|denied)|cancell?ed/i.test(error.message)) {
      return "Signing was cancelled in your wallet. Nothing was submitted.";
    }
    return error.message;
  }
  return "The escrow operation failed";
}
