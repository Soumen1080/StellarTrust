/**
 * Authentication and identity context.
 *
 * Holds the one answer every screen needs: is there a live session, whose is
 * it, and is that person verified. Screens read it; they never reach into the
 * keystore themselves.
 *
 * The profile is fetched through React Query rather than kept in state here,
 * so a verification that completes while the user is looking at another screen
 * propagates on the next refetch instead of going stale until sign-out.
 */
import type {
  AuthSessionResponse,
  IdentityProfileResponse,
} from "@stellartrust/shared";
import { KycStatus } from "@stellartrust/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "../api/client";
import { onSessionExpired } from "../api/http";
import { registerForPush, unregisterPush } from "../lib/notifications";
import { disconnectExternalWallet } from "./wallet-connect";
import {
  clearSession,
  loadSession,
  saveSession,
  signInWithWallet,
} from "./session";
import { clearWalletKind, type WalletKind } from "./signer";

interface AuthContextValue {
  session: AuthSessionResponse | null;
  /** Null until the stored session has been read — screens must not flash. */
  restoring: boolean;
  profile: IdentityProfileResponse | null;
  profileLoading: boolean;
  profileError: Error | null;
  /** Verified identity, the gate on every money-moving surface. */
  isVerified: boolean;
  signIn: (address: string, kind: WalletKind) => Promise<AuthSessionResponse>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  /** Convenience for callers that need the bearer token. */
  accessToken: string | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSessionResponse | null>(null);
  const [restoring, setRestoring] = useState(true);
  const queryClient = useQueryClient();
  // Held so sign-out can deregister this exact device.
  const pushTokenRef = useRef<string | null>(null);

  // Restore a stored session once at startup.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await loadSession();
      if (!cancelled) {
        setSession(stored);
        setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signOut = useCallback(async () => {
    // Deregister before the token is discarded — afterwards there is no
    // credential left to authenticate the call.
    const currentToken = session?.accessToken;
    const pushToken = pushTokenRef.current;
    if (currentToken && pushToken) {
      await unregisterPush(currentToken, pushToken);
    }
    pushTokenRef.current = null;

    setSession(null);
    await clearSession();
    await clearWalletKind();
    await disconnectExternalWallet();
    // Nothing cached was public — drop all of it rather than leak one user's
    // orders into the next session on a shared handset.
    queryClient.clear();
  }, [queryClient, session]);

  /**
   * A 401 anywhere means the session is gone. Tearing it down centrally is
   * what keeps every screen from having to handle expiry on its own.
   */
  useEffect(() => onSessionExpired(() => void signOut()), [signOut]);

  const signIn = useCallback(
    async (address: string, kind: WalletKind) => {
      const next = await signInWithWallet(address, kind);
      setSession(next);
      await saveSession(next);
      return next;
    },
    [],
  );

  const accessToken = session?.accessToken ?? null;

  /**
   * Register for push once there is a session.
   *
   * After sign-in rather than at launch: the OS prompt is asked once and
   * declining is permanent, so it is worth asking only when the user has
   * something to be notified about.
   */
  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    void (async () => {
      const token = await registerForPush(accessToken);
      if (!cancelled) pushTokenRef.current = token;
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  const {
    data: profile,
    isLoading: profileLoading,
    error: profileError,
    refetch,
  } = useQuery({
    queryKey: ["identity", session?.user.id],
    queryFn: () => api.getIdentity(accessToken as string),
    enabled: Boolean(accessToken),
    staleTime: 30_000,
  });

  const refreshProfile = useCallback(async () => {
    await refetch();
  }, [refetch]);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      restoring,
      profile: profile ?? null,
      profileLoading,
      profileError: (profileError as Error | null) ?? null,
      isVerified:
        profile?.latestVerification?.status === KycStatus.Verified ||
        profile?.user.kycStatus === KycStatus.Verified,
      signIn,
      signOut,
      refreshProfile,
      accessToken,
    }),
    [
      session,
      restoring,
      profile,
      profileLoading,
      profileError,
      signIn,
      signOut,
      refreshProfile,
      accessToken,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>.");
  return ctx;
}

/**
 * The bearer token, asserted non-null.
 *
 * For screens that only render behind the authenticated navigator, where a
 * null token is a routing bug rather than a state to handle.
 */
export function useAccessToken(): string {
  const { accessToken } = useAuth();
  if (!accessToken) {
    throw new Error("This screen requires an authenticated session.");
  }
  return accessToken;
}
