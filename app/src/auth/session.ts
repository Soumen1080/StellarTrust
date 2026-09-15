/**
 * SEP-10 session lifecycle.
 *
 * The web client keeps its token in `sessionStorage`, which dies with the tab.
 * A phone has no equivalent: the app is backgrounded and resumed constantly,
 * and re-authenticating on every resume would mean a biometric prompt every
 * few minutes. So the token is kept in the device keystore instead — the same
 * protection as the wallet key — and is treated as expired the moment its own
 * `expiresAt` passes, which the server enforces regardless.
 */
import type { AuthSessionResponse } from "@stellartrust/shared";
import * as SecureStore from "expo-secure-store";
import { api } from "../api/client";
import { signTransaction } from "./signer";
import { setWalletKind, type WalletKind } from "./signer";

const SESSION_KEY = "stellartrust.session";

/**
 * Refresh margin.
 *
 * A token that expires in the next two minutes is treated as already gone, so
 * a long chain call started now cannot land after the token dies.
 */
const EXPIRY_MARGIN_MS = 120_000;

export function isExpired(session: AuthSessionResponse): boolean {
  return Date.parse(session.expiresAt) - EXPIRY_MARGIN_MS <= Date.now();
}

export async function saveSession(session: AuthSessionResponse): Promise<void> {
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

/** The stored session, or null when absent, corrupt, or expired. */
export async function loadSession(): Promise<AuthSessionResponse | null> {
  const raw = await SecureStore.getItemAsync(SESSION_KEY);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as AuthSessionResponse;
    if (!session?.accessToken || isExpired(session)) {
      await clearSession();
      return null;
    }
    return session;
  } catch {
    await clearSession();
    return null;
  }
}

export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_KEY);
}

/**
 * Prove control of `address` and exchange the proof for a session.
 *
 * This is the real SEP-10 handshake, identical to the one the web client runs:
 * the server issues a challenge transaction, the wallet signs it, and the
 * server verifies the signature against the account before issuing a token.
 * Nothing here is simulated — a wrong key produces a 401 from the API.
 */
export async function signInWithWallet(
  address: string,
  kind: WalletKind,
): Promise<AuthSessionResponse> {
  const challenge = await api.createSep10Challenge(address);

  const signedXdr = await signTransaction(
    challenge.transactionXdr,
    challenge.networkPassphrase,
    {
      reason: "Sign in to StellarTrust",
      expectedAddress: address,
    },
  );

  const session = await api.verifySep10Challenge(
    challenge.challengeId,
    signedXdr,
  );

  // Recorded only after the server accepted the proof, so a failed attempt
  // does not leave the app believing it has a usable wallet.
  await setWalletKind(kind);
  await saveSession(session);
  return session;
}
