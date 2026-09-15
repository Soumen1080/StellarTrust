/** Presentational pieces for the verification flow. */
import { Image } from "expo-image";
import { StyleSheet, View } from "react-native";
import { Button } from "../../components/Button";
import { Text } from "../../components/Text";
import { color, radius, space } from "../../theme";
import type { PreparedCapture } from "./capture";

/** Progress dots across the verification steps. */
export function StepDots({
  total,
  active,
}: {
  total: number;
  active: number;
}) {
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 1, max: total, now: active + 1 }}
      accessibilityLabel={`Step ${active + 1} of ${total}`}
      style={styles.dots}
    >
      {Array.from({ length: total }, (_, index) => (
        <View
          key={index}
          style={[
            styles.dot,
            index === active && styles.dotActive,
            index < active && styles.dotDone,
          ]}
        />
      ))}
    </View>
  );
}

/**
 * The captured image, or a prompt to take one.
 *
 * Showing the photograph back is what lets a user judge it before committing —
 * they can see the glare or the cropped corner that would otherwise come back
 * as a rejection days later.
 */
export function CapturePreview({
  capture,
  emptyTitle,
  emptyBlurb,
  actionLabel,
  onAction,
  rounded = false,
  compact = false,
}: {
  capture: PreparedCapture | null;
  emptyTitle: string;
  emptyBlurb: string;
  actionLabel: string;
  onAction: () => void;
  rounded?: boolean;
  compact?: boolean;
}) {
  return (
    <View style={[styles.preview, compact && styles.previewCompact]}>
      <View
        style={[
          styles.frame,
          rounded && styles.frameRounded,
          compact && styles.frameCompact,
        ]}
      >
        {capture ? (
          <Image
            source={{ uri: capture.uri }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            accessibilityLabel="Your captured photo"
            // Decoded once and held; a re-decode on every re-render made the
            // review step visibly stutter on older handsets.
            cachePolicy="memory"
          />
        ) : (
          <View style={styles.empty}>
            <Text variant="titleSm" tone={color.body} center>
              {emptyTitle}
            </Text>
            {emptyBlurb ? (
              <Text
                variant="bodySm"
                tone={color.muted}
                center
                style={styles.emptyBlurb}
              >
                {emptyBlurb}
              </Text>
            ) : null}
          </View>
        )}
      </View>
      <Button
        label={actionLabel}
        onPress={onAction}
        variant={capture ? "secondary" : "primary"}
        size={compact ? "sm" : "md"}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  dots: { flexDirection: "row", gap: space.xxs, marginTop: space.xs },
  dot: {
    width: 24,
    height: 3,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceElevatedDark,
  },
  dotActive: { backgroundColor: color.primary },
  dotDone: { backgroundColor: color.statusVerified },
  preview: { gap: space.sm, paddingVertical: space.sm },
  previewCompact: { flex: 1 },
  frame: {
    // ID-1 card ratio, matching the camera overlay so what the user framed is
    // what they see back.
    aspectRatio: 1.586,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: color.hairlineDark,
    backgroundColor: color.surfaceCardDark,
    overflow: "hidden",
  },
  frameRounded: { aspectRatio: 0.78 },
  frameCompact: { borderRadius: radius.lg },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: space.md,
    gap: space.xxs,
  },
  emptyBlurb: { maxWidth: 260 },
});
