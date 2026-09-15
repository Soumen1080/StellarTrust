/** Disputes this user is a party to. */
import { DisputeStatus } from "@stellartrust/shared";
import { FlashList } from "@shopify/flash-list";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { api } from "../../api/client";
import { useAccessToken } from "../../auth/AuthProvider";
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

export function DisputeListScreen({
  onOpen,
}: {
  onOpen: (disputeId: string) => void;
}) {
  const accessToken = useAccessToken();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const disputes = useQuery({
    queryKey: queryKeys.disputes(),
    queryFn: () => api.listDisputes(accessToken),
  });

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await queryClient.invalidateQueries({ queryKey: queryKeys.disputes() });
    } finally {
      setRefreshing(false);
    }
  }, [queryClient]);

  if (disputes.isError) {
    return (
      <View style={styles.root}>
        <ErrorState error={disputes.error} onRetry={() => void refresh()} />
      </View>
    );
  }

  const items = disputes.data?.disputes ?? [];

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text variant="titleLg" tone={color.onDark}>
          Disputes
        </Text>
      </View>

      {disputes.isLoading ? (
        <View style={styles.padded}>
          <SkeletonList count={3} />
        </View>
      ) : (
        <FlashList
          data={items}
          keyExtractor={(item) => item.id}
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
              title="No disputes"
              message="If something goes wrong with an order, either side can raise a dispute and an arbiter decides."
            />
          }
          renderItem={({ item }) => {
            const open = item.status !== DisputeStatus.Resolved;
            const hoursLeft = Math.max(
              0,
              Math.round(
                (Date.parse(item.evidenceWindowClosesAt) - Date.now()) / 3_600_000,
              ),
            );
            return (
              <Card
                onPress={() => onOpen(item.id)}
                accessibilityLabel={`Dispute over ${formatMoney(item.amount.amount, item.amount.currency)}, ${item.status}`}
                style={styles.row}
              >
                <View style={styles.rowTop}>
                  <Mono variant="numberMd" tone={color.onDark}>
                    {formatMoney(item.amount.amount, item.amount.currency)}
                  </Mono>
                  <StatusPill status={item.status} size="sm" />
                </View>
                <Text variant="bodySm" tone={color.muted} numberOfLines={2}>
                  {item.reason}
                </Text>
                <View style={styles.rowBottom}>
                  <Text variant="bodySm" tone={color.muted}>
                    {timeAgo(item.createdAt)}
                  </Text>
                  {open && hoursLeft > 0 ? (
                    <Text variant="bodySm" tone={color.statusReview}>
                      {hoursLeft}h to add evidence
                    </Text>
                  ) : null}
                </View>
              </Card>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.canvasDark },
  header: { paddingHorizontal: space.md, paddingVertical: space.sm },
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
