/**
 * Deposit.
 *
 * A deposit here is a *claim*, not an instruction: the user sends funds on
 * Stellar themselves, then tells the platform which transaction paid it. The
 * server verifies that hash against the chain and credits whatever it actually
 * finds. That is why this screen asks for a hash and never for an amount —
 * an amount typed by the user would be a number the ledger trusted without
 * evidence.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { api } from "../../api/client";
import { useAccessToken } from "../../auth/AuthProvider";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Input } from "../../components/Input";
import { Screen } from "../../components/Screen";
import { Eyebrow, Label, Mono, Text } from "../../components/Text";
import { InlineError, SkeletonList } from "../../components/States";
import { useIdempotencyKey } from "../../lib/idempotency";
import { formatMoney } from "../../lib/money";
import { queryKeys } from "../../lib/query";
import { color, radius, space } from "../../theme";

export function DepositScreen({ onDone }: { onDone: () => void }) {
  const accessToken = useAccessToken();
  const queryClient = useQueryClient();
  const idempotency = useIdempotencyKey();
  const [hash, setHash] = useState("");
  const [copied, setCopied] = useState(false);

  const address = useQuery({
    queryKey: queryKeys.treasuryDepositAddress(),
    queryFn: () => api.treasuryDepositAddress(accessToken),
    staleTime: Infinity,
  });

  const claim = useMutation({
    mutationFn: () =>
      api.claimDeposit(accessToken, idempotency.next(), {
        stellarTxHash: hash.trim(),
      }),
    onSuccess: async () => {
      idempotency.reset();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.treasuryBalances() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.treasuryMovements() }),
      ]);
    },
  });

  async function copyAddress(): Promise<void> {
    if (!address.data) return;
    await Clipboard.setStringAsync(address.data.address);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCopied(true);
  }

  // A Stellar tx hash is 64 hex characters. Checking the shape here saves a
  // round trip and tells the user which part is wrong.
  const hashValid = /^[0-9a-fA-F]{64}$/.test(hash.trim());

  if (claim.isSuccess && claim.data) {
    return (
      <Screen footer={<Button label="Done" onPress={onDone} />}>
        <View style={styles.success}>
          <View style={styles.successBadge}>
            <Text variant="titleLg" tone={color.statusVerified}>
              ✓
            </Text>
          </View>
          <Text variant="displaySm" tone={color.onDark} center>
            Deposit credited
          </Text>
          <Mono variant="numberLg" tone={color.valueUp}>
            +{formatMoney(claim.data.amount, claim.data.currency)}
          </Mono>
          <Text variant="bodySm" tone={color.muted} center style={styles.blurb}>
            The amount came from the transaction itself, verified on-chain.
          </Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen
      footer={
        <Button
          label="Credit my deposit"
          onPress={() => claim.mutate()}
          busy={claim.isPending}
          disabled={!hashValid}
          haptic
        />
      }
    >
      <View style={styles.header}>
        <Eyebrow>Deposit</Eyebrow>
        <Text variant="displaySm" tone={color.onDark}>
          Send, then claim
        </Text>
        <Text variant="bodyMd" tone={color.muted}>
          Send funds from your Stellar wallet to the address below, then paste
          the transaction hash so we can credit you.
        </Text>
      </View>

      {claim.error ? <InlineError error={claim.error} /> : null}

      {address.isLoading ? (
        <SkeletonList count={1} />
      ) : address.data ? (
        <Card style={styles.addressCard}>
          <Label>Deposit address</Label>
          <View style={styles.qr}>
            <QRCode
              value={address.data.address}
              size={168}
              backgroundColor="#ffffff"
              color="#000000"
            />
          </View>
          <Mono
            variant="numberSm"
            tone={color.body}
            numberOfLines={2}
            style={styles.address}
            selectable
          >
            {address.data.address}
          </Mono>
          <Button
            label={copied ? "Copied" : "Copy address"}
            onPress={() => void copyAddress()}
            variant="secondary"
            size="sm"
          />
        </Card>
      ) : null}

      <Input
        label="Transaction hash"
        value={hash}
        onChangeText={setHash}
        placeholder="64-character hash from your wallet"
        autoCapitalize="none"
        autoCorrect={false}
        mono
        multiline
        error={
          hash.length > 0 && !hashValid
            ? "A Stellar transaction hash is 64 hexadecimal characters."
            : null
        }
        hint={hashValid ? "Looks right." : undefined}
      />

      <Card style={styles.note}>
        <Text variant="bodySm" tone={color.mutedStrong}>
          We read the amount from the transaction on the network, so you cannot
          be credited for more than you actually sent — and you never need to
          type an amount.
        </Text>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: space.xxs, paddingTop: space.lg, paddingBottom: space.md },
  addressCard: { alignItems: "center", gap: space.sm, marginBottom: space.md },
  qr: { padding: space.sm, backgroundColor: "#fff", borderRadius: radius.lg },
  address: { textAlign: "center" },
  note: { marginTop: space.md, backgroundColor: color.surfaceElevatedDark },
  success: { alignItems: "center", gap: space.sm, paddingVertical: space.section },
  successBadge: {
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: `${color.statusVerified}1a`,
  },
  blurb: { maxWidth: 300 },
});
