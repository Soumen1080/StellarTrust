/**
 * Import an existing Stellar account from its secret seed.
 *
 * The field is masked and autocorrect is off: a seed silently "corrected" by
 * the keyboard imports an account the user does not control, and the failure
 * surfaces much later as a missing balance. Validation happens against the
 * key's own checksum before anything is stored.
 */
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useAuth } from "../../auth/AuthProvider";
import { importDeviceWallet } from "../../auth/device-wallet";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Input } from "../../components/Input";
import { Screen } from "../../components/Screen";
import { Eyebrow, Text } from "../../components/Text";
import { InlineError } from "../../components/States";
import { messageFor } from "../../api/errors";
import { color, space } from "../../theme";

export function ImportWalletScreen({ onCancel }: { onCancel: () => void }) {
  const { signIn } = useAuth();
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  async function importAndSignIn(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setFieldError(null);
    try {
      const address = await importDeviceWallet(secret);
      await signIn(address, "device");
      // Cleared as soon as it is in the keystore.
      setSecret("");
    } catch (err) {
      // A malformed seed belongs on the field; anything else is a failure of
      // the sign-in round trip and belongs at the top of the screen.
      const message = messageFor(err);
      if (message.includes("valid Stellar secret key")) setFieldError(message);
      else setError(err);
    } finally {
      setBusy(false);
    }
  }

  const looksComplete = /^S[A-Z2-7]{55}$/.test(secret.trim());

  return (
    <Screen
      footer={
        <View style={styles.footer}>
          <Button
            label="Back"
            onPress={onCancel}
            variant="ghost"
            fullWidth={false}
            disabled={busy}
          />
          <Button
            label="Import and sign in"
            onPress={() => void importAndSignIn()}
            busy={busy}
            disabled={!looksComplete}
            style={styles.footerPrimary}
          />
        </View>
      }
    >
      <View style={styles.header}>
        <Eyebrow>Existing wallet</Eyebrow>
        <Text variant="displaySm" tone={color.onDark}>
          Enter your secret key
        </Text>
        <Text variant="bodyMd" tone={color.muted}>
          The 56-character key beginning with S. It is stored in this
          phone&apos;s secure hardware and never sent anywhere.
        </Text>
      </View>

      {error ? <InlineError error={error} /> : null}

      <Input
        label="Secret key"
        value={secret}
        onChangeText={setSecret}
        placeholder="SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        // A keyboard that corrects or capitalizes a seed produces an account
        // the user does not own.
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        secureTextEntry
        multiline={false}
        mono
        error={fieldError}
        hint={
          looksComplete || secret.length === 0
            ? "Never share this key with anyone."
            : `${secret.trim().length} of 56 characters`
        }
      />

      <Card style={styles.warning}>
        <Text variant="titleSm" tone={color.statusDisputed}>
          Only type this on a device you trust
        </Text>
        <Text variant="bodySm" tone={color.mutedStrong} style={styles.blurb}>
          Anyone with this key can move your funds. StellarTrust will never ask
          for it by email, chat, or phone.
        </Text>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: space.xxs, paddingTop: space.lg, paddingBottom: space.md },
  warning: { marginTop: space.md, backgroundColor: color.surfaceElevatedDark },
  blurb: { marginTop: space.xxs },
  footer: { flexDirection: "row", alignItems: "center", gap: space.sm },
  footerPrimary: { flex: 1 },
});
