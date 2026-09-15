/**
 * Withdraw to a Stellar address.
 *
 * Defaults to the account the user proved at sign-in, because that is the one
 * address we know they control. Sending elsewhere is allowed but is the
 * riskier path — a mistyped address on Stellar is unrecoverable — so it is
 * behind an explicit toggle and a confirm sheet that shows the destination.
 */
import type { CurrencyCode } from "@stellartrust/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { StrKey } from "@stellar/stellar-sdk";
import * as Haptics from "expo-haptics";
import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { api } from "../../api/client";
import { useAccessToken, useAuth } from "../../auth/AuthProvider";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { ConfirmSheet } from "../../components/ConfirmSheet";
import { Input } from "../../components/Input";
import { Screen } from "../../components/Screen";
import { Eyebrow, Label, Mono, Text } from "../../components/Text";
import { InlineError } from "../../components/States";
import { useIdempotencyKey } from "../../lib/idempotency";
import { formatAmount, formatMoney, shortenAddress, toMinorUnits } from "../../lib/money";
import { queryKeys } from "../../lib/query";
import { color, space } from "../../theme";

export function WithdrawScreen({ onDone }: { onDone: () => void }) {
  const accessToken = useAccessToken();
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const idempotency = useIdempotencyKey();

  const [currency, setCurrency] = useState<CurrencyCode | null>(null);
  const [amount, setAmount] = useState("");
  const [useOther, setUseOther] = useState(false);
  const [destination, setDestination] = useState("");
  const [confirming, setConfirming] = useState(false);

  const balances = useQuery({
    queryKey: queryKeys.treasuryBalances(),
    queryFn: () => api.treasuryBalances(accessToken),
  });

  const spendable = useMemo(
    () => (balances.data?.balances ?? []).filter((e) => e.balance !== "0"),
    [balances.data],
  );

  // Default to the largest holding rather than making the user choose first.
  const selected = currency ?? spendable[0]?.currency ?? null;
  const selectedBalance = spendable.find((e) => e.currency === selected);

  const minorUnits = selected ? toMinorUnits(amount, selected) : null;
  const signInAddress = session?.wallet.stellarPublicKey ?? "";
  const target = useOther ? destination.trim() : signInAddress;

  const destinationValid = useMemo(() => {
    if (!target) return false;
    try {
      return StrKey.isValidEd25519PublicKey(target);
    } catch {
      return false;
    }
  }, [target]);

  const overBalance =
    minorUnits !== null &&
    selectedBalance !== undefined &&
    BigInt(minorUnits) > BigInt(selectedBalance.balance);

  const withdraw = useMutation({
    mutationFn: () => {
      if (!selected || !minorUnits) throw new Error("Enter a valid amount.");
      return api.withdraw(accessToken, idempotency.next(), {
        amount: minorUnits,
        currency: selected,
        // Omitted when it is the sign-in wallet: the server already defaults
        // to it, and not sending it keeps the common path unambiguous.
        ...(useOther ? { destinationAddress: target } : {}),
      });
    },
    onSuccess: async () => {
      idempotency.reset();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.treasuryBalances() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.treasuryMovements() }),
      ]);
      onDone();
    },
  });

  const canSubmit =
    Boolean(minorUnits) &&
    minorUnits !== "0" &&
    destinationValid &&
    !overBalance &&
    !withdraw.isPending;

  return (
    <Screen
      footer={
        <Button
          label="Review withdrawal"
          onPress={() => setConfirming(true)}
          disabled={!canSubmit}
          busy={withdraw.isPending}
        />
      }
    >
      <View style={styles.header}>
        <Eyebrow>Withdraw</Eyebrow>
        <Text variant="displaySm" tone={color.onDark}>
          Send to a Stellar wallet
        </Text>
      </View>

      {withdraw.error ? <InlineError error={withdraw.error} /> : null}

      {spendable.length > 1 ? (
        <View style={styles.currencies}>
          {spendable.map((entry) => (
            <Button
              key={entry.currency}
              label={entry.currency}
              onPress={() => setCurrency(entry.currency)}
              variant={selected === entry.currency ? "primary" : "secondary"}
              size="sm"
              fullWidth={false}
            />
          ))}
        </View>
      ) : null}

      {selectedBalance && selected ? (
        <Card style={styles.balanceCard}>
          <Label>Available</Label>
          <View style={styles.balanceRow}>
            <Mono variant="numberLg" tone={color.onDark}>
              {formatAmount(selectedBalance.balance, selected)}
            </Mono>
            <Text variant="titleSm" tone={color.mutedStrong}>
              {selected}
            </Text>
          </View>
          <Button
            label="Withdraw all"
            onPress={() => {
              // Round-trips through the same formatter the input parses, so
              // "all" is exactly the balance rather than a re-derived value.
              setAmount(
                formatAmount(selectedBalance.balance, selected).replace(
                  /,/g,
                  "",
                ),
              );
            }}
            variant="ghost"
            size="sm"
            fullWidth={false}
          />
        </Card>
      ) : null}

      <Input
        label="Amount"
        value={amount}
        onChangeText={setAmount}
        placeholder="0.00"
        keyboardType="decimal-pad"
        mono
        error={
          overBalance
            ? "That is more than your available balance."
            : amount.length > 0 && !minorUnits
              ? "Enter a valid amount."
              : null
        }
      />

      <Card style={styles.destinationCard}>
        <Label>Destination</Label>
        {useOther ? (
          <Input
            value={destination}
            onChangeText={setDestination}
            placeholder="G…"
            autoCapitalize="characters"
            autoCorrect={false}
            mono
            multiline
            error={
              destination.length > 0 && !destinationValid
                ? "That is not a valid Stellar address."
                : null
            }
          />
        ) : (
          <Mono variant="numberSm" tone={color.body} numberOfLines={2}>
            {signInAddress}
          </Mono>
        )}
        <Button
          label={useOther ? "Use my sign-in wallet" : "Send somewhere else"}
          onPress={() => {
            setUseOther((value) => !value);
            setDestination("");
          }}
          variant="ghost"
          size="sm"
          fullWidth={false}
        />
        {useOther ? (
          <Text variant="bodySm" tone={color.statusDisputed}>
            Check this address carefully. A transfer to the wrong Stellar
            address cannot be reversed.
          </Text>
        ) : null}
      </Card>

      <ConfirmSheet
        visible={confirming}
        title="Confirm withdrawal"
        message={`Funds will be sent to ${shortenAddress(target, 6)} on the Stellar network. This cannot be reversed.`}
        detail={
          minorUnits && selected ? formatMoney(minorUnits, selected) : undefined
        }
        confirmLabel="Withdraw"
        busy={withdraw.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          withdraw.mutate();
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: space.xxs, paddingTop: space.lg, paddingBottom: space.md },
  currencies: { flexDirection: "row", gap: space.xs, marginBottom: space.sm },
  balanceCard: { gap: space.xxs, marginBottom: space.md },
  balanceRow: { flexDirection: "row", alignItems: "baseline", gap: space.xs },
  destinationCard: { gap: space.xs, marginTop: space.md },
});
