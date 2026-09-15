/**
 * Tokenized real-world assets: the marketplace.
 *
 * Each card leads with the yield and the maturity, because those are the two
 * numbers an investor decides on, and shows the risk markers — overdue,
 * disputed, frozen — on the card rather than behind a tap. An investment
 * surface that hides its risk signals until the detail screen is one that
 * sells the good ones and buries the bad.
 */
import { TokenizationStatus } from "@stellartrust/shared";
import { FlashList } from "@shopify/flash-list";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { api } from "../../api/client";
import { useAccessToken } from "../../auth/AuthProvider";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { StatusPill } from "../../components/StatusPill";
import { Label, Mono, Text } from "../../components/Text";
import {
  EmptyState,
  ErrorState,
  SkeletonList,
} from "../../components/States";
import { formatMoney } from "../../lib/money";
import { queryKeys } from "../../lib/query";
import { color, radius, space } from "../../theme";

type Tab = "market" | "portfolio";

export function MarketplaceScreen({
  onOpen,
  onOpenPortfolio,
}: {
  onOpen: (tokenizationId: string) => void;
  onOpenPortfolio: () => void;
}) {
  const accessToken = useAccessToken();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const tokenizations = useQuery({
    queryKey: queryKeys.tokenizations(),
    queryFn: () => api.listTokenizations(accessToken),
  });

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.tokenizations(),
      });
    } finally {
      setRefreshing(false);
    }
  }, [queryClient]);

  /**
   * Only what can actually be bought into, paired with its risk.
   *
   * The API carries risk in a map keyed by tokenization id rather than on each
   * row, so it is joined here — keyed, so filtering cannot pair a card with
   * another deal's risk.
   */
  const open = useMemo(() => {
    const risk = tokenizations.data?.risk ?? {};
    return (tokenizations.data?.tokenizations ?? [])
      .filter(
        (entry) =>
          entry.status === TokenizationStatus.Active && !entry.frozen,
      )
      .map((tokenization) => ({
        tokenization,
        risk: risk[tokenization.id],
      }));
  }, [tokenizations.data]);

  if (tokenizations.isError) {
    return (
      <View style={styles.root}>
        <ErrorState error={tokenizations.error} onRetry={() => void refresh()} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text variant="titleLg" tone={color.onDark}>
          Invest
        </Text>
        <Button
          label="My portfolio"
          onPress={onOpenPortfolio}
          variant="secondary"
          size="sm"
          fullWidth={false}
        />
      </View>

      {tokenizations.isLoading ? (
        <View style={styles.padded}>
          <SkeletonList count={3} />
        </View>
      ) : (
        <FlashList
          data={open}
          keyExtractor={(entry) => entry.tokenization.id}
          estimatedItemSize={150}
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
              title="Nothing open right now"
              message="Tokenized invoices and receivables appear here when an issuer opens them for funding."
            />
          }
          renderItem={({ item }) => {
            const { tokenization, risk } = item;
            const yieldPct = (tokenization.discountRateBps / 100).toFixed(2);
            // `availableUnits` is a detail-response field; on the list it is
            // the difference the DTO already carries.
            const availableUnits = (() => {
              try {
                return (
                  BigInt(tokenization.totalUnits) - BigInt(tokenization.unitsSold)
                ).toString();
              } catch {
                return "0";
              }
            })();
            return (
              <Card
                onPress={() => onOpen(tokenization.id)}
                accessibilityLabel={`Tokenized receivable, ${yieldPct} percent yield`}
                style={styles.card}
              >
                <View style={styles.cardTop}>
                  <Text
                    variant="titleSm"
                    tone={color.onDark}
                    numberOfLines={2}
                    style={styles.cardTitle}
                  >
                    {risk?.counterparty?.name ?? "Tokenized receivable"}
                  </Text>
                  <StatusPill status={tokenization.status} size="sm" />
                </View>

                <View style={styles.metrics}>
                  <Metric
                    label="Yield"
                    value={`${yieldPct}%`}
                    tone={color.valueUp}
                  />
                  <Metric
                    label="Per unit"
                    value={formatMoney(
                      tokenization.pricePerUnitAmount,
                      tokenization.pricePerUnitCurrency,
                      { compact: true },
                    )}
                  />
                  <Metric
                    label={risk?.overdue ? "Overdue" : "Matures in"}
                    value={
                      risk ? `${Math.abs(risk.daysRemaining)}d` : "—"
                    }
                    tone={risk?.overdue ? color.statusRejected : color.body}
                  />
                </View>

                <FundingBar
                  sold={tokenization.unitsSold}
                  total={tokenization.totalUnits}
                  available={availableUnits}
                />

                {risk?.overdue || risk?.disputed ? (
                  <View style={styles.flags}>
                    {risk.overdue ? (
                      <Flag label="Past maturity" tone={color.statusRejected} />
                    ) : null}
                    {risk.disputed ? (
                      <Flag label="Under dispute" tone={color.statusDisputed} />
                    ) : null}
                  </View>
                ) : null}
              </Card>
            );
          }}
        />
      )}
    </View>
  );
}

function Metric({
  label,
  value,
  tone = color.body,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <View style={styles.metric}>
      <Label>{label}</Label>
      <Mono variant="numberMd" tone={tone}>
        {value}
      </Mono>
    </View>
  );
}

/** How much of the raise is taken. */
function FundingBar({
  sold,
  total,
  available,
}: {
  sold: string;
  total: string;
  available: string;
}) {
  // Unit counts can exceed Number.MAX_SAFE_INTEGER in principle; BigInt keeps
  // the ratio honest without floating through a lossy parse.
  const pct = useMemo(() => {
    try {
      const totalUnits = BigInt(total);
      if (totalUnits === 0n) return 0;
      return Number((BigInt(sold) * 100n) / totalUnits);
    } catch {
      return 0;
    }
  }, [sold, total]);

  return (
    <View style={styles.funding}>
      <View style={styles.bar}>
        <View style={[styles.barFill, { width: `${Math.min(100, pct)}%` }]} />
      </View>
      <View style={styles.fundingMeta}>
        <Text variant="bodySm" tone={color.muted}>
          {pct}% funded
        </Text>
        <Text variant="bodySm" tone={color.muted}>
          {available} units left
        </Text>
      </View>
    </View>
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
  card: { gap: space.sm, marginBottom: space.sm },
  cardTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: space.xs,
  },
  cardTitle: { flex: 1 },
  metrics: { flexDirection: "row", gap: space.lg },
  metric: { gap: 2 },
  funding: { gap: space.xxs },
  bar: {
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceElevatedDark,
    overflow: "hidden",
  },
  barFill: { height: 4, borderRadius: radius.pill, backgroundColor: color.primary },
  fundingMeta: { flexDirection: "row", justifyContent: "space-between" },
  flags: { flexDirection: "row", gap: space.xs },
  flag: {
    paddingHorizontal: space.xs,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
});
