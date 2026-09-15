/**
 * Sign in.
 *
 * Authentication here is SEP-10: the server issues a challenge transaction,
 * the wallet signs it, and the server verifies that signature against the
 * account before issuing a session. There is no password to phish and no
 * credential the app could leak — possession of the key *is* the proof.
 *
 * Two paths reach the same handshake. The on-device wallet keeps a key in this
 * handset's secure enclave; WalletConnect hands the signing off to a wallet
 * the user already has. Which one they used is remembered, so the second
 * sign-in is one tap.
 */
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Screen } from "../../components/Screen";
import { Eyebrow, Text } from "../../components/Text";
import { InlineError } from "../../components/States";
import {
  getBiometricCapability,
  getDeviceWalletAddress,
  hasDeviceWallet,
} from "../../auth/device-wallet";
import { useAuth } from "../../auth/AuthProvider";
import { isWalletConnectAvailable } from "../../auth/wallet-connect";
import { color, radius, space } from "../../theme";
import { useEffect } from "react";

export type SignInRoute = "create-wallet" | "import-wallet" | "connect-external";

export function SignInScreen({
  onNavigate,
}: {
  onNavigate: (route: SignInRoute) => void;
}) {
  const { signIn } = useAuth();
  const [existingAddress, setExistingAddress] = useState<string | null>(null);
  const [biometricLabel, setBiometricLabel] = useState("your device passcode");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    void (async () => {
      if (await hasDeviceWallet()) {
        setExistingAddress(await getDeviceWalletAddress());
      }
      const capability = await getBiometricCapability();
      setBiometricLabel(capability.label);
    })();
  }, []);

  async function signInWithDevice(): Promise<void> {
    if (!existingAddress || busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(existingAddress, "device");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <View style={styles.hero}>
        <View style={styles.mark}>
          <Text variant="titleLg" tone={color.onPrimary}>
            ST
          </Text>
        </View>
        <Eyebrow>StellarTrust</Eyebrow>
        <Text variant="displayMd" tone={color.onDark}>
          Escrow that settles across borders
        </Text>
        <Text variant="bodyMd" tone={color.muted}>
          Hold funds in a contract until both sides are satisfied, settle into
          local currency, and invest in tokenized real-world assets.
        </Text>
      </View>

      {error ? <InlineError error={error} /> : null}

      {existingAddress ? (
        <Card style={styles.returning}>
          <Eyebrow>Wallet on this device</Eyebrow>
          <Text variant="numberMd" tone={color.body} numberOfLines={1}>
            {existingAddress.slice(0, 8)}…{existingAddress.slice(-6)}
          </Text>
          <Text variant="bodySm" tone={color.muted} style={styles.blurb}>
            Signing in proves you hold this key. You will be asked for{" "}
            {biometricLabel}.
          </Text>
          <Button
            label="Sign in"
            onPress={() => void signInWithDevice()}
            busy={busy}
            haptic
          />
        </Card>
      ) : (
        <View style={styles.choices}>
          <Button
            label="Create a wallet"
            onPress={() => onNavigate("create-wallet")}
            disabled={busy}
          />
          <Button
            label="I already have a secret key"
            onPress={() => onNavigate("import-wallet")}
            variant="secondary"
            disabled={busy}
          />
          {isWalletConnectAvailable() ? (
            <Button
              label="Connect an external wallet"
              onPress={() => onNavigate("connect-external")}
              variant="ghost"
              disabled={busy}
            />
          ) : null}
        </View>
      )}

      {existingAddress ? (
        <View style={styles.secondary}>
          {isWalletConnectAvailable() ? (
            <Button
              label="Use a different wallet"
              onPress={() => onNavigate("connect-external")}
              variant="ghost"
              disabled={busy}
            />
          ) : null}
        </View>
      ) : null}

      <Text variant="bodySm" tone={color.muted} center style={styles.legal}>
        Your key never leaves this device. StellarTrust cannot move your funds
        without a signature you approve.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { gap: space.xs, paddingTop: space.xxl, paddingBottom: space.xl },
  mark: {
    width: 48,
    height: 48,
    borderRadius: radius.lg,
    backgroundColor: color.primary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.xs,
  },
  returning: { gap: space.xs },
  blurb: { marginBottom: space.xs },
  choices: { gap: space.sm },
  secondary: { marginTop: space.md },
  legal: { marginTop: space.xl, maxWidth: 320, alignSelf: "center" },
});
