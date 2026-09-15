/**
 * One dispute.
 *
 * Two things govern the design. First, the evidence window closes — after it
 * does, nothing a party submits counts, so the countdown is prominent rather
 * than incidental. Second, the AI advisory is *advisory*: per DESIGN.md it is
 * always rendered as clearly-labelled guidance and never as a verdict, because
 * the decision is a human arbiter's.
 */
import {
  DisputeResolution,
  DisputeStatus,
  EvidenceKind,
  type DisputeEvidenceInput,
} from "@stellartrust/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { api } from "../../api/client";
import { useAccessToken, useAuth } from "../../auth/AuthProvider";
import { Button } from "../../components/Button";
import { Card, DataRow, Divider } from "../../components/Card";
import { Input } from "../../components/Input";
import { Screen } from "../../components/Screen";
import { StatusPill } from "../../components/StatusPill";
import { Eyebrow, Label, Mono, Text } from "../../components/Text";
import {
  ErrorState,
  InlineError,
  SkeletonList,
} from "../../components/States";
import { useIdempotencyKey } from "../../lib/idempotency";
import { formatMoney, formatTimestamp, timeAgo } from "../../lib/money";
import { queryKeys } from "../../lib/query";
import { color, radius, space } from "../../theme";

const EVIDENCE_KINDS = [
  { value: EvidenceKind.Invoice, label: "Invoice" },
  { value: EvidenceKind.Tracking, label: "Tracking" },
  { value: EvidenceKind.Courier, label: "Courier" },
  { value: EvidenceKind.Otp, label: "Delivery code" },
  { value: EvidenceKind.Image, label: "Photo" },
] as const;

export function DisputeDetailScreen({ disputeId }: { disputeId: string }) {
  const accessToken = useAccessToken();
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const idempotency = useIdempotencyKey();

  const [kind, setKind] = useState<EvidenceKind>(EvidenceKind.Invoice);
  const [reference, setReference] = useState("");
  const [description, setDescription] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const dispute = useQuery({
    queryKey: queryKeys.dispute(disputeId),
    queryFn: () => api.getDispute(accessToken, disputeId),
    refetchInterval: (query) =>
      query.state.data?.dispute.status === DisputeStatus.Resolved ? false : 15_000,
  });

  const log = useQuery({
    queryKey: queryKeys.disputeLog(disputeId),
    queryFn: () => api.getDisputeLog(accessToken, disputeId),
  });

  const record = dispute.data?.dispute;

  const submitEvidence = useMutation({
    mutationFn: () => {
      if (!record) throw new Error("Dispute not loaded.");
      // Which side this evidence argues for follows from who is submitting it.
      const supports =
        record.buyerId === profile?.user.id
          ? DisputeResolution.Refund
          : DisputeResolution.Release;
      const input: DisputeEvidenceInput = {
        kind,
        supports,
        // The arbiter and the advisory weigh evidence; a party asserting its
        // own weight would be scoring their own case, so this is fixed.
        weight: 1,
        reference: reference.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      };
      return api.submitDisputeEvidence(
        accessToken,
        disputeId,
        idempotency.next(),
        input,
      );
    },
    onSuccess: async () => {
      idempotency.reset();
      setReference("");
      setDescription("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.dispute(disputeId) }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.disputeLog(disputeId),
        }),
      ]);
    },
  });

  if (dispute.isLoading) {
    return (
      <Screen>
        <SkeletonList count={3} />
      </Screen>
    );
  }

  if (dispute.isError || !record) {
    return (
      <Screen>
        <ErrorState error={dispute.error} onRetry={() => void dispute.refetch()} />
      </Screen>
    );
  }

  const windowOpen =
    record.status !== DisputeStatus.Resolved &&
    Date.parse(record.evidenceWindowClosesAt) > Date.now();

  const isParty =
    record.buyerId === profile?.user.id || record.sellerId === profile?.user.id;

  return (
    <Screen
      onRefresh={async () => {
        setRefreshing(true);
        try {
          await Promise.all([dispute.refetch(), log.refetch()]);
        } finally {
          setRefreshing(false);
        }
      }}
      refreshing={refreshing}
    >
      <View style={styles.hero}>
        <Eyebrow>Dispute</Eyebrow>
        <Mono variant="numberDisplay" tone={color.onDark}>
          {formatMoney(record.amount.amount, record.amount.currency)}
        </Mono>
        <View style={styles.heroMeta}>
          <StatusPill status={record.status} />
          <Text variant="bodySm" tone={color.muted}>
            opened {timeAgo(record.createdAt)}
          </Text>
        </View>
      </View>

      {windowOpen ? (
        <EvidenceWindow closesAt={record.evidenceWindowClosesAt} />
      ) : null}

      <Card>
        <Label>Why it was raised</Label>
        <Text variant="bodyMd" tone={color.body} style={styles.reason}>
          {record.reason}
        </Text>
      </Card>

      {record.resolution ? (
        <Card style={styles.resolution}>
          <Label>Decision</Label>
          <Text variant="titleMd" tone={color.onDark}>
            {record.resolution.outcome === DisputeResolution.Refund
              ? "Refunded to the buyer"
              : "Released to the seller"}
          </Text>
          <Text variant="bodySm" tone={color.mutedStrong} style={styles.reason}>
            {record.resolution.reason}
          </Text>
          <Text variant="bodySm" tone={color.muted}>
            Decided by {record.resolution.decidedBy} ·{" "}
            {formatTimestamp(record.resolution.decidedAt)}
          </Text>
        </Card>
      ) : null}

      {record.advisory ? (
        <Card style={styles.advisory}>
          <View style={styles.advisoryHead}>
            <View style={styles.advisoryChip}>
              <Text variant="caption" tone={color.info}>
                AI advisory — not a decision
              </Text>
            </View>
          </View>
          <Text variant="bodyMd" tone={color.body} style={styles.reason}>
            {record.advisory.explanation}
          </Text>
          <Text variant="bodySm" tone={color.muted}>
            An arbiter reviews this alongside the evidence. It does not decide
            the outcome.
          </Text>
        </Card>
      ) : null}

      {record.evidence.length > 0 ? (
        <Card>
          <Label>Evidence on file</Label>
          <View style={styles.rows}>
            {record.evidence.map((item, index) => (
              <View key={item.id ?? index}>
                {index > 0 ? <Divider /> : null}
                <View style={styles.evidenceRow}>
                  <View style={styles.evidenceMain}>
                    <Text variant="titleSm" tone={color.onDark}>
                      {EVIDENCE_KINDS.find((k) => k.value === item.kind)?.label ??
                        item.kind}
                    </Text>
                    {item.description ? (
                      <Text variant="bodySm" tone={color.muted}>
                        {item.description}
                      </Text>
                    ) : null}
                    <Mono variant="monoMeta" tone={color.muted} numberOfLines={1}>
                      {item.reference}
                    </Mono>
                  </View>
                </View>
              </View>
            ))}
          </View>
        </Card>
      ) : null}

      {windowOpen && isParty ? (
        <Card style={styles.submitCard}>
          <Label>Add evidence</Label>
          <Text variant="bodySm" tone={color.muted} style={styles.reason}>
            Anything that shows what was or was not delivered. It is visible to
            the arbiter and the other party.
          </Text>

          {submitEvidence.error ? (
            <InlineError error={submitEvidence.error} />
          ) : null}

          <View style={styles.kinds}>
            {EVIDENCE_KINDS.map((entry) => (
              <Button
                key={entry.value}
                label={entry.label}
                onPress={() => setKind(entry.value)}
                variant={kind === entry.value ? "primary" : "secondary"}
                size="sm"
                fullWidth={false}
              />
            ))}
          </View>

          <Input
            label="Reference"
            value={reference}
            onChangeText={setReference}
            placeholder="Tracking number, invoice id, or link"
            autoCapitalize="none"
            autoCorrect={false}
            mono
          />
          <Input
            label="What it shows (optional)"
            value={description}
            onChangeText={setDescription}
            placeholder="Delivered and signed for on 3 March"
            multiline
            maxLength={500}
          />

          <Button
            label="Submit evidence"
            onPress={() => submitEvidence.mutate()}
            busy={submitEvidence.isPending}
            disabled={reference.trim().length < 3}
          />
        </Card>
      ) : null}

      {log.data?.entries?.length ? (
        <Card>
          <Label>Timeline</Label>
          <View style={styles.rows}>
            {log.data.entries.map((entry, index) => (
              <View key={entry.id}>
                {index > 0 ? <Divider /> : null}
                <View style={styles.logRow}>
                  <View style={styles.logMain}>
                    <Text variant="bodyMd" tone={color.body}>
                      {entry.summary}
                    </Text>
                    <Text variant="bodySm" tone={color.muted}>
                      {entry.actor} · {formatTimestamp(entry.at)}
                    </Text>
                  </View>
                </View>
              </View>
            ))}
          </View>
        </Card>
      ) : null}
    </Screen>
  );
}

