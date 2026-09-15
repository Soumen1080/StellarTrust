/**
 * Home.
 *
 * The first screen after sign-in answers one question — where is my money —
 * and then offers the actions that change it. Balance first, live positions
 * second, actions third.
 *
 * It reads `/api/positions`, which returns orders, settlements, disputes and
 * holdings in a single round trip. Four separate calls here would mean four
 * chances to fail and a screen that assembles itself in pieces.
 */
import { OrderStatus, type CurrencyCode } from "@stellartrust/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { api } from "../../api/client";
import { useAccessToken, useAuth } from "../../auth/AuthProvider";
import { Button } from "../../components/Button";
import { Card, Divider } from "../../components/Card";
import { Screen } from "../../components/Screen";
import { StatusPill } from "../../components/StatusPill";
import { Eyebrow, Label, Mono, Text } from "../../components/Text";
import { ErrorState, SkeletonList } from "../../components/States";
import { counterpartyLabel } from "../escrow/counterparty";
import { formatAmount, formatMoney, timeAgo } from "../../lib/money";
import { queryKeys } from "../../lib/query";
import { color, radius, space } from "../../theme";
import { VerificationBanner } from "./VerificationBanner";

export interface HomeScreenProps {
  onOpenOrder: (orderId: string) => void;
  onOpenSettlement: (settlementId: string) => void;
  onOpenDispute: (disputeId: string) => void;
  onNavigate: (tab: "escrow" | "settlement" | "rwa" | "wallet" | "verify") => void;
}

