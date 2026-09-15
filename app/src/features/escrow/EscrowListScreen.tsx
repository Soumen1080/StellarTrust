/**
 * Escrow orders.
 *
 * A FlashList rather than a ScrollView: this list grows without bound for an
 * active trader, and recycling rows is the difference between a scroll that
 * stays at 60fps and one that stutters after fifty items.
 */
import { OrderStatus } from "@stellartrust/shared";
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
import { counterpartyLabel } from "./counterparty";

type Filter = "all" | "active" | "done";

const TERMINAL = new Set<string>([
  OrderStatus.Released,
  OrderStatus.Refunded,
  OrderStatus.Cancelled,
]);

export function EscrowListScreen({
  onOpenOrder,
  onCreate,
}: {
  onOpenOrder: (orderId: string) => void;
  onCreate: () => void;
}) {
  const accessToken = useAccessToken();
  const { profile, isVerified } = useAuth();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>("active");
  const [refreshing, setRefreshing] = useState(false);

  const orders = useQuery({
    queryKey: queryKeys.orders(),
    queryFn: () => api.listOrders(accessToken),
  });

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await queryClient.invalidateQueries({ queryKey: queryKeys.orders() });
    } finally {
      setRefreshing(false);
    }
  }, [queryClient]);

  const visible = useMemo(() => {
    const all = orders.data?.orders ?? [];
    if (filter === "active") {
      return all.filter((entry) => !TERMINAL.has(entry.order.status));
    }
    if (filter === "done") {
      return all.filter((entry) => TERMINAL.has(entry.order.status));
    }
    return all;
  }, [orders.data, filter]);

  if (orders.isError) {
    return (
      <View style={styles.root}>
        <ErrorState error={orders.error} onRetry={() => void refresh()} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={styles.filters}>
          {(["active", "done", "all"] as const).map((value) => (
            <Button
              key={value}
              label={value === "done" ? "Completed" : value === "all" ? "All" : "Active"}
              onPress={() => setFilter(value)}
              variant={filter === value ? "primary" : "secondary"}
              size="sm"
              fullWidth={false}
            />
          ))}
        </View>
        <Button
          label="New escrow"
          onPress={onCreate}
          size="sm"
          fullWidth={false}
          disabled={!isVerified}
          accessibilityHint={
            isVerified ? undefined : "Verify your identity first"
          }
        />
      </View>

      {orders.isLoading ? (
        <View style={styles.padded}>
          <SkeletonList count={4} />
        </View>
      ) : (
        <FlashList
          data={visible}
          keyExtractor={(entry) => entry.order.id}
          estimatedItemSize={92}
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
              title={
                filter === "done" ? "Nothing completed yet" : "No active escrows"
              }
              message={
                isVerified
                  ? "An escrow holds the buyer's funds in a contract until delivery is confirmed."
                  : "Verify your identity to open your first escrow."
              }
              actionLabel={isVerified ? "Open an escrow" : undefined}
              onAction={isVerified ? onCreate : undefined}
            />
          }
          renderItem={({ item }) => (
            <Card
              onPress={() => onOpenOrder(item.order.id)}
              accessibilityLabel={`Order ${formatMoney(item.order.amount.amount, item.order.amount.currency)}, ${item.order.status}`}
              style={styles.row}
            >
              <View style={styles.rowTop}>
                <Mono variant="numberMd" tone={color.onDark}>
                  {formatMoney(
                    item.order.amount.amount,
                    item.order.amount.currency,
                  )}
                </Mono>
                <StatusPill status={item.order.status} size="sm" />
              </View>
              <View style={styles.rowBottom}>
                <Text variant="bodySm" tone={color.muted} numberOfLines={1}>
                  {counterpartyLabel(item, profile?.user.id)}
                </Text>
                <Text variant="bodySm" tone={color.muted}>
                  {timeAgo(item.order.createdAt)}
                </Text>
              </View>
              {item.blockedByReconciliation ? (
                <Text variant="bodySm" tone={color.statusDisputed}>
                  Paused pending reconciliation
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
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  filters: { flexDirection: "row", gap: space.xxs, flexShrink: 1 },
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
