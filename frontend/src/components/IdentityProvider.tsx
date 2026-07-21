"use client";

import {
  KycStatus,
  type AuthSessionResponse,
  type IdentityProfileResponse,
} from "@stellartrust/shared";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ApiClientError, api } from "@/lib/api";
import { AUTH_SESSION_CHANGE_EVENT, clearSession, loadSession } from "@/lib/wallet-auth";

interface IdentityContextValue {
  session: AuthSessionResponse | null;
  profile: IdentityProfileResponse | null;
  loading: boolean;
  error: string | null;
  isVerified: boolean;
  refreshProfile: () => Promise<IdentityProfileResponse | null>;
}

const IdentityContext = createContext<IdentityContextValue | null>(null);

export function IdentityProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<AuthSessionResponse | null>(null);
  const [profile, setProfile] = useState<IdentityProfileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);

  const loadIdentity = useCallback(async () => {
    const version = ++requestVersion.current;
    const activeSession = loadSession();
    setSession(activeSession);
    setError(null);

    if (!activeSession) {
      setProfile(null);
      setLoading(false);
      return null;
    }

    setLoading(true);
    try {
      const identity = await api.getIdentity(activeSession.accessToken);
      if (version !== requestVersion.current) return null;
      setProfile(identity);
      return identity;
    } catch (err) {
      if (version !== requestVersion.current) return null;
      if (err instanceof ApiClientError && err.status === 401) {
        clearSession();
        return null;
      }
      setProfile(null);
      setError(err instanceof Error ? err.message : "Could not load your account");
      return null;
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadIdentity();
    const handleSessionChange = () => void loadIdentity();
    window.addEventListener(AUTH_SESSION_CHANGE_EVENT, handleSessionChange);
    return () => window.removeEventListener(AUTH_SESSION_CHANGE_EVENT, handleSessionChange);
  }, [loadIdentity]);

  const value = useMemo<IdentityContextValue>(
    () => ({
      session,
      profile,
      loading,
      error,
      isVerified: profile?.user.kycStatus === KycStatus.Verified,
      refreshProfile: loadIdentity,
    }),
    [error, loadIdentity, loading, profile, session],
  );

  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>;
}

export function useIdentity(): IdentityContextValue {
  const value = useContext(IdentityContext);
  if (!value) throw new Error("useIdentity must be used inside IdentityProvider");
  return value;
}
