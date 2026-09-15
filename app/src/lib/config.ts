/**
 * Runtime configuration, resolved once from the Expo manifest.
 *
 * Everything here arrives from `app.config.ts` `extra`, which reads the
 * EXPO_PUBLIC_* environment at build time. Nothing secret lives in the bundle:
 * the app authenticates as the user with a SEP-10 session token it earns at
 * sign-in, and holds no API credential of its own.
 */
import Constants from "expo-constants";

interface AppExtra {
  apiBaseUrl?: string;
  stellarNetwork?: string;
  horizonUrl?: string;
  walletConnectProjectId?: string;
  sep10HomeDomain?: string;
}

const extra = (Constants.expoConfig?.extra ?? {}) as AppExtra;

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy app/.env.example to app/.env and set it, then restart the bundler.`,
    );
  }
  return value;
}

export const appConfig = {
  /** Trailing slashes stripped so `${API_BASE}${path}` never doubles up. */
  apiBaseUrl: required(extra.apiBaseUrl, "EXPO_PUBLIC_API_BASE_URL").replace(
    /\/+$/,
    "",
  ),
  stellarNetwork: (extra.stellarNetwork === "public"
    ? "public"
    : "testnet") as "public" | "testnet",
  horizonUrl: extra.horizonUrl ?? "https://horizon-testnet.stellar.org",
  walletConnectProjectId: extra.walletConnectProjectId ?? "",
  sep10HomeDomain: extra.sep10HomeDomain ?? "",
} as const;

/** Whether the external-wallet path can be offered at all. */
export const walletConnectEnabled = appConfig.walletConnectProjectId.length > 0;
