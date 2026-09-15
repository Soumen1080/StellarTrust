/**
 * One signing interface over both wallet kinds.
 *
 * Callers — sign-in, escrow lock, RWA purchase — must not care whether the key
 * lives in this device's keystore or in another app. They ask for a signature
 * and get one, or a typed failure. The choice is recorded once at sign-in and
 * read back from here.
 */
import * as SecureStore from "expo-secure-store";
import {
  getDeviceWalletAddress,
  signWithDeviceWallet,
} from "./device-wallet";
import {
  getExternalWalletAddress,
  restoreExternalSession,
  signWithExternalWallet,
} from "./wallet-connect";

export type WalletKind = "device" | "external";

const KIND_KEY = "stellartrust.wallet.kind";

export async function getWalletKind(): Promise<WalletKind | null> {
  const stored = await SecureStore.getItemAsync(KIND_KEY);
  return stored === "device" || stored === "external" ? stored : null;
}

export async function setWalletKind(kind: WalletKind): Promise<void> {
  await SecureStore.setItemAsync(KIND_KEY, kind);
}

export async function clearWalletKind(): Promise<void> {
  await SecureStore.deleteItemAsync(KIND_KEY);
}

/**
 * The address currently able to sign, or null.
 *
 * For an external wallet this may need to restore a WalletConnect session that
 * did not survive the app being killed, which is why it is async.
 */
export async function getActiveAddress(): Promise<string | null> {
  const kind = await getWalletKind();
  if (kind === "device") return getDeviceWalletAddress();
  if (kind === "external") {
    return getExternalWalletAddress() ?? (await restoreExternalSession());
  }
  return null;
}

/**
 * Sign an envelope with whichever wallet this session uses.
 *
 * `expectedAddress` is the account the server built the transaction for. If
 * the user has switched accounts in an external wallet since, signing would
 * produce a signature the contract rejects on submission — a confusing
 * on-chain failure. Checking here turns that into a sentence they can act on.
 */
export async function signTransaction(
  xdr: string,
  networkPassphrase: string,
  options: { reason: string; expectedAddress?: string },
): Promise<string> {
  const kind = await getWalletKind();
  if (!kind) throw new Error("No wallet is connected. Sign in again.");

  if (options.expectedAddress) {
    const active = await getActiveAddress();
    if (active && active !== options.expectedAddress) {
      throw new Error(
        "Your wallet is connected as a different account than this action. " +
          "Switch back to the account you signed in with, then try again.",
      );
    }
  }

  return kind === "device"
    ? signWithDeviceWallet(xdr, networkPassphrase, options.reason)
    : signWithExternalWallet(xdr, networkPassphrase);
}
