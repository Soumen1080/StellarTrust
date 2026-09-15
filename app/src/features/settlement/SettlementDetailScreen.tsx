/**
 * One cross-border transfer.
 *
 * The progress track is the substance of this screen. A transfer crosses an
 * anchor, a DEX and a payout scheme, and "processing" for four minutes with no
 * indication of which leg it is on is the single most common support ticket in
 * remittance. Each leg is named and timestamped as it completes.
 */
import { SettlementStatus } from "@stellartrust/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";
import { api } from "../../api/client";
import { useAccessToken } from "../../auth/AuthProvider";
import { Card, DataRow, Divider } from "../../components/Card";
import { Screen } from "../../components/Screen";
import { StatusPill } from "../../components/StatusPill";
import { Eyebrow, Label, Mono, Text } from "../../components/Text";
import { ErrorState, SkeletonList } from "../../components/States";
import { formatMoney, formatTimestamp, timeAgo } from "../../lib/money";
import { queryKeys } from "../../lib/query";
import { color, radius, space } from "../../theme";

/** The legs a transfer passes through, in order. */
const LEGS = [
  { status: SettlementStatus.DepositPending, label: "Funds taken from your balance" },
  { status: SettlementStatus.Converting, label: "Converted at the quoted rate" },
  { status: SettlementStatus.PayoutPending, label: "Sent to the payout scheme" },
  { status: SettlementStatus.Completed, label: "Delivered to the recipient" },
] as const;

export function SettlementDetailScreen({
  settlementId,
}: {
  settlementId: string;
}) {
  const accessToken = useAccessToken();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const settlement = useQuery({
    queryKey: queryKeys.settlement(settlementId),
    queryFn: () => api.getSettlement(accessToken, settlementId),
    refetchInterval: (query) => {
      const status = query.state.data?.settlement.status;
      return status === SettlementStatus.Completed ||
        status === SettlementStatus.Failed
        ? false
        : 6_000;
    },
  });

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.settlement(settlementId),
      });
    } finally {
      setRefreshing(false);
    }
  }, [queryClient, settlementId]);

  if (settlement.isLoading) {
    return (
      <Screen>
        <SkeletonList count={3} />
      </Screen>
    );
  }

  if (settlement.isError || !settlement.data) {
    return (
      <Screen>
        <ErrorState error={settlement.error} onRetry={() => void refresh()} />
      </Screen>
    );
  }

  const { settlement: record, transitions } = settlement.data;
  const failed = record.status === SettlementStatus.Failed;

  /** Index of the furthest leg reached; everything before it is done. */
  const reachedIndex = LEGS.findIndex((leg) => leg.status === record.status);
  const completedThrough =
    record.status === SettlementStatus.Completed ? LEGS.length : reachedIndex;

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <View style={styles.hero}>
        <Eyebrow>Transfer</Eyebrow>
        <Mono variant="numberDisplay" tone={color.onDark}>
          {formatMoney(record.destination.amount, record.destination.currency)}
        </Mono>
        <View style={styles.heroMeta}>
          <StatusPill status={record.status} />
          <Text variant="bodySm" tone={color.muted}>
            {timeAgo(record.createdAt)}
          </Text>
        </View>
      </View>

      {failed && record.failureReason ? (
        <Card style={styles.failed}>
          <Text variant="titleSm" tone={color.statusRejected}>
            This transfer did not complete
          </Text>
          <Text variant="bodySm" tone={color.mutedStrong}>
            {record.failureReason}
          </Text>
          <Text variant="bodySm" tone={color.muted}>
            Funds that had left your balance are returned automatically.
          </Text>
        </Card>
      ) : (
        <Card>
          <Label>Progress</Label>
          <View style={styles.track}>
            {LEGS.map((leg, index) => {
              const done = index < completedThrough;
              const active = index === completedThrough;
              return (
                <View key={leg.status} style={styles.leg}>
                  <View style={styles.legMarker}>
                    <View
                      style={[
                        styles.dot,
                        done && styles.dotDone,
                        active && styles.dotActive,
                      ]}
                    />
                    {index < LEGS.length - 1 ? (
                      <View style={[styles.line, done && styles.lineDone]} />
                    ) : null}
                  </View>
                  <View style={styles.legBody}>
                    <Text
                      variant="bodyMd"
                      tone={done || active ? color.body : color.muted}
                    >
                      {leg.label}
                    </Text>
                    {active ? (
                      <Text variant="bodySm" tone={color.primary}>
                        In progress…
                      </Text>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </View>
        </Card>
      )}

      <Card>
        <Label>Details</Label>
        <View style={styles.rows}>
          <DataRow
            label="You sent"
            value={formatMoney(record.source.amount, record.source.currency)}
          />
          <DataRow
            label="They receive"
            value={formatMoney(
              record.destination.amount,
              record.destination.currency,
            )}
          />
          <DataRow label="Rate" value={record.route.effectiveRate} />
          <DataRow
            label="Fee"
            value={formatMoney(record.route.fee.amount, record.route.fee.currency)}
          />
          <Divider />
          <DataRow label="Via" value={record.payout.network} mono={false} />
          <DataRow label="To" value={record.payout.destination.masked} />
          <DataRow
            label="Recipient"
            value={record.payout.destination.holderMasked}
            mono={false}
          />
          {record.destinationReference ? (
            <DataRow label="Reference" value={record.destinationReference} />
          ) : null}
          <DataRow label="Started" value={formatTimestamp(record.createdAt)} mono={false} />
          {record.completedAt ? (
            <DataRow
              label="Completed"
              value={formatTimestamp(record.completedAt)}
              mono={false}
            />
          ) : null}
        </View>
      </Card>

      {transitions.length > 0 ? (
        <Card>
          <Label>History</Label>
          <View style={styles.rows}>
            {transitions.map((transition, index) => (
              <View key={`${transition.transition}-${index}`}>
                {index > 0 ? <Divider /> : null}
                <View style={styles.historyRow}>
                  <Text variant="bodyMd" tone={color.body}>
                    {transition.transition.replace(/_/g, " ")}
                  </Text>
                  <Text variant="bodySm" tone={color.muted}>
                    {formatTimestamp(transition.createdAt)}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { gap: space.xs, paddingTop: space.lg, paddingBottom: space.md },
  heroMeta: { flexDirection: "row", alignItems: "center", gap: space.sm },
  failed: {
    gap: space.xxs,
    marginBottom: space.sm,
    borderColor: `${color.statusRejected}4d`,
    backgroundColor: `${color.statusRejected}14`,
  },
  track: { marginTop: space.xs },
  leg: { flexDirection: "row", gap: space.sm },
  legMarker: { alignItems: "center", width: 16 },
  dot: {
    width: 10,
    height: 10,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceElevatedDark,
    marginTop: 5,
  },
  dotDone: { backgroundColor: color.statusVerified },
  dotActive: { backgroundColor: color.primary },
  line: { flex: 1, width: 2, backgroundColor: color.surfaceElevatedDark, marginVertical: 2 },
  lineDone: { backgroundColor: color.statusVerified },
  legBody: { flex: 1, paddingBottom: space.sm, gap: 2 },
  rows: { marginTop: space.xxs },
  historyRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: space.xs,
    gap: space.sm,
  },
});
