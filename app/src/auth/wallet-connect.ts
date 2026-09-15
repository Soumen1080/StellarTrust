/**
 * External-wallet signing over WalletConnect v2.
 *
 * The second of the two signing paths. Nothing here ever sees a secret key:
 * the app sends an unsigned envelope to the user's own wallet app and gets a
 * signed one back, which is the whole point of the protocol.
 *
 * The dependency is loaded lazily and the whole module degrades to "not
 * available" when `EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID` is unset, so a build
 * without a WalletConnect project still ships and simply offers only the
 * on-device wallet.
 *
 * `@react-native-async-storage/async-storage` is a required dependency of this
 * file even though nothing here imports it: WalletConnect's keyvaluestorage
 * requires it directly on React Native to persist sessions across restarts.
 * Removing it as "unused" passes a source grep and then fails the bundle.
 */
import { appConfig, walletConnectEnabled } from "../lib/config";

/** Stellar CAIP-2 chain ids, per the SEP/CAIP registry. */
const CHAIN_ID = {
  public: "stellar:pubnet",
  testnet: "stellar:testnet",
} as const;

/** SEP-43 / WalletConnect Stellar signing methods. */
const METHOD_SIGN_XDR = "stellar_signXDR";
const METHOD_SIGN_AND_SUBMIT = "stellar_signAndSubmitXDR";

export class WalletConnectUnavailableError extends Error {
  constructor() {
    super(
      "External wallet signing is not configured in this build. Use the on-device wallet instead.",
    );
    this.name = "WalletConnectUnavailableError";
  }
}

export class WalletConnectRejectedError extends Error {
  constructor(message = "The wallet rejected the request.") {
    super(message);
    this.name = "WalletConnectRejectedError";
  }
}

interface SignClient {
  connect(args: unknown): Promise<{ uri?: string; approval: () => Promise<Session> }>;
  request<T>(args: unknown): Promise<T>;
  disconnect(args: unknown): Promise<void>;
  session: { getAll(): Session[] };
}

interface Session {
  topic: string;
  namespaces: Record<string, { accounts: string[] }>;
}

let clientPromise: Promise<SignClient> | null = null;
let activeSession: Session | null = null;

export function isWalletConnectAvailable(): boolean {
  return walletConnectEnabled;
}

async function getClient(): Promise<SignClient> {
  if (!walletConnectEnabled) throw new WalletConnectUnavailableError();
  if (!clientPromise) {
    clientPromise = (async () => {
      // Resolved at runtime so the package is optional: a build without
      // WalletConnect installed fails here with a clear message rather than
      // failing to bundle at all.
      const mod = (await import("@walletconnect/sign-client")) as unknown as {
        default: { init(opts: unknown): Promise<SignClient> };
      };
      return mod.default.init({
        projectId: appConfig.walletConnectProjectId,
        metadata: {
          name: "StellarTrust",
          description: "Escrow, settlement and tokenized real-world assets on Stellar.",
          url: appConfig.sep10HomeDomain
            ? `https://${appConfig.sep10HomeDomain}`
            : "https://stellartrust.app",
          icons: ["https://stellartrust.app/icon.png"],
          redirect: { native: "stellartrust://", universal: undefined },
        },
      });
    })();
  }
  return clientPromise;
}

/** The G… address from a CAIP-10 account string (`stellar:testnet:G…`). */
function addressFromSession(session: Session): string {
  const chain = CHAIN_ID[appConfig.stellarNetwork];
  const accounts = session.namespaces.stellar?.accounts ?? [];
  const match = accounts.find((account) => account.startsWith(chain));
  const address = (match ?? accounts[0])?.split(":").pop();
  if (!address) {
    throw new WalletConnectRejectedError(
      "The wallet did not return a Stellar account.",
    );
  }
  return address;
}

export interface WalletConnectPairing {
  /** Deep link the user's wallet app opens to approve the session. */
  uri: string;
  /** Resolves with the address once the wallet approves. */
  approved: Promise<string>;
}

/**
 * Begin a session.
 *
 * Returns the pairing URI immediately so the UI can render a QR code or fire a
 * deep link, and a promise that settles when the user decides — the two happen
 * at very different times and the caller needs both.
 */
export async function connectExternalWallet(): Promise<WalletConnectPairing> {
  const client = await getClient();
  const chain = CHAIN_ID[appConfig.stellarNetwork];

  const { uri, approval } = await client.connect({
    requiredNamespaces: {
      stellar: {
        methods: [METHOD_SIGN_XDR, METHOD_SIGN_AND_SUBMIT],
        chains: [chain],
        events: [],
      },
    },
  });

  if (!uri) {
    throw new WalletConnectRejectedError("Could not start a wallet session.");
  }

  const approved = approval().then((session) => {
    activeSession = session;
    return addressFromSession(session);
  });

  return { uri, approved };
}

/** The connected external address, or null. */
export function getExternalWalletAddress(): string | null {
  if (!activeSession) return null;
  try {
    return addressFromSession(activeSession);
  } catch {
    return null;
  }
}

/** Restore a session that survived an app restart. */
export async function restoreExternalSession(): Promise<string | null> {
  if (!walletConnectEnabled) return null;
  try {
    const client = await getClient();
    const [existing] = client.session.getAll();
    if (!existing) return null;
    activeSession = existing;
    return addressFromSession(existing);
  } catch {
    return null;
  }
}

/**
 * Sign an envelope with the connected external wallet.
 *
 * The wallet app is brought to the foreground by the WalletConnect redirect;
 * this promise stays pending until the user approves or rejects there.
 */
export async function signWithExternalWallet(
  xdr: string,
  _networkPassphrase: string,
): Promise<string> {
  if (!activeSession) {
    throw new WalletConnectRejectedError("No wallet is connected.");
  }
  const client = await getClient();
  try {
    const result = await client.request<{ signedXDR: string }>({
      topic: activeSession.topic,
      chainId: CHAIN_ID[appConfig.stellarNetwork],
      request: { method: METHOD_SIGN_XDR, params: { xdr } },
    });
    if (!result?.signedXDR) {
      throw new WalletConnectRejectedError(
        "The wallet returned no signature.",
      );
    }
    return result.signedXDR;
  } catch (err) {
    if (err instanceof WalletConnectRejectedError) throw err;
    throw new WalletConnectRejectedError(
      err instanceof Error ? err.message : undefined,
    );
  }
}

export async function disconnectExternalWallet(): Promise<void> {
  if (!activeSession) return;
  const session = activeSession;
  activeSession = null;
  try {
    const client = await getClient();
    await client.disconnect({
      topic: session.topic,
      reason: { code: 6000, message: "User disconnected" },
    });
  } catch {
    // The local session is already cleared; a failed remote teardown is not
    // something the user can act on.
  }
}
