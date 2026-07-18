import type { Config } from "tailwindcss";

/**
 * Design tokens from DESIGN.md (StellarTrust design system).
 * Single accent (Signal Yellow), Inter for UI, IBM Plex Mono for money/IDs.
 */
const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
    "./src/features/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: "#fcd535",
        "primary-active": "#f0b90b",
        "primary-disabled": "#3a3a1f",
        ink: "#181a20",
        body: "#eaecef",
        muted: "#707a8a",
        "muted-strong": "#929aa5",
        "hairline-light": "#eaecef",
        "hairline-dark": "#2b3139",
        "border-strong": "#cdd1d6",
        "canvas-light": "#ffffff",
        "canvas-dark": "#0b0e11",
        "surface-card-dark": "#1e2329",
        "surface-elevated-dark": "#2b3139",
        "surface-soft-light": "#fafafa",
        "surface-strong-light": "#f5f5f5",
        "on-primary": "#181a20",
        "on-dark": "#ffffff",
        "value-up": "#0ecb81",
        "value-down": "#f6465d",
        "status-released": "#0ecb81",
        "status-refunded": "#f6465d",
        "status-disputed": "#f8a11b",
        "status-review": "#f8a11b",
        "status-locked": "#7c5cff",
        "status-verified": "#0ecb81",
        "status-rejected": "#f6465d",
        info: "#3b82f6",
      },
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: ["IBM Plex Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      borderRadius: {
        xs: "2px",
        sm: "4px",
        md: "6px",
        lg: "8px",
        xl: "12px",
        pill: "9999px",
      },
      spacing: {
        xxs: "4px",
        xs: "8px",
        sm: "12px",
        md: "16px",
        lg: "24px",
        xl: "32px",
        xxl: "48px",
        section: "80px",
      },
    },
  },
  plugins: [],
};

export default config;
