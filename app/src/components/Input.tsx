/**
 * Text and amount inputs.
 *
 * `fontSize: 16` is not a style choice — iOS Safari and some Android IMEs zoom
 * the viewport when a focused field is smaller, which throws the user out of
 * the form mid-entry. The web client pins the same floor for the same reason.
 */
import { useState } from "react";
import {
  StyleSheet,
  TextInput,
  View,
  type TextInputProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { color, font, MIN_TOUCH, radius, space } from "../theme";
import { Label, Text } from "./Text";

export interface InputProps extends Omit<TextInputProps, "style"> {
  label?: string;
  /** Shown under the field in red; also marks the field as invalid. */
  error?: string | null;
  hint?: string;
  /** Money and addresses render in IBM Plex Mono. */
  mono?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  /** Rendered inside the field on the right (a currency chip, a paste button). */
  accessory?: React.ReactNode;
}

export function Input({
  label,
  error,
  hint,
  mono = false,
  containerStyle,
  accessory,
  ...rest
}: InputProps) {
  const [focused, setFocused] = useState(false);

  return (
    <View style={[styles.wrapper, containerStyle]}>
      {label ? <Label style={styles.label}>{label}</Label> : null}
      <View
        style={[
          styles.field,
          focused && styles.focused,
          Boolean(error) && styles.invalid,
        ]}
      >
        <TextInput
          {...rest}
          onFocus={(event) => {
            setFocused(true);
            rest.onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            rest.onBlur?.(event);
          }}
          accessibilityLabel={rest.accessibilityLabel ?? label}
          accessibilityState={{ disabled: rest.editable === false }}
          placeholderTextColor={color.muted}
          selectionColor={color.primary}
          style={[styles.input, mono && styles.mono]}
        />
        {accessory}
      </View>
      {error ? (
        <Text variant="bodySm" tone={color.statusRejected} style={styles.help}>
          {error}
        </Text>
      ) : hint ? (
        <Text variant="bodySm" tone={color.muted} style={styles.help}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: space.xxs },
  label: { marginBottom: 2 },
  field: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: MIN_TOUCH,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.hairlineDark,
    backgroundColor: color.canvasDark,
    paddingHorizontal: space.sm,
    gap: space.xs,
  },
  focused: { borderColor: color.info },
  invalid: { borderColor: color.statusRejected },
  input: {
    flex: 1,
    color: color.body,
    fontFamily: font.sans,
    // See the file header: never below 16.
    fontSize: 16,
    paddingVertical: space.xs,
  },
  mono: { fontFamily: font.mono },
  help: { marginTop: 2 },
});
