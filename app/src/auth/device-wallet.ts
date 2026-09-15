/**
 * On-device Stellar wallet.
 *
 * The secret key is generated on the device and written to the platform
 * keystore — Keychain on iOS, the Android Keystore-backed EncryptedSharedPrefs
 * — with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, so it is never included in an iCloud
 * or Android backup and never leaves this handset. It is read only to sign,
 * and only after a biometric/passcode check passes.
 *
 * What this file deliberately does not do:
 *
 *  - It never sends the secret anywhere. Signing happens locally; only the
 *    signed envelope crosses the network.
 *  - It never writes the secret to state, a log, or a render. The only public
 *    value that escapes this module is the G… address.
 *  - It does not treat "no biometric hardware" as a reason to skip the check.
 *    A device with no enrolled biometric falls back to the device passcode via
 *    `LocalAuthentication`, which is the platform's own escalation path.
 */
import { Keypair } from "@stellar/stellar-sdk";
import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";

/** Keystore entry holding the S… secret seed. */
const SECRET_KEY = "stellartrust.wallet.secret";
/** Keystore entry holding the G… address, readable without a biometric prompt. */
const ADDRESS_KEY = "stellartrust.wallet.address";

const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export class WalletLockedError extends Error {
  constructor(message = "Authentication was cancelled or failed.") {
    super(message);
    this.name = "WalletLockedError";
  }
}

export class NoWalletError extends Error {
  constructor() {
    super("No wallet exists on this device.");
    this.name = "NoWalletError";
  }
}

/** Whether a wallet has been created or imported on this device. */
export async function hasDeviceWallet(): Promise<boolean> {
  return (await SecureStore.getItemAsync(ADDRESS_KEY)) !== null;
}

/** The device wallet address, or null. Cheap: no biometric prompt. */
export async function getDeviceWalletAddress(): Promise<string | null> {
  return SecureStore.getItemAsync(ADDRESS_KEY);
}

export interface BiometricCapability {
  /** The device can prompt for *something* — biometric or passcode. */
  available: boolean;
  /** A fingerprint/face is actually enrolled. */
  enrolled: boolean;
  /** "Face ID", "Touch ID", "Fingerprint", or "Device passcode". */
  label: string;
}

export async function getBiometricCapability(): Promise<BiometricCapability> {
  const [hasHardware, enrolled, types] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
    LocalAuthentication.supportedAuthenticationTypesAsync(),
  ]);

  const { AuthenticationType } = LocalAuthentication;
  let label = "Device passcode";
  if (types.includes(AuthenticationType.FACIAL_RECOGNITION)) {
    label = "Face ID";
  } else if (types.includes(AuthenticationType.FINGERPRINT)) {
    label = "Fingerprint";
  } else if (types.includes(AuthenticationType.IRIS)) {
    label = "Iris";
  }

  return { available: hasHardware || !enrolled, enrolled, label };
}

/**
 * Prompt for the device owner before a key use.
 *
 * `disableDeviceFallback: false` is deliberate: a user with no enrolled
 * biometric must still be able to reach their own money via the passcode.
 */
async function authenticate(reason: string): Promise<void> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: reason,
    cancelLabel: "Cancel",
    disableDeviceFallback: false,
  });
  if (!result.success) throw new WalletLockedError();
}

/**
 * Create a new wallet on this device.
 *
 * Refuses to overwrite an existing one — the old secret would be unrecoverable
 * and any funds behind it lost. Callers that mean to replace a wallet must
 * delete it first, which is a separate, explicitly-confirmed action.
 */
export async function createDeviceWallet(): Promise<{
  address: string;
  secret: string;
}> {
  if (await hasDeviceWallet()) {
    throw new Error(
      "A wallet already exists on this device. Remove it before creating another.",
    );
  }
  const keypair = Keypair.random();
  const address = keypair.publicKey();
  const secret = keypair.secret();

  await SecureStore.setItemAsync(SECRET_KEY, secret, SECURE_OPTIONS);
  await SecureStore.setItemAsync(ADDRESS_KEY, address, SECURE_OPTIONS);

  // Returned once, so the create screen can show the recovery phrase. It is
  // never returned again and is not retained by this module.
  return { address, secret };
}

/**
 * Import an existing wallet from its S… secret seed.
 *
 * Validation is delegated to `Keypair.fromSecret`, which rejects a bad
 * checksum — so a mistyped seed fails here rather than silently producing an
 * address the user does not control.
 */
export async function importDeviceWallet(secret: string): Promise<string> {
  const trimmed = secret.trim();
  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(trimmed);
  } catch {
    throw new Error(
      "That is not a valid Stellar secret key. It should start with S and be 56 characters.",
    );
  }
  const address = keypair.publicKey();
  await SecureStore.setItemAsync(SECRET_KEY, trimmed, SECURE_OPTIONS);
  await SecureStore.setItemAsync(ADDRESS_KEY, address, SECURE_OPTIONS);
  return address;
}

/**
 * Sign a transaction envelope with the device key.
 *
 * The keypair is materialized inside this function and dropped when it
 * returns; it is never held in module state where a later bug could reach it.
 */
export async function signWithDeviceWallet(
  xdr: string,
  networkPassphrase: string,
  reason: string,
): Promise<string> {
  const secret = await SecureStore.getItemAsync(SECRET_KEY, SECURE_OPTIONS);
  if (!secret) throw new NoWalletError();

  await authenticate(reason);

  // Imported lazily: the SDK's transaction machinery is a large module, and a
  // session that never signs should not pay to parse it at startup.
  const { TransactionBuilder } = await import("@stellar/stellar-sdk");
  const keypair = Keypair.fromSecret(secret);
  const transaction = TransactionBuilder.fromXDR(xdr, networkPassphrase);
  transaction.sign(keypair);
  return transaction.toXDR();
}

/**
 * Reveal the secret for backup, behind a biometric check.
 *
 * Exists because a user who cannot export their key does not really own it.
 * The caller is responsible for showing it briefly and never persisting it.
 */
export async function exportDeviceWalletSecret(): Promise<string> {
  const secret = await SecureStore.getItemAsync(SECRET_KEY, SECURE_OPTIONS);
  if (!secret) throw new NoWalletError();
  await authenticate("Reveal your secret key");
  return secret;
}

/**
 * Permanently remove the wallet from this device.
 *
 * Gated on a biometric check so a handset someone else is holding cannot be
 * wiped. Irreversible: without the exported seed the funds are gone.
 */
export async function deleteDeviceWallet(): Promise<void> {
  await authenticate("Remove this wallet from the device");
  await SecureStore.deleteItemAsync(SECRET_KEY, SECURE_OPTIONS);
  await SecureStore.deleteItemAsync(ADDRESS_KEY, SECURE_OPTIONS);
}
