/**
 * Investment portfolio.
 *
 * Leads with what was invested and what has actually come back, and shows
 * realized losses with the same prominence as yield. A portfolio view that
 * displays only gains teaches the wrong thing about an asset class where the
 * obligor sometimes does not pay.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";
import { api } from "../../api/client";
import { useAccessToken } from "../../auth/AuthProvider";
import { Card, DataRow, Divider } from "../../components/Card";
import { Screen } from "../../components/Screen";
import { StatusPill } from "../../components/StatusPill";
import { Eyebrow, Label, Mono, Text } from "../../components/Text";
import {
  EmptyState,
  ErrorState,
  SkeletonList,
} from "../../components/States";
import { formatMoney } from "../../lib/money";
import { queryKeys } from "../../lib/query";
import { color, radius, space } from "../../theme";

export function PortfolioScreen({
  onOpen,
}: {
  onOpen: (tokenizationId: string) => void;
}) {
  const accessToken = useAccessToken();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const portfolio = useQuery({
    queryKey: queryKeys.rwaPortfolio(),
    queryFn: () => api.getRwaPortfolio(accessToken),
  });

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await queryClient.invalidateQueries({ queryKey: queryKeys.rwaPortfolio() });
    } finally {
      setRefreshing(false);
    }
  }, [queryClient]);

  if (portfolio.isLoading) {
    return (
      <Screen>
        <SkeletonList count={3} />
      </Screen>
    );
  }

  if (portfolio.isError || !portfolio.data) {
    return (
      <Screen>
        <ErrorState error={portfolio.error} onRetry={() => void refresh()} />
      </Screen>
    );
  }

  const data = portfolio.data;

  if (data.holdings.length === 0) {
    return (
      <Screen onRefresh={refresh} refreshing={refreshing}>
        <EmptyState
          title="No holdings yet"
          message="Assets you invest in appear here with their payouts and maturity."
        />
      </Screen>
    );
  }

  // Every holding carries its own currency; the totals are only meaningful if
  // they share one. They do in practice (a portfolio is priced in one
  // currency), so the first holding's currency labels the summary.
  const currency =
    data.holdings[0]?.tokenization.pricePerUnitCurrency ?? "USDC";

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <View style={styles.header}>
        <Eyebrow>Portfolio</Eyebrow>
        <Text variant="displaySm" tone={color.onDark}>
          Your holdings
        </Text>
      </View>

      <Card style={styles.summary}>
        <Label>Invested</Label>
        <Mono variant="numberDisplay" tone={color.onDark}>
          {formatMoney(data.totalInvested, currency)}
        </Mono>
        <View style={styles.summaryRows}>
          <DataRow
            label="Payouts received"
            value={formatMoney(data.totalPayoutsReceived, currency)}
            tone={color.valueUp}
          />
          <DataRow
            label="Accrued yield"
            value={formatMoney(data.totalAccruedYield, currency)}
            tone={color.valueUp}
          />
          {data.totalRealizedLoss !== "0" ? (
            <DataRow
              label="Realized loss"
              value={formatMoney(data.totalRealizedLoss, currency)}
              tone={color.valueDown}
            />
          ) : null}
          {data.overdueCount > 0 ? (
            <DataRow
              label="Overdue holdings"
              value={String(data.overdueCount)}
              tone={color.statusRejected}
            />
          ) : null}
        </View>
      </Card>

      <View style={styles.list}>
        {data.holdings.map((entry) => (
          <Card
            key={entry.holding.id}
            onPress={() => onOpen(entry.tokenization.id)}
            accessibilityLabel={`${entry.asset.description}, ${entry.holding.units} units`}
            style={styles.holding}
          >
            <View style={styles.holdingTop}>
              <Text
                variant="titleSm"
                tone={color.onDark}
                numberOfLines={2}
                style={styles.holdingTitle}
              >
                {entry.asset.description}
              </Text>
              <StatusPill status={entry.holding.status} size="sm" />
            </View>

            <View style={styles.holdingRows}>
              <DataRow label="Units" value={entry.holding.units} />
              <DataRow
                label="Invested"
                value={formatMoney(
                  entry.holding.purchaseAmount,
                  entry.holding.purchaseCurrency,
                )}
              />
              {entry.position.payoutsReceived !== "0" ? (
                <DataRow
                  label="Received"
                  value={formatMoney(
                    entry.position.payoutsReceived,
                    entry.holding.purchaseCurrency,
                  )}
                  tone={color.valueUp}
                />
              ) : null}
              {entry.position.realizedLoss !== "0" ? (
                <DataRow
                  label="Loss"
                  value={formatMoney(
                    entry.position.realizedLoss,
                    entry.holding.purchaseCurrency,
                  )}
                  tone={color.valueDown}
                />
              ) : null}
              <DataRow
                label={entry.position.overdue ? "Days overdue" : "Days left"}
                value={String(Math.abs(entry.position.daysRemaining))}
                tone={
                  entry.position.overdue ? color.statusRejected : color.body
                }
              />
            </View>

            {entry.position.overdue || entry.position.disputed ? (
              <View style={styles.flags}>
                {entry.position.overdue ? (
                  <Flag label="Past maturity" tone={color.statusRejected} />
                ) : null}
                {entry.position.disputed ? (
                  <Flag label="Disputed" tone={color.statusDisputed} />
                ) : null}
              </View>
            ) : null}
          </Card>
        ))}
      </View>
    </Screen>
  );
}

function Flag({ label, tone }: { label: string; tone: string }) {
  return (
    <View style={[styles.flag, { backgroundColor: `${tone}1a` }]}>
      <Text variant="caption" tone={tone}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { gap: space.xxs, paddingTop: space.md, paddingBottom: space.sm },
  summary: { gap: space.xxs, marginBottom: space.md },
  summaryRows: { marginTop: space.xs },
  list: { gap: space.sm },
  holding: { gap: space.xs },
  holdingTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: space.xs,
  },
  holdingTitle: { flex: 1 },
  holdingRows: { marginTop: space.xxs },
  flags: { flexDirection: "row", gap: space.xs },
  flag: {
    paddingHorizontal: space.xs,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
});
