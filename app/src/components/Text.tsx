/**
 * Typographic primitives.
 *
 * Every string in the app renders through one of these so the type scale in
 * `theme/tokens.ts` is the only place sizes are decided. `Money` and `Mono`
 * exist separately because money, rates, addresses and hashes are tabular
 * figures in IBM Plex Mono per DESIGN.md — columns of numbers that do not line
 * up read as sloppy in a financial product.
 */
import { Text as RNText, type TextProps as RNTextProps } from "react-native";
import { color, type as typeScale } from "../theme";

type Variant = keyof typeof typeScale;

export interface TextProps extends RNTextProps {
  variant?: Variant;
  /** Any token colour, or a raw hex for status tints. */
  tone?: string;
  center?: boolean;
}

export function Text({
  variant = "bodyMd",
  tone = color.body,
  center,
  style,
  ...rest
}: TextProps) {
  return (
    <RNText
      {...rest}
      style={[
        typeScale[variant],
        { color: tone },
        center && { textAlign: "center" },
        style,
      ]}
    />
  );
}

/**
 * A monospace value: an amount, a rate, a hash, an address.
 *
 * Defaults to `numberMd` and never wraps mid-token by default — a truncated
 * hash with an ellipsis is readable, one broken across two lines is not.
 */
export function Mono({
  variant = "numberMd",
  numberOfLines = 1,
  ...rest
}: TextProps) {
  return <Text variant={variant} numberOfLines={numberOfLines} {...rest} />;
}

/** Small uppercase field label, matching the web `.data-label`. */
export function Label({ style, ...rest }: TextProps) {
  return (
    <Text
      variant="caption"
      tone={color.muted}
      {...rest}
      style={[{ textTransform: "uppercase", letterSpacing: 0.8 }, style]}
    />
  );
}

/** Section eyebrow, matching the web `.eyebrow`. */
export function Eyebrow({ style, ...rest }: TextProps) {
  return (
    <Text
      variant="eyebrow"
      tone={color.mutedStrong}
      {...rest}
      style={[{ textTransform: "uppercase" }, style]}
    />
  );
}