export function HomeScreen({
  onOpenOrder,
  onOpenSettlement,
  onOpenDispute,
  onNavigate,
}: HomeScreenProps) {
  const accessToken = useAccessToken();
  const { profile, isVerified } = useAuth();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const balances = useQuery({
    queryKey: queryKeys.treasuryBalances(),
    queryFn: () => api.treasuryBalances(accessToken),
  });

  const positions = useQuery({
    queryKey: queryKeys.positions(),
    queryFn: () => api.getPositions(accessToken),
  });

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.treasuryBalances() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.positions() }),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [queryClient]);

  /** Orders still capable of moving — what the user actually has to act on. */
  const liveOrders = useMemo(() => {
    const terminal = new Set<string>([
      OrderStatus.Released,
      OrderStatus.Refunded,
      OrderStatus.Cancelled,
    ]);
    return (positions.data?.orders ?? []).filter(
      (entry) => !terminal.has(entry.order.status),
    );
  }, [positions.data]);

  const openDisputes = positions.data?.disputes ?? [];
  const holdings = positions.data?.holdings ?? [];

  if (positions.isError) {
    return (
      <Screen>
        <ErrorState error={positions.error} onRetry={() => void refresh()} />
      </Screen>
    );
  }

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <View style={styles.greeting}>
        <Eyebrow>
          {profile?.user.username ? `@${profile.user.username}` : "Welcome"}
        </Eyebrow>
        <Text variant="titleLg" tone={color.onDark}>
          {profile?.user.displayName ?? "Your money"}
        </Text>
      </View>

      {!isVerified ? (
        <VerificationBanner onPress={() => onNavigate("verify")} />
      ) : null}

      <BalanceCard
        balances={balances.data?.balances ?? []}
        loading={balances.isLoading}
        onDeposit={() => onNavigate("wallet")}
      />

      <View style={styles.actions}>
        <QuickAction
          label="New escrow"
          blurb="Hold funds until delivery"
          onPress={() => onNavigate("escrow")}
        />
        <QuickAction
          label="Send abroad"
          blurb="Settle into local currency"
          onPress={() => onNavigate("settlement")}
        />
        <QuickAction
          label="Invest"
          blurb="Tokenized real-world assets"
          onPress={() => onNavigate("rwa")}
        />
      </View>

      {positions.isLoading ? (
        <View style={styles.section}>
          <SkeletonList count={2} />
        </View>
      ) : null}

      {openDisputes.length > 0 ? (
        <Section title="Needs your attention">
          {openDisputes.slice(0, 3).map((dispute) => (
            <Card
              key={dispute.id}
              onPress={() => onOpenDispute(dispute.id)}
              accessibilityLabel={`Dispute ${dispute.id}, ${dispute.status}`}
              style={styles.rowCard}
            >
              <View style={styles.rowTop}>
                <Text variant="titleSm" tone={color.onDark}>
                  Dispute
                </Text>
                <StatusPill status={dispute.status} size="sm" />
              </View>
              <Text variant="bodySm" tone={color.muted} numberOfLines={1}>
                Opened {timeAgo(dispute.createdAt)}
              </Text>
            </Card>
          ))}
        </Section>
      ) : null}

      {liveOrders.length > 0 ? (
        <Section
          title="Active escrows"
          actionLabel="See all"
          onAction={() => onNavigate("escrow")}
        >
          {liveOrders.slice(0, 4).map((entry) => (
            <Card
              key={entry.order.id}
              onPress={() => onOpenOrder(entry.order.id)}
              accessibilityLabel={`Order for ${formatMoney(entry.order.amount.amount, entry.order.amount.currency)}, ${entry.order.status}`}
              style={styles.rowCard}
            >
              <View style={styles.rowTop}>
                <Mono variant="numberMd" tone={color.onDark}>
                  {formatMoney(
                    entry.order.amount.amount,
                    entry.order.amount.currency,
                  )}
                </Mono>
                <StatusPill status={entry.order.status} size="sm" />
              </View>
              <Text variant="bodySm" tone={color.muted} numberOfLines={1}>
                {counterpartyLabel(entry, profile?.user.id)} ·{" "}
                {timeAgo(entry.order.createdAt)}
              </Text>
            </Card>
          ))}
        </Section>
      ) : null}

      {(positions.data?.settlements.length ?? 0) > 0 ? (
        <Section
          title="Transfers"
          actionLabel="See all"
          onAction={() => onNavigate("settlement")}
        >
          {positions.data!.settlements.slice(0, 3).map((entry) => (
            <Card
              key={entry.settlement.id}
              onPress={() => onOpenSettlement(entry.settlement.id)}
              style={styles.rowCard}
            >
              <View style={styles.rowTop}>
                <Mono variant="numberMd" tone={color.onDark}>
                  {formatMoney(
                    entry.settlement.source.amount,
                    entry.settlement.source.currency,
                  )}
                </Mono>
                <StatusPill status={entry.settlement.status} size="sm" />
              </View>
              <Text variant="bodySm" tone={color.muted}>
                to {entry.settlement.destination.currency} ·{" "}
                {timeAgo(entry.settlement.createdAt)}
              </Text>
            </Card>
          ))}
        </Section>
      ) : null}

      {holdings.length > 0 ? (
        <Section
          title="Holdings"
          actionLabel="Portfolio"
          onAction={() => onNavigate("rwa")}
        >
          <Card>
            {holdings.slice(0, 4).map((entry, index) => (
              <View key={entry.holding.id}>
                {index > 0 ? <Divider /> : null}
                <View style={styles.holdingRow}>
                  <View style={styles.holdingName}>
                    <Text
                      variant="titleSm"
                      tone={color.onDark}
                      numberOfLines={1}
                    >
                      {entry.asset.description}
                    </Text>
                    <Label>{entry.holding.units} units</Label>
                  </View>
                  <StatusPill status={entry.holding.status} size="sm" />
                </View>
              </View>
            ))}
          </Card>
        </Section>
      ) : null}

      {!positions.isLoading &&
      liveOrders.length === 0 &&
      openDisputes.length === 0 &&
      holdings.length === 0 ? (
        <Card style={styles.emptyCard}>
          <Text variant="titleMd" tone={color.onDark}>
            Nothing in flight
          </Text>
          <Text variant="bodySm" tone={color.muted} style={styles.emptyBlurb}>
            When you open an escrow, send money abroad, or buy into an asset, it
            will show here.
          </Text>
          <Button
            label="Open your first escrow"
            onPress={() => onNavigate("escrow")}
            variant="secondary"
          />
        </Card>
      ) : null}
    </Screen>
  );
}

