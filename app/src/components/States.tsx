/**
 * Loading, empty, and error states.
 *
 * A financial list has three failure modes a user must be able to tell apart:
 * still loading, genuinely nothing here, and we could not reach the server.
 * Collapsing the last two into one empty list is how a user concludes their
 * money has disappeared, so each gets its own treatment.
 */
import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { color, radius, space } from "../theme";
import { messageFor } from "../api/errors";
import { Button } from "./Button";
import { Text } from "./Text";

/**
 * A pulsing placeholder block.
 *
 * Animates opacity on the native driver so the pulse keeps running at 60fps
 * while JS is busy parsing the response it is standing in for.
 */
export function Skeleton({
  width,
  height = 16,
  style,
}: {
  width?: number | `${number}%`;
  height?: number;
  style?: object;
}) {
  const opacity = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.9,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.4,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [opacity]);

  return (
    <Animated.View
      accessibilityRole="progressbar"
      accessibilityLabel="Loading"
      style={[
        styles.skeleton,
        { width: width ?? "100%", height, opacity },
        style,
      ]}
    />
  );
}

/** A stand-in for a list of cards while the first page loads. */
export function SkeletonList({ count = 3 }: { count?: number }) {
  return (
    <View style={styles.list}>
      {Array.from({ length: count }, (_, index) => (
        <View key={index} style={styles.skeletonCard}>
          <Skeleton width="40%" height={12} />
          <Skeleton width="65%" height={22} />
          <Skeleton width="30%" height={12} />
        </View>
      ))}
    </View>
  );
}

export function EmptyState({
  title,
  message,
  actionLabel,
  onAction,
}: {
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.centered}>
      <Text variant="titleMd" tone={color.onDark} center>
        {title}
      </Text>
      <Text variant="bodySm" tone={color.muted} center style={styles.message}>
        {message}
      </Text>
      {actionLabel && onAction ? (
        <Button
          label={actionLabel}
          onPress={onAction}
          variant="secondary"
          fullWidth={false}
          style={styles.action}
        />
      ) : null}
    </View>
  );
}

export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  return (
    <View style={styles.centered}>
      <View style={styles.errorBadge}>
        <Text variant="titleMd" tone={color.statusRejected}>
          !
        </Text>
      </View>
      <Text variant="titleMd" tone={color.onDark} center>
        Something went wrong
      </Text>
      <Text variant="bodySm" tone={color.muted} center style={styles.message}>
        {messageFor(error)}
      </Text>
      {onRetry ? (
        <Button
          label="Try again"
          onPress={onRetry}
          variant="secondary"
          fullWidth={false}
          style={styles.action}
        />
      ) : null}
    </View>
  );
}

/** An inline banner for a failure that does not replace the whole screen. */
export function InlineError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={styles.inline}
    >
      <Text variant="bodySm" tone={color.statusRejected}>
        {messageFor(error)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  skeleton: {
    backgroundColor: color.surfaceElevatedDark,
    borderRadius: radius.md,
  },
  list: { gap: space.sm },
  skeletonCard: {
    gap: space.xs,
    padding: space.md,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: color.hairlineDark,
    backgroundColor: color.surfaceCardDark,
  },
  centered: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: space.xxl,
    paddingHorizontal: space.lg,
    gap: space.xs,
  },
  message: { maxWidth: 320 },
  action: { marginTop: space.sm },
  errorBadge: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: `${color.statusRejected}1a`,
    marginBottom: space.xxs,
  },
  inline: {
    padding: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: `${color.statusRejected}4d`,
    backgroundColor: `${color.statusRejected}1a`,
  },
});