/** Live countdown to the evidence deadline. */
function EvidenceWindow({ closesAt }: { closesAt: string }) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Date.parse(closesAt) - Date.now()),
  );

  useEffect(() => {
    // Minute resolution: the window is measured in hours, and a per-second
    // timer would wake the JS thread 3,600 times for no visible change.
    const timer = setInterval(() => {
      setRemaining(Math.max(0, Date.parse(closesAt) - Date.now()));
    }, 30_000);
    return () => clearInterval(timer);
  }, [closesAt]);

  const label = useMemo(() => {
    const hours = Math.floor(remaining / 3_600_000);
    const minutes = Math.floor((remaining % 3_600_000) / 60_000);
    if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }, [remaining]);

  const urgent = remaining < 3_600_000;

  return (
    <Card style={[styles.window, urgent && styles.windowUrgent]}>
      <Text
        variant="titleSm"
        tone={urgent ? color.statusRejected : color.statusReview}
      >
        {label} left to submit evidence
      </Text>
      <Text variant="bodySm" tone={color.mutedStrong}>
        After this, the arbiter decides on what has already been filed.
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  hero: { gap: space.xs, paddingTop: space.lg, paddingBottom: space.md },
  heroMeta: { flexDirection: "row", alignItems: "center", gap: space.sm },
  window: {
    gap: 2,
    marginBottom: space.sm,
    borderColor: `${color.statusReview}4d`,
    backgroundColor: `${color.statusReview}14`,
  },
  windowUrgent: {
    borderColor: `${color.statusRejected}4d`,
    backgroundColor: `${color.statusRejected}14`,
  },
  reason: { marginTop: space.xxs },
  resolution: {
    marginTop: space.sm,
    gap: space.xxs,
    borderColor: `${color.statusVerified}4d`,
  },
  advisory: {
    marginTop: space.sm,
    gap: space.xxs,
    backgroundColor: color.surfaceElevatedDark,
  },
  advisoryHead: { flexDirection: "row" },
  advisoryChip: {
    paddingHorizontal: space.xs,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: `${color.info}1a`,
  },
  rows: { marginTop: space.xxs },
  evidenceRow: { paddingVertical: space.xs },
  evidenceMain: { gap: 2 },
  submitCard: { marginTop: space.sm, gap: space.sm },
  kinds: { flexDirection: "row", flexWrap: "wrap", gap: space.xxs },
  logRow: { paddingVertical: space.xs },
  logMain: { gap: 2 },
});