/**
 * Total balance.
 *
 * Deliberately does not sum across currencies: adding USDC to EURC needs an FX
 * rate, and a headline number derived from a stale rate is a wrong number
 * about someone's money. The largest holding leads; the rest are listed.
 */
function BalanceCard({
  balances,
  loading,
  onDeposit,
}: {
  balances: { currency: CurrencyCode; balance: string }[];
  loading: boolean;
  onDeposit: () => void;
}) {
  const sorted = useMemo(
    () =>
      [...balances].sort((a, b) => {
        // String compare would order "9" above "100"; length first is the
        // cheap correct comparison for equal-scale minor units.
        if (a.balance.length !== b.balance.length) {
          return b.balance.length - a.balance.length;
        }
        return b.balance.localeCompare(a.balance);
      }),
    [balances],
  );

  const primary = sorted[0];
  const rest = sorted.slice(1).filter((entry) => entry.balance !== "0");

  return (
    <Card style={styles.balanceCard}>
      <Label>Available balance</Label>
      {loading ? (
        <Mono variant="numberDisplay" tone={color.muted}>
          —
        </Mono>
      ) : primary ? (
        <View style={styles.balanceRow}>
          <Mono variant="numberDisplay" tone={color.onDark}>
            {formatAmount(primary.balance, primary.currency)}
          </Mono>
          <Text variant="titleMd" tone={color.mutedStrong}>
            {primary.currency}
          </Text>
        </View>
      ) : (
        <Mono variant="numberDisplay" tone={color.onDark}>
          0.00
        </Mono>
      )}

      {rest.length > 0 ? (
        <View style={styles.otherBalances}>
          {rest.map((entry) => (
            <View key={entry.currency} style={styles.chip}>
              <Mono variant="numberSm" tone={color.body}>
                {formatMoney(entry.balance, entry.currency)}
              </Mono>
            </View>
          ))}
        </View>
      ) : null}

      <Button label="Deposit or withdraw" onPress={onDeposit} variant="secondary" />
    </Card>
  );
}

function QuickAction({
  label,
  blurb,
  onPress,
}: {
  label: string;
  blurb: string;
  onPress: () => void;
}) {
  return (
    <Card
      onPress={onPress}
      accessibilityLabel={`${label}. ${blurb}`}
      style={styles.action}
    >
      <Text variant="titleSm" tone={color.onDark}>
        {label}
      </Text>
      <Text variant="bodySm" tone={color.muted}>
        {blurb}
      </Text>
    </Card>
  );
}

function Section({
  title,
  actionLabel,
  onAction,
  children,
}: {
  title: string;
  actionLabel?: string;
  onAction?: () => void;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text variant="titleMd" tone={color.onDark}>
          {title}
        </Text>
        {actionLabel && onAction ? (
          <Button
            label={actionLabel}
            onPress={onAction}
            variant="ghost"
            size="sm"
            fullWidth={false}
          />
        ) : null}
      </View>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  greeting: { paddingTop: space.md, paddingBottom: space.sm },
  balanceCard: { gap: space.sm, marginBottom: space.md },
  balanceRow: { flexDirection: "row", alignItems: "baseline", gap: space.xs },
  otherBalances: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  chip: {
    paddingHorizontal: space.xs,
    paddingVertical: space.xxs,
    borderRadius: radius.sm,
    backgroundColor: color.surfaceElevatedDark,
  },
  actions: { flexDirection: "row", gap: space.xs, marginBottom: space.md },
  action: { flex: 1, gap: 2, padding: space.sm },
  section: { marginTop: space.lg, gap: space.xs },
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionBody: { gap: space.xs },
  rowCard: { gap: space.xxs },
  rowTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.xs,
  },
  holdingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: space.xs,
    gap: space.xs,
  },
  holdingName: { flex: 1, gap: 2 },
  emptyCard: { marginTop: space.lg, gap: space.xs, alignItems: "flex-start" },
  emptyBlurb: { marginBottom: space.xs },
});
