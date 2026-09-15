/**
 * Buttons.
 *
 * Three concerns beyond looking right:
 *
 *  - **A real touch target.** `minHeight: MIN_TOUCH` rather than a fixed
 *    height, so a user at a large system font size gets a taller button rather
 *    than clipped text.
 *  - **One press per action.** `busy` disables the control while its work is
 *    in flight. On a money-moving button a double tap is a second request.
 *  - **Haptics on commit.** A press that starts a transaction confirms
 *    physically before the network answers, which is what makes the app feel
 *    immediate on a slow connection.
 */
import * as Haptics from "expo-haptics";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { color, MIN_TOUCH, radius, space } from "../theme";
import { Text } from "./Text";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "md" | "sm";

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  busy?: boolean;
  /** Rendered before the label. */
  icon?: React.ReactNode;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
  /** Fires a success haptic on press. Use for commits, not navigation. */
  haptic?: boolean;
}

export function Button({
  label,
  onPress,
  variant = "primary",
  size = "md",
  disabled = false,
  busy = false,
  icon,
  fullWidth = true,
  style,
  accessibilityHint,
  haptic = false,
}: ButtonProps) {
  const inactive = disabled || busy;
  const palette = PALETTE[variant];

  function handlePress(): void {
    if (inactive) return;
    if (haptic) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onPress();
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy }}
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      disabled={inactive}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.base,
        size === "sm" && styles.sm,
        fullWidth && styles.fullWidth,
        {
          backgroundColor: inactive ? palette.disabledBg : palette.bg,
          borderColor: inactive ? palette.disabledBg : palette.border,
        },
        pressed && !inactive && styles.pressed,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={palette.fg} />
      ) : (
        <View style={styles.content}>
          {icon}
          <Text
            variant="button"
            tone={inactive ? palette.disabledFg : palette.fg}
          >
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

interface Palette {
  bg: string;
  fg: string;
  border: string;
  disabledBg: string;
  disabledFg: string;
}

const PALETTE: Record<ButtonVariant, Palette> = {
  primary: {
    bg: color.primary,
    fg: color.onPrimary,
    border: color.primary,
    disabledBg: color.primaryDisabled,
    disabledFg: color.muted,
  },
  secondary: {
    bg: color.surfaceCardDark,
    fg: color.body,
    border: color.hairlineDark,
    disabledBg: color.surfaceCardDark,
    disabledFg: color.muted,
  },
  ghost: {
    bg: color.transparent,
    fg: color.body,
    border: color.transparent,
    disabledBg: color.transparent,
    disabledFg: color.muted,
  },
  danger: {
    bg: color.statusRejected,
    fg: color.onDark,
    border: color.statusRejected,
    disabledBg: color.surfaceElevatedDark,
    disabledFg: color.muted,
  },
};

const styles = StyleSheet.create({
  base: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  sm: {
    minHeight: 36,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  fullWidth: { alignSelf: "stretch" },
  // Matches the web's `active:translate-y-px`.
  pressed: { opacity: 0.85, transform: [{ translateY: 1 }] },
  content: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
  },
});
