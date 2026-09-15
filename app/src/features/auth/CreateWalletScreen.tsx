/**
 * Create an on-device wallet.
 *
 * The backup step is not a formality and is deliberately hard to skip. This
 * key is the only thing that can move the user's funds; if the handset is lost
 * and the seed was never written down, the money is unrecoverable — not by
 * support, not by us. So the secret is shown once, the user must confirm they
 * have stored it, and only then is the account used to sign in.
 *
 * The secret is held in component state for exactly as long as that takes and
 * is never logged, persisted outside the keystore, or sent anywhere.
 */
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useAuth } from "../../auth/AuthProvider";
import { createDeviceWallet } from "../../auth/device-wallet";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Screen } from "../../components/Screen";
import { Eyebrow, Mono, Text } from "../../components/Text";
import { InlineError } from "../../components/States";
import { color, radius, space } from "../../theme";

type Stage = "intro" | "backup" | "confirm";

export function CreateWalletScreen({ onCancel }: { onCancel: () => void }) {
  const { signIn } = useAuth();
  const [stage, setStage] = useState<Stage>("intro");
  const [secret, setSecret] = useState<string | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function generate(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const wallet = await createDeviceWallet();
      setSecret(wallet.secret);
      setAddress(wallet.address);
      setStage("backup");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function copySecret(): Promise<void> {
    if (!secret) return;
    await Clipboard.setStringAsync(secret);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopied(true);
  }

  async function finish(): Promise<void> {
    if (!address || busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(address, "device");
      // Dropped from memory the moment it is no longer needed.
      setSecret(null);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (stage === "intro") {
    return (
      <Screen
        footer={
          <View style={styles.footer}>
            <Button
              label="Back"
              onPress={onCancel}
              variant="ghost"
              fullWidth={false}
            />
            <Button
              label="Create wallet"
              onPress={() => void generate()}
              busy={busy}
              style={styles.footerPrimary}
            />
          </View>
        }
      >
        <View style={styles.header}>
          <Eyebrow>New wallet</Eyebrow>
          <Text variant="displaySm" tone={color.onDark}>
            A key only you hold
          </Text>
          <Text variant="bodyMd" tone={color.muted}>
            StellarTrust will generate a Stellar account on this device. The
            secret key is stored in the phone&apos;s secure hardware and is
            unlocked by your fingerprint or face.
          </Text>
        </View>

        {error ? <InlineError error={error} /> : null}

        <View style={styles.points}>
          <Point
            title="It never leaves this device"
            blurb="Not to our servers, not to a backup. Transactions are signed here and only the signature is sent."
          />
          <Point
            title="You must write it down"
            blurb="If you lose this phone and have not saved the key, nobody can restore your funds."
          />
          <Point
            title="It is your identity here"
            blurb="Signing in proves you hold this key. There is no password to remember or leak."
          />
        </View>
      </Screen>
    );
  }

  return (
    <Screen
      footer={
        <View style={styles.footer}>
          <Button
            label="I have saved my key"
            onPress={() => void finish()}
            busy={busy}
            disabled={!acknowledged || !revealed}
            haptic
            style={styles.footerPrimary}
          />
        </View>
      }
    >
      <View style={styles.header}>
        <Eyebrow>Back up your key</Eyebrow>
        <Text variant="displaySm" tone={color.onDark}>
          Write this down
        </Text>
        <Text variant="bodyMd" tone={color.muted}>
          This is the only copy you will be shown. Store it somewhere offline —
          on paper, or in a password manager.
        </Text>
      </View>

      {error ? <InlineError error={error} /> : null}

      <Card style={styles.secretCard}>
        <Eyebrow>Secret key</Eyebrow>
        {revealed ? (
          <Mono
            variant="numberSm"
            tone={color.body}
            numberOfLines={3}
            style={styles.secret}
            // Excluded from screenshots and the app switcher snapshot where
            // the platform honours it.
            selectable
          >
            {secret}
          </Mono>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Reveal secret key"
            onPress={() => setRevealed(true)}
            style={styles.reveal}
          >
            <Text variant="titleSm" tone={color.primary}>
              Tap to reveal
            </Text>
            <Text variant="bodySm" tone={color.muted} center>
              Make sure nobody is looking at your screen
            </Text>
          </Pressable>
        )}

        {revealed ? (
          <Button
            label={copied ? "Copied" : "Copy to clipboard"}
            onPress={() => void copySecret()}
            variant="secondary"
            size="sm"
          />
        ) : null}
      </Card>

      {address ? (
        <Card>
          <Eyebrow>Your address</Eyebrow>
          <Mono variant="numberSm" tone={color.mutedStrong} numberOfLines={2}>
            {address}
          </Mono>
        </Card>
      ) : null}

      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: acknowledged }}
        accessibilityLabel="I have written down my secret key and understand it cannot be recovered"
        onPress={() => setAcknowledged((value) => !value)}
        style={styles.ack}
      >
        <View style={[styles.checkbox, acknowledged && styles.checkboxOn]}>
          {acknowledged ? (
            <Text variant="caption" tone={color.onPrimary}>
              ✓
            </Text>
          ) : null}
        </View>
        <Text variant="bodySm" tone={color.body} style={styles.ackText}>
          I have written down my secret key. I understand that if I lose it, my
          funds cannot be recovered by anyone.
        </Text>
      </Pressable>
    </Screen>
  );
}

function Point({ title, blurb }: { title: string; blurb: string }) {
  return (
    <Card>
      <Text variant="titleSm" tone={color.onDark}>
        {title}
      </Text>
      <Text variant="bodySm" tone={color.muted} style={styles.pointBlurb}>
        {blurb}
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  header: { gap: space.xxs, paddingTop: space.lg, paddingBottom: space.md },
  points: { gap: space.sm },
  pointBlurb: { marginTop: space.xxs },
  secretCard: { gap: space.sm, borderColor: color.primary },
  secret: { letterSpacing: 0.5, lineHeight: 22 },
  reveal: {
    alignItems: "center",
    justifyContent: "center",
    gap: space.xxs,
    paddingVertical: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: color.hairlineDark,
  },
  ack: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm,
    marginTop: space.md,
    paddingVertical: space.xs,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.borderStrong,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  checkboxOn: { backgroundColor: color.primary, borderColor: color.primary },
  ackText: { flex: 1 },
  footer: { flexDirection: "row", alignItems: "center", gap: space.sm },
  footerPrimary: { flex: 1 },
});
