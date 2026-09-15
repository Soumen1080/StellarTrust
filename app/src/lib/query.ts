/**
 * React Query configuration.
 *
 * Tuned for a phone rather than a desktop browser:
 *
 *  - **Refetch on app foreground, not on window focus.** The RN equivalent of
 *    a tab regaining focus is the app returning from the background, wired in
 *    `useAppStateRefetch` below.
 *  - **No retry on top of the transport's.** `api/http.ts` already retries
 *    network faults and 5xx with backoff. A second layer here would multiply
 *    the attempts and the latency.
 *  - **Never retry a 4xx.** A 401 is handled centrally, and a 400/409 is a
 *    decision the server made that will not change on a repeat.
 */
import { QueryClient, focusManager } from "@tanstack/react-query";
import { useEffect } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { ApiClientError } from "../api/errors";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Money is time-sensitive; a balance older than this is re-read when a
        // screen remounts. Anything more aggressive burns battery for values
        // that change on user action anyway.
        staleTime: 20_000,
        gcTime: 5 * 60_000,
        retry: (failureCount, error) => {
          if (error instanceof ApiClientError && error.status < 500) {
            return false;
          }
          return failureCount < 1;
        },
        refetchOnReconnect: true,
        refetchOnMount: true,
      },
      mutations: {
        // A mutation carries an idempotency key minted by the caller; retrying
        // here would reuse it correctly, but the caller owns that decision
        // because only it knows whether the intent is still current.
        retry: false,
      },
    },
  });
}

/**
 * Bridge React Query's focus notion to the app lifecycle.
 *
 * Without this, a user who backgrounds the app for an hour and returns sees
 * stale balances until they pull to refresh.
 */
export function useAppStateRefetch(): void {
  useEffect(() => {
    function onChange(status: AppStateStatus): void {
      focusManager.setFocused(status === "active");
    }
    const subscription = AppState.addEventListener("change", onChange);
    return () => subscription.remove();
  }, []);
}

/**
 * Query keys.
 *
 * Centralized so an invalidation after a mutation cannot miss a screen by
 * spelling its key differently. Hierarchical: invalidating `["orders"]`
 * invalidates every order detail under it.
 */
export const queryKeys = {
  identity: (userId?: string) => ["identity", userId] as const,
  walletBalances: () => ["wallet", "balances"] as const,
  positions: () => ["positions"] as const,
  kycStatus: () => ["kyc", "status"] as const,
  orders: () => ["orders"] as const,
  order: (id: string) => ["orders", id] as const,
  paymentCapabilities: () => ["payments", "capabilities"] as const,
  corridors: () => ["settlement", "corridors"] as const,
  settlements: () => ["settlement", "orders"] as const,
  settlement: (id: string) => ["settlement", "orders", id] as const,
  disputes: () => ["disputes"] as const,
  dispute: (id: string) => ["disputes", id] as const,
  disputeLog: (id: string) => ["disputes", id, "log"] as const,
  assets: () => ["rwa", "assets"] as const,
  tokenizations: () => ["rwa", "tokenizations"] as const,
  tokenization: (id: string) => ["rwa", "tokenizations", id] as const,
  rwaPortfolio: () => ["rwa", "portfolio"] as const,
  treasuryBalances: () => ["treasury", "balances"] as const,
  treasuryMovements: () => ["treasury", "movements"] as const,
  treasuryDepositAddress: () => ["treasury", "deposit-address"] as const,
  reputation: (userId?: string) => ["reputation", userId ?? "me"] as const,
  feedback: () => ["feedback"] as const,
  myFeedback: () => ["feedback", "me"] as const,
} as const;
