/**
 * Confirmation sheet for an irreversible action.
 *
 * Every money step that cannot be undone passes through here. It names the
 * amount and states the consequence in plain words, because "Are you sure?"
 * tells a user nothing they can act on.
 *
 * Presented as a native Modal rather than an inline overlay so the OS back
 * gesture dismisses it, and so it sits above the keyboard on a form screen.
 */
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { color, radius, space } from "../theme";
import { Button } from "./Button";
import { Label, Mono, Text } from "./Text";

export interface ConfirmSheetProps {
  visible: boolean;
  title: string;
  message: string;
  /** The amount, or other value the user should read before committing. */
  detail?: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmSheet({
  visible,
  title,
  message,
  detail,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmSheetProps) {
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      // Android's hardware back must dismiss, not leave the sheet stranded.
      onRequestClose={busy ? undefined : onCancel}
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          style={styles.backdropTouch}
          onPress={busy ? undefined : onCancel}
        />
        <View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            { paddingBottom: Math.max(insets.bottom, space.md) + space.sm },
          ]}
        >
          <View style={styles.grabber} />

          <Text variant="titleLg" tone={color.onDark}>
            {title}
          </Text>

          {detail ? (
            <View style={styles.detail}>
              <Label>Amount</Label>
              <Mono variant="numberLg" tone={color.onDark}>
                {detail}
              </Mono>
            </View>
          ) : null}

          <Text variant="bodyMd" tone={color.muted}>
            {message}
          </Text>

          <View style={styles.actions}>
            <Button
              label={confirmLabel}
              onPress={onConfirm}
              variant={destructive ? "danger" : "primary"}
              busy={busy}
              haptic
            />
            <Button
              label={cancelLabel}
              onPress={onCancel}
              variant="ghost"
              disabled={busy}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "#000000a6" },
  backdropTouch: { ...StyleSheet.absoluteFill },
  sheet: {
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    backgroundColor: color.surfaceCardDark,
    borderTopWidth: 1,
    borderColor: color.hairlineDark,
  },
  grabber: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceElevatedDark,
    marginBottom: space.xs,
  },
  detail: {
    gap: 2,
    padding: space.sm,
    borderRadius: radius.md,
    backgroundColor: color.canvasDark,
  },
  actions: { gap: space.xs, marginTop: space.xs },
});
