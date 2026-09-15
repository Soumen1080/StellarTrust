/**
 * One tokenized asset, and buying into it.
 *
 * An investment screen has an obligation a payment screen does not: it must
 * state what can go wrong. The risk block is not a disclaimer at the bottom —
 * it carries the issuer's reputation, the counterparty, the maturity and
 * whether the instrument is already overdue or disputed, before the buy
 * button.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { api } from "../../api/client";
import { useAccessToken, useAuth } from "../../auth/AuthProvider";
import { Button } from "../../components/Button";
import { Card, DataRow, Divider } from "../../components/Card";
import { ConfirmSheet } from "../../components/ConfirmSheet";
import { Input } from "../../components/Input";
import { Screen } from "../../components/Screen";
import { StatusPill } from "../../components/StatusPill";
import { Eyebrow, Label, Mono, Text } from "../../components/Text";
import {
  ErrorState,
  InlineError,
  SkeletonList,
} from "../../components/States";
import { useIdempotencyKey } from "../../lib/idempotency";
import { formatMoney, formatTimestamp } from "../../lib/money";
import { queryKeys } from "../../lib/query";
import { color, radius, space } from "../../theme";

export function TokenizationDetailScreen({
  tokenizationId,
}: {
  tokenizationId: string;
}) {
  const accessToken = useAccessToken();
  const { session, isVerified } = useAuth();
  const queryClient = useQueryClient();
  const idempotency = useIdempotencyKey();

  const [units, setUnits] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const detail = useQuery({
    queryKey: queryKeys.tokenization(tokenizationId),
    queryFn: () => api.getTokenization(accessToken, tokenizationId),
  });

  const purchase = useMutation({
    mutationFn: () => {
      const holderAddress = session?.wallet.stellarPublicKey;
      if (!holderAddress) throw new Error("No wallet is connected.");
      return api.purchaseUnits(accessToken, tokenizationId, idempotency.next(), {
        units: units.trim(),
        holderAddress,
      });
    },
    onSuccess: async () => {
      idempotency.reset();
      setUnits("");
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.tokenization(tokenizationId),
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.rwaPortfolio() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.treasuryBalances() }),
      ]);
    },
  });

  const totalCost = useMemo(() => {
    if (!detail.data || !/^\d+$/.test(units.trim()) || units.trim() === "0") {
      return null;
    }
    try {
      const cost =
        BigInt(units.trim()) *
        BigInt(detail.data.tokenization.pricePerUnitAmount);
      return cost.toString();
    } catch {
      return null;
    }
  }, [units, detail.data]);

  if (detail.isLoading) {
    return (
      <Screen>
        <SkeletonList count={3} />
      </Screen>
    );
  }

  if (detail.isError || !detail.data) {
    return (
      <Screen>
        <ErrorState
          error={detail.error}
          onRetry={() => void detail.refetch()}
        />
      </Screen>
    );
  }

  const { tokenization, asset, availableUnits, totalRaised, risk } = detail.data;

  const unitsValid =
    /^\d+$/.test(units.trim()) &&
    units.trim() !== "0" &&
    (() => {
      try {
        return BigInt(units.trim()) <= BigInt(availableUnits);
      } catch {
        return false;
      }
    })();

  const canBuy =
    isVerified &&
    !tokenization.frozen &&
    tokenization.status === "active" &&
    availableUnits !== "0";

  return (
    <Screen
      onRefresh={async () => {
        setRefreshing(true);
        try {
          await detail.refetch();
        } finally {
          setRefreshing(false);
        }
      }}
      refreshing={refreshing}
      footer={
        canBuy ? (
          <Button
            label="Buy units"
            onPress={() => setConfirming(true)}
            disabled={!unitsValid || purchase.isPending}
            busy={purchase.isPending}
            haptic
          />
        ) : undefined
      }
    >
      <View style={styles.hero}>
        <Eyebrow>Tokenized asset</Eyebrow>
        <Text variant="titleLg" tone={color.onDark}>
          {asset.description}
        </Text>
        <View style={styles.heroMeta}>
          <StatusPill status={tokenization.status} />
          {tokenization.frozen ? <StatusPill status="frozen" size="sm" /> : null}
        </View>
      </View>

      {purchase.error ? <InlineError error={purchase.error} /> : null}

      {purchase.isSuccess ? (
        <Card style={styles.success}>
          <Text variant="titleSm" tone={color.statusVerified}>
            Purchase complete
          </Text>
          <Text variant="bodySm" tone={color.mutedStrong}>
            Your units are in your portfolio.
          </Text>
        </Card>
      ) : null}

      <Card>
        <Label>Terms</Label>
        <View style={styles.rows}>
          <DataRow
            label="Price per unit"
            value={formatMoney(
              tokenization.pricePerUnitAmount,
              tokenization.pricePerUnitCurrency,
            )}
          />
          <DataRow
            label="Face value"
            value={formatMoney(
              tokenization.faceValueAmount,
              tokenization.faceValueCurrency,
            )}
          />
          <DataRow
            label="Discount rate"
            value={`${(tokenization.discountRateBps / 100).toFixed(2)}%`}
            tone={color.valueUp}
          />
          <DataRow
            label="Advance rate"
            value={`${(tokenization.advanceRateBps / 100).toFixed(2)}%`}
          />
          <DataRow
            label="Matures"
            value={formatTimestamp(tokenization.maturityDate)}
            mono={false}
          />
          <Divider />
          <DataRow label="Units available" value={availableUnits} />
          <DataRow
            label="Raised so far"
            value={formatMoney(totalRaised, tokenization.pricePerUnitCurrency)}
          />
        </View>
      </Card>

      <Card
        style={[
          styles.riskCard,
          (risk.overdue || risk.disputed) && styles.riskCardAlert,
        ]}
      >
        <Label>What you are taking on</Label>
        <View style={styles.rows}>
          <DataRow
            label={risk.overdue ? "Days overdue" : "Days to maturity"}
            value={String(Math.abs(risk.daysRemaining))}
            tone={risk.overdue ? color.statusRejected : color.body}
          />
          <DataRow
            label="Projected yield"
            value={formatMoney(
              risk.projectedYieldAmount,
              tokenization.pricePerUnitCurrency,
            )}
            tone={color.valueUp}
          />
          {risk.issuerReputationScore !== null ? (
            <DataRow
              label="Issuer reputation"
              value={`${Math.round(risk.issuerReputationScore * 100)} / 100`}
            />
          ) : null}
          {risk.counterparty ? (
            <DataRow
              label="Obligor"
              value={risk.counterparty.name}
              mono={false}
            />
          ) : null}
        </View>

        <Text variant="bodySm" tone={color.mutedStrong} style={styles.riskNote}>
          {risk.overdue
            ? "This instrument is past its maturity date and has not been collected. It may not pay out in full, or at all."
            : risk.disputed
              ? "The underlying asset is under dispute. Payout is uncertain until it is resolved."
              : "Payout depends on the obligor settling the underlying receivable at maturity. Capital is at risk."}
        </Text>
      </Card>

      {canBuy ? (
        <View style={styles.buy}>
          <Input
            label="Units to buy"
            value={units}
            onChangeText={setUnits}
            placeholder="0"
            keyboardType="number-pad"
            mono
            error={
              units.length > 0 && !unitsValid
                ? `Enter a whole number of units, up to ${availableUnits}.`
                : null
            }
            hint={`${availableUnits} available`}
          />
          {totalCost ? (
            <Card style={styles.costCard}>
              <Label>Total cost</Label>
              <Mono variant="numberLg" tone={color.onDark}>
                {formatMoney(totalCost, tokenization.pricePerUnitCurrency)}
              </Mono>
            </Card>
          ) : null}
        </View>
      ) : !isVerified ? (
        <Card style={styles.gate}>
          <Text variant="bodySm" tone={color.statusReview}>
            Verify your identity to invest.
          </Text>
        </Card>
      ) : null}

      <ConfirmSheet
        visible={confirming}
        title="Confirm purchase"
        message={`You are buying ${units.trim()} units. Capital is at risk: payout depends on the obligor settling at maturity.`}
        detail={
          totalCost
            ? formatMoney(totalCost, tokenization.pricePerUnitCurrency)
            : undefined
        }
        confirmLabel="Buy units"
        busy={purchase.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          purchase.mutate();
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { gap: space.xs, paddingTop: space.lg, paddingBottom: space.md },
  heroMeta: { flexDirection: "row", alignItems: "center", gap: space.xs },
  rows: { marginTop: space.xxs },
  riskCard: { marginTop: space.sm, backgroundColor: color.surfaceElevatedDark },
  riskCardAlert: { borderColor: `${color.statusDisputed}4d` },
  riskNote: { marginTop: space.sm },
  success: {
    marginBottom: space.sm,
    gap: 2,
    borderColor: `${color.statusVerified}4d`,
    backgroundColor: `${color.statusVerified}14`,
  },
  buy: { gap: space.sm, marginTop: space.md },
  costCard: { gap: 2 },
  gate: {
    marginTop: space.md,
    borderColor: `${color.statusReview}4d`,
    backgroundColor: `${color.statusReview}14`,
  },
});
