/**
 * Cross-border transfers.
 *
 * In-flight settlements poll: a transfer moves through deposit → convert →
 * payout over minutes, and a user watching the screen should see it advance
 * without pulling to refresh.
 */
import { SettlementStatus } from "@stellartrust/shared";
import { FlashList } from "@shopify/flash-list";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { api } from "../../api/client";
import { useAccessToken, useAuth } from "../../auth/AuthProvider";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { StatusPill } from "../../components/StatusPill";
import { Mono, Text } from "../../components/Text";
import {
  EmptyState,
  ErrorState,
  SkeletonList,
} from "../../components/States";
import { formatMoney, timeAgo } from "../../lib/money";
import { queryKeys } from "../../lib/query";
import { color, space } from "../../theme";

const IN_FLIGHT = new Set<string>([
  SettlementStatus.Quoted,
  SettlementStatus.DepositPending,
  SettlementStatus.Converting,
  SettlementStatus.PayoutPending,
]);

export function SettlementListScreen({
  onOpen,
  onCreate,
}: {
  onOpen: (settlementId: string) => void;
  onCreate: () => void;
}) {
  const accessToken = useAccessToken();
  const { isVerified } = useAuth();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const settlements = useQuery({
    queryKey: queryKeys.settlements(),
    queryFn: () => api.listSettlements(accessToken),
    // Only poll while something is actually moving; a list of completed
    // transfers should not wake the radio every few seconds.
    refetchInterval: (query) =>
      (query.state.data?.settlements ?? []).some((entry) =>
        IN_FLIGHT.has(entry.settlement.status),
      )
        ? 8_000
        : false,
  });

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await queryClient.invalidateQueries({ queryKey: queryKeys.settlements() });
    } finally {
      setRefreshing(false);
    }
  }, [queryClient]);

  const items = useMemo(
    () => settlements.data?.settlements ?? [],
    [settlements.data],
  );

  if (settlements.isError) {
    return (
      <View style={styles.root}>
        <ErrorState error={settlements.error} onRetry={() => void refresh()} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text variant="titleLg" tone={color.onDark}>
          Transfers
        </Text>
        <Button
          label="Send"
          onPress={onCreate}
          size="sm"
          fullWidth={false}
          disabled={!isVerified}
          accessibilityHint={isVerified ? undefined : "Verify your identity first"}
        />
      </View>

      {settlements.isLoading ? (
        <View style={styles.padded}>
          <SkeletonList count={3} />
        </View>
      ) : (
        <FlashList
          data={items}
          keyExtractor={(entry) => entry.settlement.id}
          estimatedItemSize={96}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void refresh()}
              tintColor={color.primary}
              colors={[color.primary]}
              progressBackgroundColor={color.surfaceCardDark}
            />
          }
          ListEmptyComponent={
            <EmptyState
              title="No transfers yet"
              message={
                isVerified
                  ? "Send money abroad and it lands in the recipient's local account."
                  : "Verify your identity to send money abroad."
              }
              actionLabel={isVerified ? "Send money" : undefined}
              onAction={isVerified ? onCreate : undefined}
            />
          }
          renderItem={({ item }) => (
            <Card
              onPress={() => onOpen(item.settlement.id)}
              accessibilityLabel={`Transfer of ${formatMoney(item.settlement.source.amount, item.settlement.source.currency)}, ${item.settlement.status}`}
              style={styles.row}
            >
              <View style={styles.rowTop}>
                <Mono variant="numberMd" tone={color.onDark}>
                  {formatMoney(
                    item.settlement.source.amount,
                    item.settlement.source.currency,
                  )}
                </Mono>
                <StatusPill status={item.settlement.status} size="sm" />
              </View>
              <View style={styles.rowBottom}>
                <Text variant="bodySm" tone={color.muted}>
                  →{" "}
                  {formatMoney(
                    item.settlement.destination.amount,
                    item.settlement.destination.currency,
                  )}
                </Text>
                <Text variant="bodySm" tone={color.muted}>
                  {timeAgo(item.settlement.createdAt)}
                </Text>
              </View>
              {item.settlement.failureReason ? (
                <Text variant="bodySm" tone={color.statusRejected} numberOfLines={2}>
                  {item.settlement.failureReason}
                </Text>
              ) : null}
            </Card>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.canvasDark },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  padded: { paddingHorizontal: space.md },
  listContent: { paddingHorizontal: space.md, paddingBottom: space.xl },
  row: { gap: space.xxs, marginBottom: space.xs },
  rowTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.xs,
  },
  rowBottom: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.xs,
  },
});
