/**
 * Status pill.
 *
 * The RN counterpart of frontend/src/components/StatusPill.tsx, reading the
 * same status→color map so `locked` is the same violet on both clients.
 */
import { StyleSheet, View } from "react-native";
import { radius, space, statusLabel, statusStyle } from "../theme";
import { Text } from "./Text";

export function StatusPill({
  status,
  size = "md",
}: {
  status: string;
  size?: "md" | "sm";
}) {
  const { fg, bg, border } = statusStyle(status);
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={`Status: ${statusLabel(status)}`}
      style={[
        styles.pill,
        size === "sm" && styles.sm,
        { backgroundColor: bg, borderColor: border },
      ]}
    >
      <View style={[styles.dot, { backgroundColor: fg }]} />
      <Text
        variant="caption"
        tone={fg}
        numberOfLines={1}
        style={styles.label}
      >
        {statusLabel(status)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: space.xxs + 2,
    paddingHorizontal: space.xs + 2,
    paddingVertical: space.xxs + 1,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  sm: { paddingHorizontal: space.xs, paddingVertical: 2 },
  dot: { width: 6, height: 6, borderRadius: radius.pill },
  label: { textTransform: "capitalize" },
});
