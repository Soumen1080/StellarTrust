/** Surface primitives: the dark panel and its rows, matching `.panel-dark`. */
import {
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { color, radius, space } from "../theme";
import { Label, Mono, Text } from "./Text";

export interface CardProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Makes the whole card a single touch target. */
  onPress?: () => void;
  accessibilityLabel?: string;
  padded?: boolean;
}

export function Card({
  children,
  style,
  onPress,
  accessibilityLabel,
  padded = true,
}: CardProps) {
  const content = (
    <View style={[styles.card, padded && styles.padded, style]}>{children}</View>
  );

  if (!onPress) return content;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => pressed && styles.pressed}
    >
      {content}
    </Pressable>
  );
}

/** A label/value pair. Values default to mono — most of them are money or ids. */
export function DataRow({
  label,
  value,
  mono = true,
  tone = color.body,
  children,
}: {
  label: string;
  value?: string;
  mono?: boolean;
  tone?: string;
  children?: React.ReactNode;
}) {
  return (
    <View style={styles.row}>
      <Label style={styles.rowLabel}>{label}</Label>
      <View style={styles.rowValue}>
        {children ??
          (mono ? (
            <Mono variant="numberSm" tone={tone} style={styles.alignEnd}>
              {value}
            </Mono>
          ) : (
            <Text variant="bodySm" tone={tone} style={styles.alignEnd}>
              {value}
            </Text>
          ))}
      </View>
    </View>
  );
}

/** Hairline divider between rows inside a card. */
export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.divider, style]} />;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.surfaceCardDark,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: color.hairlineDark,
  },
  padded: { padding: space.md },
  pressed: { opacity: 0.8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: space.xs,
    gap: space.md,
  },
  rowLabel: { flexShrink: 0 },
  // Lets a long value shrink and ellipsize rather than push the label away.
  rowValue: { flex: 1, minWidth: 0, alignItems: "flex-end" },
  alignEnd: { textAlign: "right" },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.hairlineDark,
    marginVertical: space.xs,
  },
});
