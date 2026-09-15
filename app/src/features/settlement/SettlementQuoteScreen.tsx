/**
 * Send money abroad: quote, beneficiary, execute.
 *
 * A quote is a priced, expiring promise. It is fetched when the user has
 * entered enough to price, shown with its own countdown, and re-fetched rather
 * than reused once it lapses — executing against a stale quote is how a user
 * ends up with a rate they did not agree to.
 *
 * Beneficiary validation reuses `validatePayoutDestination` from the shared
 * package: the same IBAN mod-97, ABA and NUBAN checksums the server runs, so a
 * typo is caught here rather than bouncing days later at the anchor.
 */
import {
  normalizePayoutField,
  PAYOUT_COUNTRY_FLAG,
  PAYOUT_COUNTRY_LABEL,
  PayoutFieldTransform,
  railsForCurrency,
  validatePayoutDestination,
  type CorridorDTO,
  type CurrencyCode,
  type PayoutFieldName,
  type PayoutRail,
  type PayoutRailSpec,
  type SettlementQuoteDTO,
} from "@stellartrust/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { api } from "../../api/client";
import { useAccessToken } from "../../auth/AuthProvider";
import { Button } from "../../components/Button";
import { Card, DataRow, Divider } from "../../components/Card";
import { ConfirmSheet } from "../../components/ConfirmSheet";
import { Input } from "../../components/Input";
import { Screen } from "../../components/Screen";
import { Eyebrow, Label, Mono, Text } from "../../components/Text";
import { InlineError, SkeletonList } from "../../components/States";
import { useIdempotencyKey } from "../../lib/idempotency";
import { formatAmount, formatMoney, toMinorUnits } from "../../lib/money";
import { queryKeys } from "../../lib/query";
import { color, radius, space } from "../../theme";

type Step = "amount" | "beneficiary" | "review";

