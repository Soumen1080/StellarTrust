/**
 * Open a new escrow order.
 *
 * The amount is parsed to minor units before it is sent — the API deals only
 * in integers, and a float that reached it would be a rounding error in
 * someone's balance. The parse is the same string-based one the web client
 * uses, so "10.005" is accepted or rejected identically on both.
 */
import { SUPPORTED_CURRENCIES, type CurrencyCode } from "@stellartrust/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { api } from "../../api/client";
import { useAccessToken } from "../../auth/AuthProvider";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Input } from "../../components/Input";
import { Screen } from "../../components/Screen";
import { Eyebrow, Text } from "../../components/Text";
import { InlineError } from "../../components/States";
import { useIdempotencyKey } from "../../lib/idempotency";
import { formatMoney, toMinorUnits } from "../../lib/money";
import { queryKeys } from "../../lib/query";
import { color, space } from "../../theme";
import { useEscrowCapabilities } from "./useEscrowAction";

export function CreateOrderScreen({
  onCreated,
  onCancel,
}: {
  onCreated: (orderId: string) => void;
  onCancel: () => void;
}) {
  const accessToken = useAccessToken();
  const queryClient = useQueryClient();
  const idempotency = useIdempotencyKey();
  const capabilities = useEscrowCapabilities();

  const [sellerId, setSellerId] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<CurrencyCode>("USDC");
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Only currencies this deployment can actually settle on-chain.
  const currencies = capabilities.data?.supportedCurrencies ?? SUPPORTED_CURRENCIES;

  const minorUnits = toMinorUnits(amount, currency);

  const create = useMutation({
    mutationFn: () => {
      if (!minorUnits) throw new Error("Enter a valid amount.");
      return api.createOrder(accessToken, idempotency.next(), {
        sellerId: sellerId.trim(),
        amount: { amount: minorUnits, currency },
      });
    },
    onSuccess: async (result) => {
      idempotency.reset();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.orders() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.positions() }),
      ]);
      onCreated(result.order.id);
    },
  });

  function submit(): void {
    const next: Record<string, string> = {};
    if (sellerId.trim().length < 3) {
      next.sellerId = "Enter the seller's username or id.";
    }
    if (!minorUnits || minorUnits === "0") {
      next.amount = "Enter an amount greater than zero.";
    }
    setErrors(next);
    if (Object.keys(next).length === 0) create.mutate();
  }

  return (
    <Screen
      footer={
        <View style={styles.footer}>
          <Button
            label="Cancel"
            onPress={onCancel}
            variant="ghost"
            fullWidth={false}
            disabled={create.isPending}
          />
          <Button
            label="Open escrow"
            onPress={submit}
            busy={create.isPending}
            haptic
            style={styles.footerPrimary}
          />
        </View>
      }
    >
      <View style={styles.header}>
        <Eyebrow>New escrow</Eyebrow>
        <Text variant="displaySm" tone={color.onDark}>
          Hold funds until delivery
        </Text>
        <Text variant="bodyMd" tone={color.muted}>
          The seller cannot take the money until you confirm you have received
          what you paid for.
        </Text>
      </View>

      {create.error ? <InlineError error={create.error} /> : null}

      <View style={styles.form}>
        <Input
          label="Seller"
          value={sellerId}
          onChangeText={setSellerId}
          placeholder="username"
          autoCapitalize="none"
          autoCorrect={false}
          error={errors.sellerId}
          hint="The username of the person you are paying"
        />

        <Input
          label="Amount"
          value={amount}
          onChangeText={setAmount}
          placeholder="0.00"
          keyboardType="decimal-pad"
          mono
          error={errors.amount}
          accessory={
            <View style={styles.currencyRow}>
              {currencies.map((code) => (
                <Button
                  key={code}
                  label={code}
                  onPress={() => setCurrency(code)}
                  variant={currency === code ? "primary" : "ghost"}
                  size="sm"
                  fullWidth={false}
                />
              ))}
            </View>
          }
        />

        {minorUnits && minorUnits !== "0" ? (
          <Card style={styles.summary}>
            <Text variant="bodySm" tone={color.muted}>
              You will place
            </Text>
            <Text variant="titleMd" tone={color.onDark}>
              {formatMoney(minorUnits, currency)}
            </Text>
            <Text variant="bodySm" tone={color.muted}>
              into escrow once the seller accepts and you lock the funds.
            </Text>
          </Card>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: space.xxs, paddingTop: space.lg, paddingBottom: space.md },
  form: { gap: space.md },
  currencyRow: { flexDirection: "row", gap: 2 },
  summary: { gap: 2, backgroundColor: color.surfaceElevatedDark },
  footer: { flexDirection: "row", alignItems: "center", gap: space.sm },
  footerPrimary: { flex: 1 },
});
