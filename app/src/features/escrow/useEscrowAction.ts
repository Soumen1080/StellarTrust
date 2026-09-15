/**
 * Performing one escrow step.
 *
 * A step is either signed by the server as arbiter, or by the acting party's
 * own wallet because the contract gates it on `require_auth()`. Which is which
 * is a property of the deployment, not of the step, so it is read from
 * `/api/payments/capabilities` rather than hardcoded.
 *
 * The wallet path is three calls — prepare, sign, submit — and the middle one
 * happens in a wallet the user may take a while to reach. The idempotency key
 * is minted before any of it and reused across retries, so a lost response on
 * `submit` cannot turn into a second on-chain transition.
 */
import {
  ChainSigningMode,
  type PaymentTransition,
} from "@stellartrust/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { api, type WalletSignedAction } from "../../api/client";
import { ApiClientError } from "../../api/errors";
import { useAccessToken } from "../../auth/AuthProvider";
import { signTransaction } from "../../auth/signer";
import { newIdempotencyKey } from "../../lib/idempotency";
import { queryKeys } from "../../lib/query";

/** Human-readable reason shown in the wallet's signing prompt. */
const SIGNING_REASON: Record<string, string> = {
  lock: "Lock funds in escrow",
  confirm: "Confirm delivery",
  dispute: "Raise a dispute",
  release: "Release funds to the seller",
  refund: "Refund the buyer",
};

export function useEscrowCapabilities() {
  const accessToken = useAccessToken();
  return useQuery({
    queryKey: queryKeys.paymentCapabilities(),
    queryFn: () => api.paymentCapabilities(accessToken),
    // A deployment's signing model does not change under a running session.
    staleTime: Infinity,
  });
}

export function useEscrowAction(orderId: string) {
  const accessToken = useAccessToken();
  const queryClient = useQueryClient();
  const capabilities = useEscrowCapabilities();

  /**
   * One key per (order, action) intent, held across retries.
   *
   * Keyed rather than single because a user may retry `confirm` after a failed
   * `lock`; those are different intents and must not share a key.
   */
  const keys = useRef(new Map<string, string>());
  const keyFor = useCallback((action: string): string => {
    const existing = keys.current.get(action);
    if (existing) return existing;
    const minted = newIdempotencyKey();
    keys.current.set(action, minted);
    return minted;
  }, []);

  const mutation = useMutation({
    mutationFn: async (action: PaymentTransition) => {
      const idempotencyKey = keyFor(action);
      const mode = capabilities.data?.signingModes[action];

      // Server-signed: one call, the backend signs as arbiter.
      if (mode !== ChainSigningMode.Wallet) {
        try {
          return await api.transitionOrder(
            accessToken,
            orderId,
            action,
            idempotencyKey,
          );
        } catch (err) {
          // A deployment can disagree with its own advertised mode — the
          // gateway answers 409 when it actually wants the party's key. Fall
          // through to the wallet path rather than failing at the user.
          if (!(err instanceof ApiClientError && err.status === 409)) throw err;
        }
      }

      const prepared = await api.prepareTransition(
        accessToken,
        orderId,
        action as WalletSignedAction,
      );

      const signedXdr = await signTransaction(
        prepared.unsignedXdr,
        prepared.networkPassphrase,
        {
          reason: SIGNING_REASON[action] ?? "Approve this transaction",
          expectedAddress: prepared.signerAddress,
        },
      );

      return api.submitSignedTransition(
        accessToken,
        orderId,
        action as WalletSignedAction,
        idempotencyKey,
        signedXdr,
      );
    },
    onSuccess: async (_data, action) => {
      // The intent completed; the next one starts with a fresh key.
      keys.current.delete(action);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.order(orderId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.orders() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.positions() }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.treasuryBalances(),
        }),
      ]);
    },
  });

  return {
    perform: mutation.mutate,
    performAsync: mutation.mutateAsync,
    pending: mutation.isPending,
    /** The action currently in flight, for per-button spinners. */
    pendingAction: mutation.isPending ? mutation.variables : undefined,
    error: mutation.error,
    reset: mutation.reset,
    capabilities: capabilities.data,
  };
}
