/**
 * One escrow order.
 *
 * Shows where the money is, what happens next, and the one or two steps this
 * party can take. Each step that moves funds goes through a confirm sheet
 * naming the amount and the consequence — an escrow release is irreversible,
 * and a mis-tap should not be able to cause one.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { api } from "../../api/client";
import { useAccessToken, useAuth } from "../../auth/AuthProvider";
import { Button } from "../../components/Button";
import { Card, DataRow, Divider } from "../../components/Card";
import { ConfirmSheet } from "../../components/ConfirmSheet";
import { Screen } from "../../components/Screen";
import { StatusPill } from "../../components/StatusPill";
import { Eyebrow, Label, Mono, Text } from "../../components/Text";
import {
  ErrorState,
  InlineError,
  SkeletonList,
} from "../../components/States";
import { transactionUrl } from "../../lib/explorer";
import { formatMoney, formatTimestamp, shortenAddress } from "../../lib/money";
import { queryKeys } from "../../lib/query";
import { color, space } from "../../theme";
import { counterpartyOf } from "./counterparty";
import { actionsFor, statusExplanation, type AvailableAction } from "./transitions";
import { useEscrowAction } from "./useEscrowAction";

export function OrderDetailScreen({
  orderId,
  onOpenDispute,
}: {
  orderId: string;
  onOpenDispute: (orderId: string) => void;
}) {
  const accessToken = useAccessToken();
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [confirming, setConfirming] = useState<AvailableAction | null>(null);

  const order = useQuery({
    queryKey: queryKeys.order(orderId),
    queryFn: () => api.getOrder(accessToken, orderId),
  });

  const action = useEscrowAction(orderId);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await queryClient.invalidateQueries({ queryKey: queryKeys.order(orderId) });
    } finally {
      setRefreshing(false);
    }
  }, [queryClient, orderId]);

  if (order.isLoading) {
    return (
      <Screen>
        <SkeletonList count={3} />
      </Screen>
    );
  }

  if (order.isError || !order.data) {
    return (
      <Screen>
        <ErrorState error={order.error} onRetry={() => void refresh()} />
      </Screen>
    );
  }

  const details = order.data;
  const party = details.order.buyerId === profile?.user.id ? "buyer" : "seller";
  const counterparty = counterpartyOf(details, profile?.user.id);
  const available = actionsFor(details.order.status, party);
  const blocked = details.blockedByReconciliation;

  return (
    <Screen
      onRefresh={refresh}
      refreshing={refreshing}
      footer={
        available.length > 0 && !blocked ? (
          <View style={styles.footer}>
            {available.map((entry) => (
              <Button
                key={entry.transition}
                label={entry.label}
                variant={entry.variant}
                busy={action.pendingAction === entry.transition}
                disabled={action.pending}
                haptic
                onPress={() => {
                  if (entry.confirm) setConfirming(entry);
                  else action.perform(entry.transition);
                }}
              />
            ))}
          </View>
        ) : undefined
      }
    >
      <View style={styles.hero}>
        <Eyebrow>Escrow order</Eyebrow>
        <Mono variant="numberDisplay" tone={color.onDark}>
          {formatMoney(details.order.amount.amount, details.order.amount.currency)}
        </Mono>
        <View style={styles.heroMeta}>
          <StatusPill status={details.order.status} />
          <Text variant="bodySm" tone={color.muted}>
            {party === "buyer" ? "You are buying" : "You are selling"}
          </Text>
        </View>
      </View>

      <Card style={styles.explain}>
        <Text variant="bodyMd" tone={color.body}>
          {statusExplanation(details.order.status, party)}
        </Text>
      </Card>

      {blocked ? (
        <Card style={styles.blocked}>
          <Text variant="titleSm" tone={color.statusDisputed}>
            Paused pending reconciliation
          </Text>
          <Text variant="bodySm" tone={color.mutedStrong}>
            This order&apos;s ledger and chain records disagree. Actions are
            held until an operator has resolved it — your funds are not at risk.
          </Text>
        </Card>
      ) : null}

      {action.error ? <InlineError error={action.error} /> : null}

      <Card>
        <Label>Details</Label>
        <View style={styles.rows}>
          <DataRow
            label={party === "buyer" ? "Seller" : "Buyer"}
            value={counterparty.label}
            mono={false}
          />
          <DataRow
            label="Amount"
            value={formatMoney(
              details.order.amount.amount,
              details.order.amount.currency,
            )}
          />
          <DataRow label="Opened" value={formatTimestamp(details.order.createdAt)} mono={false} />
          <DataRow label="Order" value={shortenAddress(details.order.id, 6)} />
        </View>
      </Card>

      {details.escrow ? (
        <Card>
          <Label>Contract</Label>
          <View style={styles.rows}>
            <DataRow label="State" mono={false}>
              <StatusPill status={details.escrow.state} size="sm" />
            </DataRow>
            {details.escrow.contractId ? (
              <DataRow
                label="Contract"
                value={shortenAddress(details.escrow.contractId, 6)}
              />
            ) : null}
          </View>
        </Card>
      ) : null}

      {details.transitions.length > 0 ? (
        <Card>
          <Label>History</Label>
          <View style={styles.rows}>
            {details.transitions.map((transition, index) => {
              // Bound here so the null check narrows for the callback below;
              // a nested optional property does not narrow across a closure.
              const hash = transition.stellarTransaction?.hash ?? null;
              return (
                <View key={transition.id}>
                  {index > 0 ? <Divider /> : null}
                  <View style={styles.historyRow}>
                    <View style={styles.historyMain}>
                      <Text variant="titleSm" tone={color.onDark}>
                        {TRANSITION_LABEL[transition.transition] ??
                          transition.transition}
                      </Text>
                      <Text variant="bodySm" tone={color.muted}>
                        {formatTimestamp(transition.createdAt)}
                      </Text>
                    </View>
                    {hash ? (
                      <Button
                        label="View"
                        variant="ghost"
                        size="sm"
                        fullWidth={false}
                        onPress={() =>
                          void Linking.openURL(transactionUrl(hash))
                        }
                      />
                    ) : null}
                  </View>
                </View>
              );
            })}
          </View>
        </Card>
      ) : null}

      {details.order.status === "disputed" ? (
        <Button
          label="Open the dispute"
          onPress={() => onOpenDispute(details.order.id)}
          variant="secondary"
        />
      ) : null}

      <ConfirmSheet
        visible={confirming !== null}
        title={confirming?.label ?? ""}
        message={confirming?.blurb ?? ""}
        detail={formatMoney(
          details.order.amount.amount,
          details.order.amount.currency,
        )}
        confirmLabel={confirming?.label ?? "Confirm"}
        destructive={confirming?.variant === "danger"}
        busy={action.pending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const chosen = confirming;
          setConfirming(null);
          if (chosen) action.perform(chosen.transition);
        }}
      />
    </Screen>
  );
}

const TRANSITION_LABEL: Record<string, string> = {
  create: "Order opened",
  accept: "Seller accepted",
  deposit: "Funds deposited",
  lock: "Locked in escrow",
  confirm: "Delivery confirmed",
  release: "Funds released",
  refund: "Funds refunded",
  dispute: "Dispute raised",
};

const styles = StyleSheet.create({
  hero: { gap: space.xs, paddingTop: space.lg, paddingBottom: space.md },
  heroMeta: { flexDirection: "row", alignItems: "center", gap: space.sm },
  explain: { marginBottom: space.sm, backgroundColor: color.surfaceElevatedDark },
  blocked: {
    marginBottom: space.sm,
    gap: space.xxs,
    borderColor: `${color.statusDisputed}4d`,
    backgroundColor: `${color.statusDisputed}14`,
  },
  rows: { marginTop: space.xxs },
  historyRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: space.xs,
    gap: space.xs,
  },
  historyMain: { flex: 1, gap: 2 },
  footer: { gap: space.xs },
});
