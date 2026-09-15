/**
 * Profile, security and account.
 *
 * Also the home of the two irreversible wallet controls — exporting the secret
 * key and removing the wallet. Both are behind a biometric check in
 * `device-wallet.ts`; here they are additionally behind a confirm sheet that
 * says plainly what is about to happen.
 */
import { KycStatus } from "@stellartrust/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useState } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { api } from "../../api/client";
import { messageFor } from "../../api/errors";
import { useAccessToken, useAuth } from "../../auth/AuthProvider";
import {
  deleteDeviceWallet,
  exportDeviceWalletSecret,
  getBiometricCapability,
} from "../../auth/device-wallet";
import { getWalletKind } from "../../auth/signer";
import { Button } from "../../components/Button";
import { Card, DataRow, Divider } from "../../components/Card";
import { ConfirmSheet } from "../../components/ConfirmSheet";
import { Input } from "../../components/Input";
import { Screen } from "../../components/Screen";
import { StatusPill } from "../../components/StatusPill";
import { Eyebrow, Label, Mono, Text } from "../../components/Text";
import { InlineError } from "../../components/States";
import { accountUrl } from "../../lib/explorer";
import { queryKeys } from "../../lib/query";
import { color, radius, space } from "../../theme";

export function ProfileScreen({ onVerify }: { onVerify: () => void }) {
  const accessToken = useAccessToken();
  const { session, profile, isVerified, signOut, refreshProfile } = useAuth();
  const queryClient = useQueryClient();

  const [username, setUsername] = useState("");
  const [walletKind, setWalletKind] = useState<string | null>(null);
  const [biometricLabel, setBiometricLabel] = useState("your device passcode");
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [confirmingExport, setConfirmingExport] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    void (async () => {
      setWalletKind(await getWalletKind());
      const capability = await getBiometricCapability();
      setBiometricLabel(capability.label);
    })();
  }, []);

  const reputation = useQuery({
    queryKey: queryKeys.reputation(),
    queryFn: () => api.getMyReputation(accessToken),
  });

  const claimUsername = useMutation({
    mutationFn: () => api.updateProfile(accessToken, username.trim()),
    onSuccess: async () => {
      setUsername("");
      await refreshProfile();
      await queryClient.invalidateQueries({ queryKey: ["identity"] });
    },
  });

  const uploadAvatar = useMutation({
    mutationFn: async () => {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [1, 1],
        // The server caps the avatar at 2 MB; compressing here keeps a
        // 12-megapixel photo from being rejected after the upload.
        quality: 0.7,
        base64: true,
      });
      if (result.canceled || !result.assets[0]?.base64) return null;
      const asset = result.assets[0];
      return api.uploadAvatar(
        accessToken,
        `data:${asset.mimeType ?? "image/jpeg"};base64,${asset.base64}`,
      );
    },
    onSuccess: async (result) => {
      if (result) await refreshProfile();
    },
  });

  async function exportSecret(): Promise<void> {
    setError(null);
    try {
      setRevealedSecret(await exportDeviceWalletSecret());
    } catch (err) {
      setError(err);
    }
  }

  async function removeWallet(): Promise<void> {
    setError(null);
    try {
      await deleteDeviceWallet();
      await signOut();
    } catch (err) {
      setError(err);
    }
  }

  const user = profile?.user;
  const address = session?.wallet.stellarPublicKey ?? "";
  const usernameClaimed = Boolean(user?.usernameSetAt);

  return (
    <Screen>
      <View style={styles.header}>
        <View style={styles.avatarRow}>
          {user?.avatarUrl ? (
            <Image
              source={{ uri: user.avatarUrl }}
              style={styles.avatar}
              contentFit="cover"
              accessibilityLabel="Your profile picture"
            />
          ) : (
            <View style={[styles.avatar, styles.avatarFallback]}>
              <Text variant="titleLg" tone={color.onPrimary}>
                {(user?.username ?? "?").slice(0, 1).toUpperCase()}
              </Text>
            </View>
          )}
          <View style={styles.identity}>
            <Text variant="titleLg" tone={color.onDark} numberOfLines={1}>
              @{user?.username ?? "—"}
            </Text>
            <StatusPill status={user?.kycStatus ?? KycStatus.Pending} size="sm" />
          </View>
        </View>
        <Button
          label={user?.avatarUrl ? "Change photo" : "Add a photo"}
          onPress={() => uploadAvatar.mutate()}
          variant="ghost"
          size="sm"
          fullWidth={false}
          busy={uploadAvatar.isPending}
        />
      </View>

      {error ? <InlineError error={error} /> : null}
      {uploadAvatar.error ? <InlineError error={uploadAvatar.error} /> : null}

      {!isVerified ? (
        <Card style={styles.verifyCard} onPress={onVerify}>
          <Text variant="titleSm" tone={color.statusReview}>
            Verify your identity
          </Text>
          <Text variant="bodySm" tone={color.mutedStrong}>
            Required before you can move money. Takes a few minutes.
          </Text>
        </Card>
      ) : null}

      {!usernameClaimed ? (
        <Card style={styles.usernameCard}>
          <Label>Claim your handle</Label>
          <Text variant="bodySm" tone={color.muted}>
            You were given @{user?.username}. Choose your own — it is permanent
            once claimed.
          </Text>
          {claimUsername.error ? (
            <InlineError error={claimUsername.error} />
          ) : null}
          <Input
            value={username}
            onChangeText={(text) =>
              setUsername(text.toLowerCase().replace(/[^a-z0-9_]/g, ""))
            }
            placeholder="yourhandle"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={30}
          />
          <Button
            label="Claim handle"
            onPress={() => claimUsername.mutate()}
            busy={claimUsername.isPending}
            disabled={username.trim().length < 3}
          />
        </Card>
      ) : null}

      {reputation.data ? (
        <Card>
          <Label>Reputation</Label>
          <View style={styles.reputationRow}>
            <Mono variant="numberDisplay" tone={color.onDark}>
              {Math.round(reputation.data.reputation.score * 100)}
            </Mono>
            <Text variant="bodySm" tone={color.muted}>
              / 100
            </Text>
          </View>
          <View style={styles.rows}>
            <DataRow
              label="Orders completed"
              value={String(reputation.data.reputation.ordersCompleted)}
            />
            <DataRow
              label="Disputes won"
              value={String(reputation.data.reputation.disputesWon)}
              tone={color.valueUp}
            />
            <DataRow
              label="Disputes lost"
              value={String(reputation.data.reputation.disputesLost)}
              tone={
                reputation.data.reputation.disputesLost > 0
                  ? color.valueDown
                  : color.body
              }
            />
          </View>
        </Card>
      ) : null}

      <Card>
        <Label>Wallet</Label>
        <Mono
          variant="numberSm"
          tone={color.body}
          numberOfLines={2}
          style={styles.address}
          selectable
        >
          {address}
        </Mono>
        <View style={styles.walletActions}>
          <Button
            label="Copy"
            onPress={() => {
              void Clipboard.setStringAsync(address);
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }}
            variant="secondary"
            size="sm"
            fullWidth={false}
          />
          <Button
            label="View on explorer"
            onPress={() => void Linking.openURL(accountUrl(address))}
            variant="ghost"
            size="sm"
            fullWidth={false}
          />
        </View>
        <Divider />
        <DataRow
          label="Type"
          value={
            walletKind === "external"
              ? "External wallet"
              : "On this device"
          }
          mono={false}
        />
        {walletKind === "device" ? (
          <DataRow label="Unlocked by" value={biometricLabel} mono={false} />
        ) : null}
      </Card>

      {walletKind === "device" ? (
        <Card style={styles.dangerCard}>
          <Label>Security</Label>

          {revealedSecret ? (
            <View style={styles.secretBox}>
              <Mono variant="numberSm" tone={color.body} numberOfLines={3} selectable>
                {revealedSecret}
              </Mono>
              <Button
                label="Hide"
                onPress={() => setRevealedSecret(null)}
                variant="secondary"
                size="sm"
              />
            </View>
          ) : (
            <Button
              label="Reveal secret key"
              onPress={() => setConfirmingExport(true)}
              variant="secondary"
            />
          )}

          <Button
            label="Remove wallet from this device"
            onPress={() => setConfirmingDelete(true)}
            variant="danger"
          />
          <Text variant="bodySm" tone={color.muted}>
            Removing the wallet without a saved secret key means the funds
            behind it cannot be recovered by anyone.
          </Text>
        </Card>
      ) : null}

      <Button label="Sign out" onPress={() => void signOut()} variant="secondary" />

      <ConfirmSheet
        visible={confirmingExport}
        title="Reveal secret key"
        message={`Your key will be shown on screen. Make sure nobody is watching. Anyone who sees it can take your funds. You will be asked for ${biometricLabel}.`}
        confirmLabel="Reveal"
        onCancel={() => setConfirmingExport(false)}
        onConfirm={() => {
          setConfirmingExport(false);
          void exportSecret();
        }}
      />

      <ConfirmSheet
        visible={confirmingDelete}
        title="Remove this wallet"
        message="The key is erased from this device. Without the secret key saved elsewhere, any funds it holds are permanently lost. This cannot be undone."
        confirmLabel="Remove wallet"
        destructive
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={() => {
          setConfirmingDelete(false);
          void removeWallet();
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    gap: space.sm,
    paddingTop: space.md,
    paddingBottom: space.md,
    alignItems: "flex-start",
  },
  avatarRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  avatar: { width: 56, height: 56, borderRadius: radius.pill },
  avatarFallback: {
    backgroundColor: color.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  identity: { gap: space.xxs, flexShrink: 1 },
  verifyCard: {
    gap: 2,
    marginBottom: space.sm,
    borderColor: `${color.statusReview}4d`,
    backgroundColor: `${color.statusReview}14`,
  },
  usernameCard: { gap: space.sm, marginBottom: space.sm },
  reputationRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: space.xxs,
    marginTop: space.xxs,
  },
  rows: { marginTop: space.xs },
  address: { marginTop: space.xs },
  walletActions: { flexDirection: "row", gap: space.xs, marginTop: space.xs },
  dangerCard: { gap: space.sm, borderColor: `${color.statusRejected}33` },
  secretBox: { gap: space.xs },
});
