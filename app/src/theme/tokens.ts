/**
 * StellarTrust design tokens for React Native.
 *
 * Transcribed token-for-token from docs/DESIGN.md and
 * frontend/tailwind.config.ts so the app and the web app are the same product
 * visually. When a token changes there, change it here — these are the same
 * design system, not a mobile reinterpretation of it.
 */

export const color = {
  primary: "#fcd535",
  primaryActive: "#f0b90b",
  primaryDisabled: "#3a3a1f",

  ink: "#181a20",
  body: "#eaecef",
  muted: "#707a8a",
  mutedStrong: "#929aa5",

  hairlineLight: "#eaecef",
  hairlineDark: "#2b3139",
  borderStrong: "#cdd1d6",

  canvasLight: "#ffffff",
  canvasDark: "#0b0e11",
  surfaceCardDark: "#1e2329",
  surfaceElevatedDark: "#2b3139",
  surfaceSoftLight: "#fafafa",
  surfaceStrongLight: "#f5f5f5",

  onPrimary: "#181a20",
  onDark: "#ffffff",

  /** FX / credit-debit direction. */
  valueUp: "#0ecb81",
  valueDown: "#f6465d",

  /** Money-state set — an escrow platform has more states than an exchange. */
  statusReleased: "#0ecb81",
  statusRefunded: "#f6465d",
  statusDisputed: "#f8a11b",
  statusReview: "#f8a11b",
  statusLocked: "#7c5cff",
  statusVerified: "#0ecb81",
  statusRejected: "#f6465d",

  info: "#3b82f6",
  transparent: "transparent",
} as const;

export type ColorToken = keyof typeof color;

/** 4px base scale, matching the web spacing tokens. */
export const space = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
  section: 64,
} as const;

export const radius = {
  xs: 2,
  sm: 4,
  md: 6,
  lg: 8,
  xl: 12,
  pill: 9999,
} as const;

/**
 * Font families.
 *
 * Inter and IBM Plex Mono are bundled and registered in `src/theme/fonts.ts`.
 * Until they load, the platform default is used rather than a blank screen.
 */
export const font = {
  sans: "Inter",
  sansMedium: "Inter-Medium",
  sansSemibold: "Inter-SemiBold",
  sansBold: "Inter-Bold",
  mono: "IBMPlexMono",
  monoMedium: "IBMPlexMono-Medium",
  monoSemibold: "IBMPlexMono-SemiBold",
} as const;

/**
 * Type scale. The web `hero-display` (64px) has no mobile counterpart — it is
 * a marketing-page size that would overflow a phone — so the scale starts at
 * `displayLg` and the app's largest heading is `displaySm`.
 */
export const type = {
  displayLg: { fontFamily: font.sansBold, fontSize: 34, lineHeight: 40, letterSpacing: -0.5 },
  displayMd: { fontFamily: font.sansBold, fontSize: 28, lineHeight: 34, letterSpacing: -0.3 },
  displaySm: { fontFamily: font.sansSemibold, fontSize: 24, lineHeight: 30, letterSpacing: 0 },
  titleLg: { fontFamily: font.sansSemibold, fontSize: 20, lineHeight: 26 },
  titleMd: { fontFamily: font.sansSemibold, fontSize: 17, lineHeight: 23 },
  titleSm: { fontFamily: font.sansSemibold, fontSize: 15, lineHeight: 21 },

  numberDisplay: { fontFamily: font.monoSemibold, fontSize: 34, lineHeight: 40, letterSpacing: -0.3 },
  numberLg: { fontFamily: font.monoSemibold, fontSize: 22, lineHeight: 28 },
  numberMd: { fontFamily: font.monoMedium, fontSize: 15, lineHeight: 21 },
  numberSm: { fontFamily: font.monoMedium, fontSize: 13, lineHeight: 18 },
  monoMeta: { fontFamily: font.mono, fontSize: 12, lineHeight: 17 },

  bodyMd: { fontFamily: font.sans, fontSize: 15, lineHeight: 22 },
  bodySm: { fontFamily: font.sans, fontSize: 13, lineHeight: 19 },
  caption: { fontFamily: font.sansMedium, fontSize: 12, lineHeight: 17 },
  button: { fontFamily: font.sansSemibold, fontSize: 15, lineHeight: 18 },
  eyebrow: {
    fontFamily: font.sansSemibold,
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 1.6,
    textTransform: "uppercase",
  },
} as const;

/**
 * Minimum touch target. 44pt is the smaller of the two platform floors
 * (Apple 44pt, Material 48dp); controls use it as a `minHeight`, never as a
 * fixed height, so text is free to grow with the system font size.
 */
export const HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;
export const MIN_TOUCH = 44;

export const duration = {
  fast: 120,
  base: 200,
  slow: 320,
} as const;