export function SettlementQuoteScreen({
  onExecuted,
  onCancel,
}: {
  onExecuted: (settlementId: string) => void;
  onCancel: () => void;
}) {
  const accessToken = useAccessToken();
  const queryClient = useQueryClient();
  const idempotency = useIdempotencyKey();

  const [step, setStep] = useState<Step>("amount");
  const [corridor, setCorridor] = useState<CorridorDTO | null>(null);
  const [amount, setAmount] = useState("");
  const [rail, setRail] = useState<PayoutRail | null>(null);
  const [fields, setFields] = useState<Partial<Record<PayoutFieldName, string>>>({});
  const [reference, setReference] = useState("");
  const [fieldIssues, setFieldIssues] = useState<Partial<Record<string, string>>>({});
  const [quote, setQuote] = useState<SettlementQuoteDTO | null>(null);
  const [confirming, setConfirming] = useState(false);

  const corridors = useQuery({
    queryKey: queryKeys.corridors(),
    queryFn: () => api.listCorridors(accessToken),
  });

  // Default to the first corridor so the form is usable without a choice.
  useEffect(() => {
    if (!corridor && corridors.data?.corridors.length) {
      setCorridor(corridors.data.corridors[0] ?? null);
    }
  }, [corridors.data, corridor]);

  const rails: readonly PayoutRailSpec[] = useMemo(
    () => (corridor ? railsForCurrency(corridor.destinationCurrency) : []),
    [corridor],
  );

  const railSpec = rails.find((entry) => entry.rail === rail) ?? rails[0] ?? null;

  const sourceMinor = corridor
    ? toMinorUnits(amount, corridor.sourceCurrency)
    : null;

  const getQuote = useMutation({
    mutationFn: () => {
      if (!corridor || !sourceMinor) throw new Error("Enter an amount.");
      return api.quoteSettlement(accessToken, {
        sourceCurrency: corridor.sourceCurrency,
        destinationCurrency: corridor.destinationCurrency,
        sourceAmount: sourceMinor,
        ...(railSpec ? { payoutRail: railSpec.rail } : {}),
      });
    },
    onSuccess: (result) => {
      setQuote(result);
      setStep("review");
    },
  });

  const execute = useMutation({
    mutationFn: () => {
      if (!quote || !railSpec) throw new Error("Get a quote first.");
      return api.executeSettlement(accessToken, idempotency.next(), {
        quoteId: quote.id,
        destination: {
          rail: railSpec.rail,
          fields,
          ...(reference.trim() ? { reference: reference.trim() } : {}),
        },
      });
    },
    onSuccess: async (result) => {
      idempotency.reset();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.settlements() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.treasuryBalances() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.positions() }),
      ]);
      onExecuted(result.settlement.id);
    },
  });

  function validateBeneficiary(): boolean {
    if (!railSpec) return false;
    const result = validatePayoutDestination({
      rail: railSpec.rail,
      fields,
      ...(reference.trim() ? { reference: reference.trim() } : {}),
    });
    if (result.ok) {
      setFieldIssues({});
      return true;
    }
    setFieldIssues(
      Object.fromEntries(
        result.issues.map((issue) => [issue.field, issue.message]),
      ),
    );
    return false;
  }

  if (corridors.isLoading) {
    return (
      <Screen>
        <SkeletonList count={3} />
      </Screen>
    );
  }

  return (
    <Screen
      footer={
        <View style={styles.footer}>
          <Button
            label={step === "amount" ? "Cancel" : "Back"}
            onPress={() => {
              if (step === "amount") onCancel();
              else if (step === "beneficiary") setStep("amount");
              else setStep("beneficiary");
            }}
            variant="ghost"
            fullWidth={false}
            disabled={execute.isPending}
          />
          <Button
            label={
              step === "amount"
                ? "Continue"
                : step === "beneficiary"
                  ? "Get a quote"
                  : "Send"
            }
            busy={getQuote.isPending || execute.isPending}
            disabled={
              step === "amount"
                ? !sourceMinor || sourceMinor === "0"
                : step === "beneficiary"
                  ? !railSpec
                  : !quote
            }
            haptic={step === "review"}
            onPress={() => {
              if (step === "amount") setStep("beneficiary");
              else if (step === "beneficiary") {
                if (validateBeneficiary()) getQuote.mutate();
              } else setConfirming(true);
            }}
            style={styles.footerPrimary}
          />
        </View>
      }
    >
      <View style={styles.header}>
        <Eyebrow>Cross-border transfer</Eyebrow>
        <Text variant="displaySm" tone={color.onDark}>
          {step === "amount"
            ? "How much, and where"
            : step === "beneficiary"
              ? "Who receives it"
              : "Check and send"}
        </Text>
      </View>

      {getQuote.error ? <InlineError error={getQuote.error} /> : null}
      {execute.error ? <InlineError error={execute.error} /> : null}

      {step === "amount" ? (
        <View style={styles.form}>
          <Label>Destination</Label>
          <View style={styles.corridorList}>
            {(corridors.data?.corridors ?? []).map((entry) => (
              <Card
                key={entry.id}
                onPress={() => {
                  setCorridor(entry);
                  setRail(null);
                  setFields({});
                }}
                accessibilityLabel={`${PAYOUT_COUNTRY_LABEL[entry.destinationCountry]}, ${entry.destinationCurrency}`}
                style={[
                  styles.corridor,
                  corridor?.id === entry.id && styles.corridorActive,
                ]}
              >
                <Text variant="titleSm" tone={color.onDark}>
                  {PAYOUT_COUNTRY_FLAG[entry.destinationCountry]}{" "}
                  {PAYOUT_COUNTRY_LABEL[entry.destinationCountry]}
                </Text>
                <Text variant="bodySm" tone={color.muted}>
                  {entry.sourceCurrency} → {entry.destinationCurrency} ·{" "}
                  {entry.anchorName}
                </Text>
              </Card>
            ))}
          </View>

          {corridor ? (
            <Input
              label={`You send (${corridor.sourceCurrency})`}
              value={amount}
              onChangeText={setAmount}
              placeholder="0.00"
              keyboardType="decimal-pad"
              mono
              error={
                amount.length > 0 && !sourceMinor ? "Enter a valid amount." : null
              }
            />
          ) : null}
        </View>
      ) : null}

      {step === "beneficiary" && railSpec ? (
        <View style={styles.form}>
          {rails.length > 1 ? (
            <>
              <Label>How it arrives</Label>
              <View style={styles.railList}>
                {rails.map((spec) => (
                  <Card
                    key={spec.rail}
                    onPress={() => {
                      setRail(spec.rail);
                      setFields({});
                      setFieldIssues({});
                    }}
                    style={[
                      styles.corridor,
                      railSpec.rail === spec.rail && styles.corridorActive,
                    ]}
                  >
                    <View style={styles.railHead}>
                      <Text variant="titleSm" tone={color.onDark}>
                        {spec.label}
                      </Text>
                      {spec.instant ? (
                        <View style={styles.instantChip}>
                          <Text variant="caption" tone={color.statusVerified}>
                            Instant
                          </Text>
                        </View>
                      ) : null}
                    </View>
                    <Text variant="bodySm" tone={color.muted}>
                      {spec.network} ·{" "}
                      {spec.instant
                        ? "seconds"
                        : `about ${Math.round(spec.estimatedSeconds / 3600)}h`}
                    </Text>
                  </Card>
                ))}
              </View>
            </>
          ) : null}

          {railSpec.fields.map((field) => (
            <Input
              key={field.name}
              label={field.label}
              value={fields[field.name] ?? ""}
              onChangeText={(text) =>
                // Normalized as typed, using the same transform the server
                // applies — so what the user sees is what gets validated.
                setFields((current) => ({
                  ...current,
                  [field.name]: normalizePayoutField(text, field.transform),
                }))
              }
              placeholder={field.placeholder}
              hint={field.help}
              error={fieldIssues[field.name] ?? null}
              maxLength={field.maxLength}
              keyboardType={field.inputMode === "numeric" ? "number-pad" : "default"}
              autoCapitalize={
                field.transform === PayoutFieldTransform.UpperCompact
                  ? "characters"
                  : "none"
              }
              autoCorrect={false}
              mono={
                field.inputMode === "numeric" ||
                field.transform === PayoutFieldTransform.UpperCompact
              }
            />
          ))}

          <Input
            label="Reference (optional)"
            value={reference}
            onChangeText={setReference}
            placeholder="Appears on their statement"
            maxLength={64}
          />
        </View>
      ) : null}

      {step === "review" && quote ? (
        <QuoteReview
          quote={quote}
          railSpec={railSpec}
          onExpired={() => {
            setQuote(null);
            setStep("beneficiary");
          }}
        />
      ) : null}

      <ConfirmSheet
        visible={confirming}
        title="Send this transfer"
        message={
          quote
            ? `${formatMoney(quote.netDestinationAmount.amount, quote.netDestinationAmount.currency)} will be paid out via ${railSpec?.label ?? "the selected rail"}. This cannot be reversed once it clears.`
            : ""
        }
        detail={
          quote ? formatMoney(quote.source.amount, quote.source.currency) : undefined
        }
        confirmLabel="Send"
        busy={execute.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          execute.mutate();
        }}
      />
    </Screen>
  );
}

