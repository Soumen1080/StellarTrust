/**
 * Icon set.
 *
 * Inline SVG paths rather than an icon font: a font ships thousands of glyphs
 * to render six, and an unloaded icon font renders as a visible tofu box in
 * the tab bar. These are stroked on `currentColor` so a single `color` prop
 * drives active and inactive states.
 */
import Svg, { Circle, Path, Rect } from "react-native-svg";

export type IconName =
  | "home"
  | "escrow"
  | "send"
  | "invest"
  | "profile"
  | "wallet"
  | "shield"
  | "chevron";

export interface IconProps {
  name: IconName;
  size?: number;
  color: string;
}

export function Icon({ name, size = 24, color }: IconProps) {
  const common = {
    stroke: color,
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    fill: "none",
  };

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === "home" ? (
        <Path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" {...common} />
      ) : null}

      {name === "escrow" ? (
        <>
          <Rect x="3" y="7" width="18" height="13" rx="2" {...common} />
          <Path d="M8 7V5a4 4 0 0 1 8 0v2" {...common} />
          <Circle cx="12" cy="13.5" r="1.6" {...common} />
        </>
      ) : null}

      {name === "send" ? (
        <>
          <Path d="M21 3 10.5 13.5" {...common} />
          <Path d="M21 3l-6.8 18-3.7-7.5L3 9.8z" {...common} />
        </>
      ) : null}

      {name === "invest" ? (
        <>
          <Path d="M4 19V5" {...common} />
          <Path d="M4 19h16" {...common} />
          <Path d="M8 15l3.5-4 3 2.5L20 7" {...common} />
        </>
      ) : null}

      {name === "profile" ? (
        <>
          <Circle cx="12" cy="8" r="3.6" {...common} />
          <Path d="M4.5 20a7.5 7.5 0 0 1 15 0" {...common} />
        </>
      ) : null}

      {name === "wallet" ? (
        <>
          <Rect x="3" y="6" width="18" height="13" rx="2" {...common} />
          <Path d="M3 10h18" {...common} />
          <Circle cx="17" cy="14.5" r="1.1" fill={color} stroke="none" />
        </>
      ) : null}

      {name === "shield" ? (
        <>
          <Path d="M12 3l7 3v5.5c0 4.3-2.9 8.1-7 9.5-4.1-1.4-7-5.2-7-9.5V6z" {...common} />
          <Path d="M9 12l2 2 4-4" {...common} />
        </>
      ) : null}

      {name === "chevron" ? <Path d="M9 5l7 7-7 7" {...common} /> : null}
    </Svg>
  );
}
