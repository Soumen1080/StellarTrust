/**
 * Connect an external Stellar wallet over WalletConnect.
 *
 * Shows both affordances because the user may be on the phone that holds the
 * wallet (deep link) or on a second device (QR). The pairing URI is produced
 * immediately; approval arrives much later, from the other app, so the two are
 * handled separately.
 */
import * as Linking from "expo-linking";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { useAuth } from "../../auth/AuthProvider";
import { connectExternalWallet } from "../../auth/wallet-connect";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Screen } from "../../components/Screen";
import { Eyebrow, Text } from "../../components/Text";
import { InlineError } from "../../components/States";
import { color, radius, space } from "../../theme";

export function ConnectWalletScreen({ onCancel }: { onCancel: () => void }) {
  const { signIn } = useAuth();
  const [uri, setUri] = useState<string | null>(null);
  const [status, setStatus] = useState<"pairing" | "waiting" | "signing">(
    "pairing",
  );
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const pairing = await connectExternalWallet();
        if (cancelled) return;
        setUri(pairing.uri);
        setStatus("waiting");

        const address = await pairing.approved;
        if (cancelled) return;

        // Approval only established the session; the SEP-10 challenge is a
        // second round trip the wallet must also sign.
        setStatus("signing");
        await signIn(address, "external");
      } catch (err) {
        if (!cancelled) setError(err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [signIn]);

  return (
    <Screen
      footer={
        <Button label="Cancel" onPress={onCancel} variant="secondary" />
      }
    >
      <View style={styles.header}>
        <Eyebrow>External wallet</Eyebrow>
        <Text variant="displaySm" tone={color.onDark}>
          {status === "signing" ? "Approve the sign-in" : "Connect your wallet"}
        </Text>
        <Text variant="bodyMd" tone={color.muted}>
          {status === "signing"
            ? "Your wallet is asking you to sign a challenge. It moves no funds — it only proves the account is yours."
            : "Open your Stellar wallet and approve the connection. Your key stays in that app."}
        </Text>
      </View>

      {error ? <InlineError error={error} /> : null}

      {uri && status === "waiting" ? (
        <>
          <Card style={styles.qrCard}>
            <View style={styles.qr}>
              <QRCode
                value={uri}
                size={200}
                backgroundColor="#ffffff"
                color="#000000"
              />
            </View>
            <Text variant="bodySm" tone={color.muted} center>
              Scan this with a wallet on another device
            </Text>
          </Card>

          <Button
            label="Open a wallet on this phone"
            onPress={() => void Linking.openURL(uri)}
            variant="secondary"
          />
        </>
      ) : (
        <View style={styles.pending}>
          <ActivityIndicator color={color.primary} />
          <Text variant="bodySm" tone={color.muted}>
            {status === "signing"
              ? "Waiting for your signature…"
              : "Preparing a secure session…"}
          </Text>
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: space.xxs, paddingTop: space.lg, paddingBottom: space.md },
  qrCard: { alignItems: "center", gap: space.md },
  qr: { padding: space.md, backgroundColor: "#fff", borderRadius: radius.lg },
  pending: { alignItems: "center", gap: space.sm, paddingVertical: space.xxl },
});