/**
 * The priced quote, with its expiry counting down.
 *
 * The countdown is the point: a user who takes four minutes over the review
 * step must see that the rate they were shown has lapsed, rather than tapping
 * Send and getting a rejection.
 */
function QuoteReview({
  quote,
  railSpec,
  onExpired,
}: {
  quote: SettlementQuoteDTO;
  railSpec: PayoutRailSpec | null;
  onExpired: () => void;
}) {
  const [secondsLeft, setSecondsLeft] = useState(() =>
    Math.max(0, Math.round((Date.parse(quote.expiresAt) - Date.now()) / 1000)),
  );

  useEffect(() => {
    const timer = setInterval(() => {
      const remaining = Math.max(
        0,
        Math.round((Date.parse(quote.expiresAt) - Date.now()) / 1000),
      );
      setSecondsLeft(remaining);
      if (remaining === 0) onExpired();
    }, 1000);
    return () => clearInterval(timer);
  }, [quote.expiresAt, onExpired]);

  return (
    <View style={styles.form}>
      <Card style={styles.quoteCard}>
        <Label>They receive</Label>
        <View style={styles.quoteAmount}>
          <Mono variant="numberDisplay" tone={color.onDark}>
            {formatAmount(
              quote.netDestinationAmount.amount,
              quote.netDestinationAmount.currency,
            )}
          </Mono>
          <Text variant="titleMd" tone={color.mutedStrong}>
            {quote.netDestinationAmount.currency}
          </Text>
        </View>
        <View
          style={[
            styles.expiry,
            secondsLeft <= 15 && styles.expiryUrgent,
          ]}
        >
          <Text
            variant="caption"
            tone={secondsLeft <= 15 ? color.statusRejected : color.muted}
          >
            Rate held for {secondsLeft}s
          </Text>
        </View>
      </Card>

      <Card>
        <Label>Breakdown</Label>
        <View style={styles.rows}>
          <DataRow
            label="You send"
            value={formatMoney(quote.source.amount, quote.source.currency)}
          />
          <DataRow label="Rate" value={quote.route.effectiveRate} />
          <DataRow
            label="Network fee"
            value={formatMoney(quote.route.fee.amount, quote.route.fee.currency)}
          />
          <DataRow
            label="Payout fee"
            value={formatMoney(quote.payoutFee.amount, quote.payoutFee.currency)}
          />
          <Divider />
          <DataRow
            label="They receive"
            value={formatMoney(
              quote.netDestinationAmount.amount,
              quote.netDestinationAmount.currency,
            )}
          />
          <DataRow
            label="Arrives in"
            value={
              quote.totalEstimatedSeconds < 120
                ? `${quote.totalEstimatedSeconds}s`
                : `about ${Math.round(quote.totalEstimatedSeconds / 60)} min`
            }
            mono={false}
          />
          {railSpec ? (
            <DataRow label="Via" value={railSpec.label} mono={false} />
          ) : null}
        </View>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { gap: space.xxs, paddingTop: space.lg, paddingBottom: space.md },
  form: { gap: space.md },
  corridorList: { gap: space.xs },
  railList: { gap: space.xs },
  corridor: { gap: 2, borderColor: color.hairlineDark },
  corridorActive: { borderColor: color.primary },
  railHead: { flexDirection: "row", alignItems: "center", gap: space.xs },
  instantChip: {
    paddingHorizontal: space.xs,
    paddingVertical: 1,
    borderRadius: radius.pill,
    backgroundColor: `${color.statusVerified}1a`,
  },
  quoteCard: { gap: space.xs, alignItems: "flex-start" },
  quoteAmount: { flexDirection: "row", alignItems: "baseline", gap: space.xs },
  expiry: {
    paddingHorizontal: space.xs,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: color.surfaceElevatedDark,
  },
  expiryUrgent: { backgroundColor: `${color.statusRejected}1a` },
  rows: { marginTop: space.xxs },
  footer: { flexDirection: "row", alignItems: "center", gap: space.sm },
  footerPrimary: { flex: 1 },
});
