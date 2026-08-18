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

/**
 * Sign a server-prepared transaction with the connected wallet.
 *
 * Used for the escrow steps the contract gates with the party's own
 * `require_auth()` — locking funds, confirming delivery, raising a dispute.
 * The backend builds and submits; the private key never leaves the wallet.
 *
 * `expectedAddress` is the account the server assembled the transaction for.
 * If the user has since switched accounts in their wallet, signing would
 * produce a signature the contract rejects, so it is checked up front.
 */
export async function signPreparedTransaction(
  unsignedXdr: string,
  networkPassphrase: string,
  expectedAddress: string,
): Promise<string> {
  const kit = await loadKit();
  const { address } = await kit.getAddress();
  if (address !== expectedAddress) {
    throw new Error(
      "Your wallet is connected as a different account than this order. " +
        "Switch back to the account you signed in with, then try again.",
    );
  }
  const { signedTxXdr } = await kit.signTransaction(unsignedXdr, {
    networkPassphrase,
    address: expectedAddress,
  });
  return signedTxXdr;
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
