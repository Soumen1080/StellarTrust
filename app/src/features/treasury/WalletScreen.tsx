/**
 * Wallet: balances, deposits and withdrawals.
 *
 * Two distinct balances live here and conflating them would mislead:
 *
 *  - The **platform balance** is what the ledger says the user can spend
 *    inside StellarTrust — the number escrow and settlement draw on.
 *  - The **on-chain balance** is what their Stellar account holds. Money there
 *    is theirs but is not yet usable here; it becomes spendable by depositing.
 *
 * The screen shows the platform balance as the headline because that is what
 * the rest of the app spends, and offers the chain balance as context.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";
import { api } from "../../api/client";
import { useAccessToken, useAuth } from "../../auth/AuthProvider";
import { Button } from "../../components/Button";
import { Card, DataRow, Divider } from "../../components/Card";
import { Screen } from "../../components/Screen";
import { StatusPill } from "../../components/StatusPill";
import { Eyebrow, Label, Mono, Text } from "../../components/Text";
import { ErrorState, SkeletonList } from "../../components/States";
import { formatAmount, formatMoney, timeAgo } from "../../lib/money";
import { queryKeys } from "../../lib/query";
import { color, radius, space } from "../../theme";

export function WalletScreen({
  onDeposit,
  onWithdraw,
}: {
  onDeposit: () => void;
  onWithdraw: () => void;
}) {
  const accessToken = useAccessToken();
  const { isVerified } = useAuth();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const balances = useQuery({
    queryKey: queryKeys.treasuryBalances(),
    queryFn: () => api.treasuryBalances(accessToken),
  });

  const movements = useQuery({
    queryKey: queryKeys.treasuryMovements(),
    queryFn: () => api.treasuryMovements(accessToken),
  });

  const chain = useQuery({
    queryKey: queryKeys.walletBalances(),
    queryFn: () => api.getWalletBalances(accessToken),
    // Horizon is a third party; a failure here must not blank the screen.
    retry: false,
  });

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.treasuryBalances() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.treasuryMovements() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.walletBalances() }),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [queryClient]);

  if (balances.isError) {
    return (
      <Screen>
        <ErrorState error={balances.error} onRetry={() => void refresh()} />
      </Screen>
    );
  }

  const platformBalances = balances.data?.balances ?? [];
  const spendable = platformBalances.filter((entry) => entry.balance !== "0");
  const history = movements.data?.movements ?? [];

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <View style={styles.header}>
        <Eyebrow>Wallet</Eyebrow>
        <Text variant="displaySm" tone={color.onDark}>
          Your balance
        </Text>
      </View>

      {balances.isLoading ? (
        <SkeletonList count={2} />
      ) : (
        <Card style={styles.balanceCard}>
          <Label>Available to spend</Label>
          {spendable.length === 0 ? (
            <>
              <Mono variant="numberDisplay" tone={color.onDark}>
                0.00
              </Mono>
              <Text variant="bodySm" tone={color.muted}>
                Deposit to start using escrow and transfers.
              </Text>
            </>
          ) : (
            spendable.map((entry, index) => (
              <View key={entry.currency}>
                {index > 0 ? <Divider /> : null}
                <View style={styles.balanceRow}>
                  <Mono
                    variant={index === 0 ? "numberDisplay" : "numberLg"}
                    tone={color.onDark}
                  >
                    {formatAmount(entry.balance, entry.currency)}
                  </Mono>
                  <Text variant="titleMd" tone={color.mutedStrong}>
                    {entry.currency}
                  </Text>
                </View>
              </View>
            ))
          )}

          <View style={styles.actions}>
            <Button
              label="Deposit"
              onPress={onDeposit}
              style={styles.action}
            />
            <Button
              label="Withdraw"
              onPress={onWithdraw}
              variant="secondary"
              disabled={!isVerified || spendable.length === 0}
              accessibilityHint={
                isVerified ? undefined : "Verify your identity first"
              }
              style={styles.action}
            />
          </View>
        </Card>
      )}

      {chain.data && chain.data.balances.length > 0 ? (
        <Card>
          <Label>In your Stellar wallet</Label>
          <Text variant="bodySm" tone={color.muted} style={styles.blurb}>
            Held by your own account. Deposit it to spend it here.
          </Text>
          <View style={styles.rows}>
            {chain.data.balances.map((entry) => (
              <DataRow
                key={entry.currency}
                label={entry.currency}
                value={entry.balance}
              />
            ))}
          </View>
        </Card>
      ) : null}

      <View style={styles.section}>
        <Text variant="titleMd" tone={color.onDark}>
          Activity
        </Text>

        {movements.isLoading ? (
          <SkeletonList count={3} />
        ) : history.length === 0 ? (
          <Card>
            <Text variant="bodySm" tone={color.muted}>
              No deposits or withdrawals yet.
            </Text>
          </Card>
        ) : (
          <Card>
            {history.map((movement, index) => (
              <View key={movement.id}>
                {index > 0 ? <Divider /> : null}
                <View style={styles.movementRow}>
                  <View style={styles.movementMain}>
                    <Text variant="titleSm" tone={color.onDark}>
                      {movement.direction === "deposit" ? "Deposit" : "Withdrawal"}
                    </Text>
                    <Text variant="bodySm" tone={color.muted}>
                      {timeAgo(movement.createdAt)}
                    </Text>
                    {movement.failureReason ? (
                      <Text variant="bodySm" tone={color.statusRejected}>
                        {movement.failureReason}
                      </Text>
                    ) : null}
                  </View>
                  <View style={styles.movementRight}>
                    <Mono
                      variant="numberSm"
                      tone={
                        movement.direction === "deposit"
                          ? color.valueUp
                          : color.body
                      }
                    >
                      {movement.direction === "deposit" ? "+" : "−"}
                      {formatMoney(movement.amount, movement.currency)}
                    </Mono>
                    <StatusPill status={movement.status} size="sm" />
                  </View>
                </View>
              </View>
            ))}
          </Card>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: space.xxs, paddingTop: space.md, paddingBottom: space.sm },
  balanceCard: { gap: space.xs, marginBottom: space.md },
  balanceRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: space.xs,
    paddingVertical: space.xxs,
  },
  actions: { flexDirection: "row", gap: space.xs, marginTop: space.xs },
  action: { flex: 1 },
  blurb: { marginTop: 2 },
  rows: { marginTop: space.xs },
  section: { marginTop: space.lg, gap: space.xs },
  movementRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingVertical: space.xs,
    gap: space.sm,
  },
  movementMain: { flex: 1, gap: 2 },
  movementRight: { alignItems: "flex-end", gap: space.xxs },
});
