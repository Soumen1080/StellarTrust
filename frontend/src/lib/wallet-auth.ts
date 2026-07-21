/** Browser-only Stellar Wallets Kit + SEP-10 authentication flow. */
import type { AuthSessionResponse } from "@stellartrust/shared";
import { api } from "./api";

const SESSION_KEY = "stellartrust.sep10.session";
export const AUTH_SESSION_CHANGE_EVENT = "stellartrust:auth-session-change";
let initialized = false;

function notifySessionChange(): void {
  window.dispatchEvent(new Event(AUTH_SESSION_CHANGE_EVENT));
}

async function loadKit() {
  const [{ Networks, StellarWalletsKit }, { defaultModules }] =
    await Promise.all([
      import("@creit.tech/stellar-wallets-kit"),
      import("@creit.tech/stellar-wallets-kit/modules/utils"),
    ]);
  if (!initialized) {
    StellarWalletsKit.init({
      modules: defaultModules(),
      network: Networks.TESTNET,
      authModal: {
        showInstallLabel: true,
        hideUnsupportedWallets: false,
      },
    });
    initialized = true;
  }
  return StellarWalletsKit;
}

export async function connectWalletAndSignIn(): Promise<AuthSessionResponse> {
  const kit = await loadKit();
  const { address } = await kit.authModal();
  const challenge = await api.createSep10Challenge(address);
  const { signedTxXdr } = await kit.signTransaction(
    challenge.transactionXdr,
    {
      networkPassphrase: challenge.networkPassphrase,
      address,
    },
  );
  const session = await api.verifySep10Challenge(
    challenge.challengeId,
    signedTxXdr,
  );
  saveSession(session);
  return session;
}

export function saveSession(session: AuthSessionResponse): void {
  // sessionStorage limits token lifetime to the current browser tab. The token is
  // never written to logs, URLs, localStorage, or source-controlled config.
  window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  notifySessionChange();
}

export function loadSession(): AuthSessionResponse | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as AuthSessionResponse;
    if (session.expiresAt <= new Date().toISOString()) {
      clearSession();
      return null;
    }
    return session;
  } catch {
    clearSession();
    return null;
  }
}

export async function disconnectWallet(): Promise<void> {
  clearSession();
  if (!initialized) return;
  const kit = await loadKit();
  await kit.disconnect();
}

export function clearSession(): void {
  if (typeof window !== "undefined") {
    const hadSession = window.sessionStorage.getItem(SESSION_KEY) !== null;
    window.sessionStorage.removeItem(SESSION_KEY);
    if (hadSession) notifySessionChange();
  }
}
