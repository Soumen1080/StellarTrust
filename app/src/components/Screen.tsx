/**
 * Screen shell.
 *
 * Owns the three things every screen would otherwise re-solve: safe-area
 * insets (notch, home indicator), keyboard avoidance for forms, and pull-to-
 * refresh wired to the screen's own query.
 */
import {
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { color, space } from "../theme";

export interface ScreenProps {
  children: React.ReactNode;
  /** Wrap in a ScrollView. Off for screens with their own list. */
  scroll?: boolean;
  onRefresh?: () => void | Promise<unknown>;
  refreshing?: boolean;
  /** Remove the default horizontal gutter, for edge-to-edge lists. */
  flush?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  /** Pinned to the bottom above the safe area — a form's submit button. */
  footer?: React.ReactNode;
}

export function Screen({
  children,
  scroll = true,
  onRefresh,
  refreshing = false,
  flush = false,
  contentStyle,
  footer,
}: ScreenProps) {
  const insets = useSafeAreaInsets();

  const padding = [
    !flush && styles.gutter,
    // The tab bar already reserves its own height; this is the extra breathing
    // room so the last card is not flush against it.
    { paddingBottom: space.xl },
    contentStyle,
  ];

  const body = scroll ? (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={padding}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      showsVerticalScrollIndicator={false}
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={color.primary}
            colors={[color.primary]}
            progressBackgroundColor={color.surfaceCardDark}
          />
        ) : undefined
      }
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.flex, padding]}>{children}</View>
  );

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {body}
      {footer ? (
        <View
          style={[
            styles.footer,
            { paddingBottom: Math.max(insets.bottom, space.md) },
          ]}
        >
          {footer}
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.canvasDark },
  flex: { flex: 1 },
  gutter: { paddingHorizontal: space.md },
  footer: {
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairlineDark,
    backgroundColor: color.canvasDark,
  },
});
