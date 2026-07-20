---
version: alpha
name: StellarTrust-design
description: A confident cross-border-finance interface adapted from Binance's design language. Anchored on a deep near-black canvas where a single signal yellow (#FCD535) carries every primary CTA, brand accent, and value-claim moment. Type runs an open Inter + IBM Plex Mono stack — Inter for editorial/UI, IBM Plex Mono (tabular) for money, rates, wallet addresses, tx hashes, and IDs. Marketing and dashboard surfaces default to the dark theme; transactional surfaces (send payment, deposit, KYC, order forms) flip to a light theme sharing the same yellow CTAs and gray-blue hairlines. Beyond Binance's up/down green/red, StellarTrust adds a small semantic status set (locked / released / refunded / disputed / review) because an escrow platform has more money states than an exchange. AI outputs are always rendered as clearly-labeled advisory, never as authoritative.

colors:
  primary: "#fcd535"
  primary-active: "#f0b90b"
  primary-disabled: "#3a3a1f"
  ink: "#181a20"
  body: "#eaecef"
  body-on-light: "#181a20"
  muted: "#707a8a"
  muted-strong: "#929aa5"
  hairline-on-light: "#eaecef"
  hairline-on-dark: "#2b3139"
  border-strong: "#cdd1d6"
  canvas-light: "#ffffff"
  canvas-dark: "#0b0e11"
  surface-card-dark: "#1e2329"
  surface-elevated-dark: "#2b3139"
  surface-soft-light: "#fafafa"
  surface-strong-light: "#f5f5f5"
  on-primary: "#181a20"
  on-dark: "#ffffff"
  # value-direction (FX rate movement, credit/debit) — reused from Binance up/down
  value-up: "#0ecb81"
  value-down: "#f6465d"
  # semantic money/status set (StellarTrust addition)
  status-released: "#0ecb81"
  status-refunded: "#f6465d"
  status-disputed: "#f8a11b"
  status-review: "#f8a11b"
  status-locked: "#7c5cff"
  status-verified: "#0ecb81"
  status-rejected: "#f6465d"
  info: "#3b82f6"
  info-ring: "#3b82f6"

typography:
  hero-display:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: 64px
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: -1px
  display-lg:
    fontFamily: "Inter, sans-serif"
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: -0.5px
  display-md:
    fontFamily: "Inter, sans-serif"
    fontSize: 40px
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: -0.3px
  display-sm:
    fontFamily: "Inter, sans-serif"
    fontSize: 32px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: 0
  title-lg:
    fontFamily: "Inter, sans-serif"
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: 0
  title-md:
    fontFamily: "Inter, sans-serif"
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: 0
  title-sm:
    fontFamily: "Inter, sans-serif"
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 0
  number-display:
    fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace"
    fontSize: 40px
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: -0.3px
  number-md:
    fontFamily: "'IBM Plex Mono', ui-monospace, monospace"
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0
  number-sm:
    fontFamily: "'IBM Plex Mono', ui-monospace, monospace"
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0
  mono-meta:
    fontFamily: "'IBM Plex Mono', ui-monospace, monospace"
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0
  body-md:
    fontFamily: "Inter, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
  body-sm:
    fontFamily: "Inter, sans-serif"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
  caption:
    fontFamily: "Inter, sans-serif"
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0
  button:
    fontFamily: "Inter, sans-serif"
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1
    letterSpacing: 0
  nav-link:
    fontFamily: "Inter, sans-serif"
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0

rounded:
  xs: 2px
  sm: 4px
  md: 6px
  lg: 8px
  xl: 12px
  pill: 9999px
  full: 9999px

spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 48px
  section: 80px

components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 12px 24px
    height: 40px
  button-primary-active:
    backgroundColor: "{colors.primary-active}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
  button-primary-disabled:
    backgroundColor: "{colors.primary-disabled}"
    textColor: "{colors.muted}"
    rounded: "{rounded.md}"
  button-primary-pill:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.pill}"
    padding: 14px 32px
  button-secondary-on-dark:
    backgroundColor: "{colors.surface-card-dark}"
    textColor: "{colors.on-dark}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 12px 24px
  button-secondary-on-light:
    backgroundColor: "{colors.canvas-light}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 12px 24px
  button-tertiary-text:
    backgroundColor: transparent
    textColor: "{colors.body}"
    typography: "{typography.button}"
  button-release:
    backgroundColor: "{colors.status-released}"
    textColor: "{colors.on-dark}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 10px 22px
  button-refund:
    backgroundColor: "{colors.status-refunded}"
    textColor: "{colors.on-dark}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 10px 22px
  button-invest:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    padding: 6px 16px
    height: 28px
  text-link:
    backgroundColor: transparent
    textColor: "{colors.primary}"
    typography: "{typography.body-md}"
  top-nav-dark:
    backgroundColor: "{colors.canvas-dark}"
    textColor: "{colors.on-dark}"
    typography: "{typography.nav-link}"
    height: 64px
  top-nav-light:
    backgroundColor: "{colors.canvas-light}"
    textColor: "{colors.ink}"
    typography: "{typography.nav-link}"
    height: 64px
  hero-band-dark:
    backgroundColor: "{colors.canvas-dark}"
    textColor: "{colors.on-dark}"
    typography: "{typography.hero-display}"
    padding: 80px
  stat-callout-card:
    backgroundColor: transparent
    textColor: "{colors.primary}"
    typography: "{typography.number-display}"
  trust-badge:
    backgroundColor: "{colors.surface-card-dark}"
    textColor: "{colors.on-dark}"
    typography: "{typography.title-sm}"
    rounded: "{rounded.lg}"
    padding: 16px 20px
  status-pill:
    backgroundColor: transparent
    textColor: "{colors.on-dark}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    padding: 4px 12px
  escrow-status-card:
    backgroundColor: "{colors.surface-card-dark}"
    textColor: "{colors.on-dark}"
    typography: "{typography.body-md}"
    rounded: "{rounded.xl}"
    padding: 24px
  order-card:
    backgroundColor: "{colors.surface-card-dark}"
    textColor: "{colors.on-dark}"
    typography: "{typography.body-md}"
    rounded: "{rounded.xl}"
    padding: 24px
  corridor-rates-card:
    backgroundColor: "{colors.surface-card-dark}"
    textColor: "{colors.on-dark}"
    typography: "{typography.body-md}"
    rounded: "{rounded.xl}"
    padding: 24px
  corridor-row:
    backgroundColor: transparent
    textColor: "{colors.on-dark}"
    typography: "{typography.number-md}"
    padding: 12px 0
  rate-up-cell:
    backgroundColor: transparent
    textColor: "{colors.value-up}"
    typography: "{typography.number-md}"
  rate-down-cell:
    backgroundColor: transparent
    textColor: "{colors.value-down}"
    typography: "{typography.number-md}"
  ledger-table-card:
    backgroundColor: "{colors.surface-card-dark}"
    textColor: "{colors.on-dark}"
    typography: "{typography.number-md}"
    rounded: "{rounded.xl}"
    padding: 24px
  ledger-credit-cell:
    backgroundColor: transparent
    textColor: "{colors.value-up}"
    typography: "{typography.number-md}"
  ledger-debit-cell:
    backgroundColor: transparent
    textColor: "{colors.value-down}"
    typography: "{typography.number-md}"
  dispute-panel-card:
    backgroundColor: "{colors.surface-card-dark}"
    textColor: "{colors.on-dark}"
    typography: "{typography.body-md}"
    rounded: "{rounded.xl}"
    padding: 24px
  ai-recommendation-card:
    backgroundColor: "{colors.surface-elevated-dark}"
    textColor: "{colors.on-dark}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: 20px
  kyc-status-banner:
    backgroundColor: "{colors.surface-card-dark}"
    textColor: "{colors.on-dark}"
    typography: "{typography.title-sm}"
    rounded: "{rounded.lg}"
    padding: 16px 20px
  rwa-token-card:
    backgroundColor: "{colors.surface-card-dark}"
    textColor: "{colors.on-dark}"
    typography: "{typography.body-md}"
    rounded: "{rounded.xl}"
    padding: 24px
  investor-row:
    backgroundColor: transparent
    textColor: "{colors.on-dark}"
    typography: "{typography.body-md}"
    padding: 12px 0
  search-input-on-dark:
    backgroundColor: "{colors.surface-card-dark}"
    textColor: "{colors.on-dark}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: 10px 16px
    height: 40px
  text-input-on-light:
    backgroundColor: "{colors.canvas-light}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: 10px 16px
    height: 40px
  escrow-protected-band:
    backgroundColor: "{colors.canvas-dark}"
    textColor: "{colors.primary}"
    typography: "{typography.display-lg}"
    padding: 80px
  feature-photo-card:
    backgroundColor: "{colors.surface-card-dark}"
    textColor: "{colors.on-dark}"
    rounded: "{rounded.xl}"
  qr-promo-card:
    backgroundColor: "{colors.surface-card-dark}"
    textColor: "{colors.on-dark}"
    typography: "{typography.title-md}"
    rounded: "{rounded.xl}"
    padding: 32px
  faq-row:
    backgroundColor: transparent
    textColor: "{colors.on-dark}"
    typography: "{typography.title-sm}"
    rounded: "{rounded.md}"
    padding: 20px 0
  cta-band-dark:
    backgroundColor: "{colors.surface-card-dark}"
    textColor: "{colors.on-dark}"
    typography: "{typography.display-sm}"
    rounded: "{rounded.xl}"
    padding: 48px
  hero-gradient-band:
    backgroundColor: "{colors.canvas-dark}"
    textColor: "{colors.primary}"
    typography: "{typography.display-lg}"
    padding: 80px
  cookie-consent-card:
    backgroundColor: "{colors.canvas-light}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.lg}"
    padding: 16px
  send-payment-amount-card:
    backgroundColor: "{colors.canvas-light}"
    textColor: "{colors.ink}"
    typography: "{typography.number-display}"
    rounded: "{rounded.lg}"
    padding: 24px
  steps-card:
    backgroundColor: "{colors.canvas-light}"
    textColor: "{colors.ink}"
    typography: "{typography.title-sm}"
    rounded: "{rounded.lg}"
    padding: 24px
  fx-rate-chart-card:
    backgroundColor: "{colors.canvas-light}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: 24px
  conversion-cell:
    backgroundColor: transparent
    textColor: "{colors.body-on-light}"
    typography: "{typography.number-md}"
  footer-light:
    backgroundColor: "{colors.surface-soft-light}"
    textColor: "{colors.body-on-light}"
    typography: "{typography.body-md}"
    padding: 64px
---

## Overview

StellarTrust borrows Binance's visual DNA and re-points it at cross-border
escrow, settlement, and RWA tokenization. The base atmosphere is a **deep
near-black canvas** (`{colors.canvas-dark}` — #0b0e11) holding white type and a
single ubiquitous accent: **Signal Yellow** (`{colors.primary}` — #FCD535). That
yellow does the brand's heavy lifting — every primary CTA, every value-claim
headline ("$429M SETTLED. ZERO CHARGEBACKS."), every "Get Started" pill, and the
wordmark itself. There is no secondary brand color.

Type runs an **open, licensable stack**: **Inter** for display, UI, and body,
and **IBM Plex Mono** (tabular) for money, FX rates, wallet addresses, tx
hashes, and IDs. This is a functional split identical in spirit to Binance's
BinanceNova/BinancePlex — copy in Inter, numbers in the mono voice — but uses
fonts we can actually ship. Big stat numbers and every monetary value render in
IBM Plex Mono so digits align in dense financial tables.

The product is **multi-theme**: marketing + dashboard surfaces (home, escrow
dashboard, disputes, RWA marketplace) default to dark; transactional surfaces
(send payment, deposit/withdraw, KYC forms, order confirmation) flip to a light
theme. The same yellow CTAs and gray-blue hairlines
(`{colors.hairline-on-light}` — #eaecef) thread through both — only canvas,
surface, and text tones flip.

Where StellarTrust departs from Binance: an exchange only needs price up/down,
but an escrow platform has **money states**. So beyond value-direction
green/red (`{colors.value-up}` / `{colors.value-down}`), we add a small semantic
status set (`{colors.status-locked}` violet, `{colors.status-disputed}` amber,
plus released/refunded/verified/rejected) surfaced through the
`{component.status-pill}`. And because AI drives dispute recommendations, every
AI output is rendered as **clearly-labeled advisory** — never as an authoritative
verdict.

**Key Characteristics:**
- Single accent color: `{colors.primary}` (#FCD535) does all brand voltage —
  primary CTAs, hero headlines, brand mark, badges. Scarce on dark for emphasis,
  ubiquitous on transactional dialogs.
- Open type stack: `Inter` (display + body + UI) and `IBM Plex Mono` (money,
  rates, addresses, hashes, IDs). Every number renders in IBM Plex Mono for
  tabular consistency.
- Multi-theme: marketing/dashboard default dark (`{colors.canvas-dark}`);
  transactional pages flip light (`{colors.canvas-light}`). Yellow CTAs and
  value green/red are shared across both.
- Value semantics: green up / red down (`{colors.value-up}` /
  `{colors.value-down}`) for FX rate movement and ledger credit/debit, applied
  as text color rather than button/card background.
- Money-state semantics (StellarTrust addition): `{component.status-pill}`
  encodes Locked / Released / Refunded / Disputed / Review / Verified / Rejected
  with a fixed color mapping — never color alone; always icon + label + color.
- AI is advisory: `{component.ai-recommendation-card}` always carries an
  "Advisory" tag, a confidence value, and an explanation — never a bare verdict.
- Card surfaces: `{colors.surface-card-dark}` (#1e2329) on dark;
  `{colors.canvas-light}` on light. Flat color blocks, no gradient surfaces,
  no glassmorphism.
- Border radius small→medium: `{rounded.md}` (6px) buttons, `{rounded.lg}` (8px)
  inputs/cards, `{rounded.xl}` (12px) elevated containers, `{rounded.pill}` for
  top-of-page actions.
- Spacing on a 4-multiple scale; major bands at `{spacing.section}` (80px).

## Phase 2 implementation note

The `/escrow` dashboard now implements `{component.order-card}` and
`{component.escrow-status-card}` behavior for create, accept, deposit, lock,
confirm, and release. Every state uses the icon+label+color status pill, money
and IDs use the mono type role, and blocked reconciliation is shown as an amber
operational warning. The create-order form uses the light transactional surface
while order progress remains on the dark dashboard surface.

## Colors

### Brand & Accent
- **Signal Yellow** (`{colors.primary}` — #FCD535): The single brand color.
  Primary CTA backgrounds, wordmark, brand-claim headlines, trust badges, large
  stat numbers in `{component.stat-callout-card}`, inline links.
- **Signal Yellow Active** (`{colors.primary-active}` — #f0b90b): Press/hover
  darker variant.
- **Signal Yellow Disabled** (`{colors.primary-disabled}` — #3a3a1f):
  Desaturated dark-yellow for disabled CTAs over dark canvas.

### Surface

Two canvas modes mapped to product context:

**Dark mode (marketing + dashboard default):**
- **Canvas Dark** (`{colors.canvas-dark}` — #0b0e11): Primary page floor.
  Near-black with a slight warm tint — never pure black.
- **Surface Card Dark** (`{colors.surface-card-dark}` — #1e2329): Cards, nav
  dropdowns, secondary buttons, tables (escrow, ledger, corridors, RWA).
- **Surface Elevated Dark** (`{colors.surface-elevated-dark}` — #2b3139): One
  step lighter — nested cards, the AI recommendation card, hovered nav items,
  chart panels.

**Light mode (transactional):**
- **Canvas Light** (`{colors.canvas-light}` — #ffffff): Send-payment, deposit,
  KYC, and order-confirmation pages.
- **Surface Soft Light** (`{colors.surface-soft-light}` — #fafafa): Footer and
  disabled states.
- **Surface Strong Light** (`{colors.surface-strong-light}` — #f5f5f5): Muted
  form input backgrounds.

### Hairlines & Borders
- **Hairline on Light** (`{colors.hairline-on-light}` — #eaecef): 1px border on
  light surfaces — used liberally as table/row dividers.
- **Hairline on Dark** (`{colors.hairline-on-dark}` — #2b3139): 1px border on
  dark surfaces. Same hex as `{colors.surface-elevated-dark}` — borders read as
  surface steps, not ink lines.
- **Border Strong** (`{colors.border-strong}` — #cdd1d6): Heavier border for
  disabled secondary buttons.

### Text
- **Ink** (`{colors.ink}` — #181a20): Strongest text on light surfaces.
- **Body on Dark** (`{colors.body}` — #eaecef): Default running-text on dark,
  slightly cooler than pure white.
- **Body on Light** (`{colors.body-on-light}` — #181a20): Reuses ink.
- **Muted** (`{colors.muted}` — #707a8a): Footer links, captions, table column
  headers. Works on both canvases.
- **Muted Strong** (`{colors.muted-strong}` — #929aa5): Emphasized labels.
- **On Primary** (`{colors.on-primary}` — #181a20): Black text on yellow CTAs.
- **On Dark** (`{colors.on-dark}` — #ffffff): High-contrast headlines on dark.

### Value Direction (FX & ledger)
- **Value Up** (`{colors.value-up}` — #0ecb81): Favorable rate movement, ledger
  **credit**, positive deltas. Text color in tables/charts — never a card fill.
- **Value Down** (`{colors.value-down}` — #f6465d): Unfavorable rate movement,
  ledger **debit**, negative deltas. Same usage rules.

### Money-State Semantics (StellarTrust addition)
Surfaced through `{component.status-pill}`, `{component.escrow-status-card}`, and
KYC banners. Fixed mapping — always icon + label + color, never color alone:

| State | Token | Hex |
|---|---|---|
| Escrow Locked / In settlement | `{colors.status-locked}` | #7c5cff (violet) |
| Released / Settled | `{colors.status-released}` | #0ecb81 (green) |
| Refunded | `{colors.status-refunded}` | #f6465d (red) |
| Disputed | `{colors.status-disputed}` | #f8a11b (amber) |
| Under Review (KYC / manual) | `{colors.status-review}` | #f8a11b (amber) |
| Verified / Approved (KYC) | `{colors.status-verified}` | #0ecb81 (green) |
| Rejected (KYC) | `{colors.status-rejected}` | #f6465d (red) |

> **Caution:** amber `{colors.status-disputed}` (#f8a11b) is intentionally more
> orange than brand `{colors.primary}` (#FCD535) so a "disputed/review" state is
> never confused with a brand accent or CTA. Do not use brand yellow to signal
> status.

### Info / Focus
- **Info** (`{colors.info}` — #3b82f6): Inline info badges and the focus-ring
  base. Used on input focus.

## Typography

### Font Family
- **Inter** → editorial + UI: headlines, paragraphs, button labels, nav, status
  labels. Fallback: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
  sans-serif`.
- **IBM Plex Mono** → tabular numeric/technical: monetary amounts, FX rates,
  percentages, stat counters, wallet public keys, transaction hashes, order/
  escrow IDs. Fallback: `ui-monospace, SFMono-Regular, monospace`.

The split is not optional: money and identifiers render in IBM Plex Mono so
digits and hashes align and read as "tabular and reliable"; copy renders in
Inter. (This mirrors Binance's BinanceNova/BinancePlex division using
open-source fonts we can license and ship.)

### Hierarchy

| Token | Size | Weight | Line Height | Letter Spacing | Use |
|---|---|---|---|---|---|
| `{typography.hero-display}` | 64px | 700 | 1.1 | -1px | Homepage h1 |
| `{typography.display-lg}` | 48px | 700 | 1.1 | -0.5px | Brand-claim headlines, escrow-protected band |
| `{typography.display-md}` | 40px | 600 | 1.15 | -0.3px | Section heads |
| `{typography.display-sm}` | 32px | 600 | 1.2 | 0 | CTA band headlines |
| `{typography.title-lg}` | 24px | 600 | 1.3 | 0 | Sub-section titles |
| `{typography.title-md}` | 20px | 600 | 1.35 | 0 | QR-promo, feature card titles |
| `{typography.title-sm}` | 16px | 600 | 1.4 | 0 | Trust/KYC badges, FAQ rows, step labels |
| `{typography.number-display}` | 40px | 600 | 1.1 | -0.3px | Big money/stat numbers — IBM Plex Mono |
| `{typography.number-md}` | 16px | 500 | 1.4 | 0 | Table amounts, rates, ledger cells — mono |
| `{typography.number-sm}` | 14px | 500 | 1.4 | 0 | Inline amounts, % deltas — mono |
| `{typography.mono-meta}` | 12px | 500 | 1.4 | 0 | Wallet addresses, tx hashes, IDs — mono |
| `{typography.body-md}` | 14px | 400 | 1.5 | 0 | Default running-text — Inter |
| `{typography.body-sm}` | 13px | 400 | 1.5 | 0 | Cookie/footer body — Inter |
| `{typography.caption}` | 12px | 500 | 1.4 | 0 | Status-pill labels, small meta |
| `{typography.button}` | 14px | 600 | 1 | 0 | CTA button labels |
| `{typography.nav-link}` | 14px | 500 | 1.4 | 0 | Top nav items |

### Principles
Display sizes use weight 700 — heavier than typical marketing systems, because a
finance platform's numbers and headlines must read at a glance against dense
tables. Do not soften display weight to 400.

`{typography.number-display}` and every numeric/mono variant always use **IBM
Plex Mono**, even when surrounding copy is Inter. Money, rates, addresses,
hashes, and IDs render in the mono voice regardless of context.

### Note on Fonts
Inter and IBM Plex Mono are both open-source (SIL OFL) and free to ship — no
licensing constraint (unlike Binance's proprietary BinanceNova/BinancePlex).
Self-host the woff2 files; do not rely on a CDN for a financial product.

## Layout

### Spacing System
- **Base unit:** 4px.
- **Tokens:** `{spacing.xxs}` 4px · `{spacing.xs}` 8px · `{spacing.sm}` 12px ·
  `{spacing.md}` 16px · `{spacing.lg}` 24px · `{spacing.xl}` 32px ·
  `{spacing.xxl}` 48px · `{spacing.section}` 80px.
- **Section padding (vertical):** `{spacing.section}` (80px) — dashboards mix
  marketing bands with dense tables (escrow, ledger, corridors), so 80px keeps
  a consistent rhythm without excess air.
- **Card internal padding:** `{spacing.lg}` (24px) for content cards and tables;
  `{spacing.xl}` (32px) for QR-promo cards; `{spacing.md}` (16px) for badges and
  table rows.
- **Gutters:** `{spacing.lg}` (24px) between cards in 3-up grids; `{spacing.md}`
  (16px) inside footer columns and dense lists.

### Grid & Container
- **Max content width:** ~1280px on marketing pages; ~1440px on dashboard
  surfaces (escrow, ledger, corridors) where horizontal density matters.
- **Editorial body:** 12-column grid; dashboards use an 8/4 split (main panel +
  side rail, e.g., escrow detail + activity timeline).
- **Corridor rates table:** 5-column header (Corridor / Rate / 24h Change /
  Est. Fee / Action), first column carries the currency-pair flags/codes.
- **Ledger table:** columns for Date / Description / Debit / Credit / Balance —
  Debit/Credit right-aligned in IBM Plex Mono.
- **Footer:** 6-column link list at desktop, wrapping to 2-up at tablet, 1-up
  mobile.

### Whitespace Philosophy
Denser than airy marketing sites — dashboards mix hero bands with tables and FAQ
accordions. The system trusts contrast (yellow vs. dark canvas, green vs. red
value cells, status-pill hues) to separate content, not whitespace. Where
whitespace appears it is uniform — `{spacing.section}` between major bands.

## Elevation & Depth

| Level | Treatment | Use |
|---|---|---|
| Flat | No shadow, no border | Body sections, top nav, hero bands, footer |
| Soft hairline | 1px `{colors.hairline-on-dark}` / `{colors.hairline-on-light}` | Inputs, table dividers, FAQ separators, secondary buttons |
| Card surface | `{colors.surface-card-dark}` on dark / `{colors.canvas-light}` on light — no shadow | Escrow/order/RWA/ledger/corridor cards, badges |
| Elevated surface | `{colors.surface-elevated-dark}` | AI recommendation card, nested panels, chart panels |
| Subtle drop shadow | Faint shadow only over imagery | `{component.send-payment-amount-card}` on transactional pages |
| Focus ring | `0 0 0 2px {colors.info-ring}` at 50% alpha | Input + button keyboard focus |

Elevation philosophy is **flat surfaces with color-block separation**. No heavy
drop shadows, no glassmorphism. Depth comes from the lightness jump between
`{colors.canvas-dark}` and `{colors.surface-card-dark}`.

### Decorative Depth
- **Yellow → dark vertical gradient** reserved for `{component.hero-gradient-band}`
  on product-launch / campaign heroes only — not a system-wide signature.
- Illustrations (globe/route/coin motifs for cross-border flow) are content, not
  design-system surfaces.

## Shapes

### Border Radius Scale

| Token | Value | Use |
|---|---|---|
| `{rounded.xs}` | 2px | Tiny badges only |
| `{rounded.sm}` | 4px | Compact inline buttons (`{component.button-invest}`) |
| `{rounded.md}` | 6px | Standard CTAs, primary inputs, release/refund buttons |
| `{rounded.lg}` | 8px | Search input, content cards, badges, AI card |
| `{rounded.xl}` | 12px | Elevated containers (escrow/order/RWA/ledger/corridor cards, CTA bands) |
| `{rounded.pill}` | 9999px | Top-of-page CTAs and `{component.status-pill}` |
| `{rounded.full}` | 9999px / 50% | Currency flags, avatars |

### Iconography
- Currency/flag glyphs render as 24×24 or 32×32 rounded marks.
- Line icons (Lucide), 1.5–2px stroke, 20/24px. Status pills pair an icon with a
  label so state never relies on color alone.
- Cross-border/route illustrations are full-color assets with a slight floor
  shadow.

## Components

### Top Navigation
**`top-nav-dark`** — Dashboard/marketing nav on dark canvas. 64px tall,
`{colors.canvas-dark}`. Yellow StellarTrust wordmark at left; primary menu
(Payments, Escrow, Disputes, RWA Marketplace, Wallet, Docs); right cluster with
language selector, light/dark toggle, "Log In" text link, "Get Started"
`{component.button-primary}`.

**`top-nav-light`** — Transactional nav (send payment, deposit, KYC). Same layout
on `{colors.canvas-light}` with `{colors.ink}` items.

### Buttons
**`button-primary`** — Signature CTA. `{colors.primary}` bg, `{colors.on-primary}`
black text, `{typography.button}`, 12×24 padding, 40px height, `{rounded.md}`.
Press → `button-primary-active`. Disabled → `button-primary-disabled`.

**`button-primary-pill`** — Larger pill for top-of-page / hero actions ("Get
Started", "Start a Payment"). 14×32 padding, `{rounded.pill}`. Use sparingly.

**`button-secondary-on-dark`** / **`button-secondary-on-light`** — Less-emphasized
actions per canvas.

**`button-tertiary-text`** — Inline text button, no background ("Log In",
"View details").

**`button-release`** — Green action for **Release Payment / Approve** in escrow
and dispute flows. `{colors.status-released}` bg, white text, `{rounded.md}`,
10×22 padding. Semantic — never a generic confirm.

**`button-refund`** — Red action for **Refund / Reject**. `{colors.status-refunded}`
bg, symmetric to release. Semantic — never a generic cancel. Money-moving
release/refund above threshold must pass the human-approval gate (see Rules.md).

**`button-invest`** — Compact yellow CTA in the RWA marketplace investor table
("Invest"). 28px height, tight padding — fits dense rows.

**`text-link`** — Inline links in `{colors.primary}`, no underline by default.

### Cards & Containers (dark)
**`hero-band-dark`** — Full-width dark hero: h1 + sub-headline + dual CTA. h1 in
`{typography.hero-display}`.

**`stat-callout-card`** — Inline yellow stat numbers ($429M settled, 12,480
businesses, ~5s median settlement). Transparent bg, `{colors.primary}` text,
`{typography.number-display}` in IBM Plex Mono.

**`trust-badge`** — Small dark cards for claims ("Non-custodial escrow",
"SEP-31 anchored", "AI-assisted disputes"). `{colors.surface-card-dark}`,
`{rounded.lg}`, 16×20 padding.

**`status-pill`** — The core money-state chip. Pill shape, `{typography.caption}`,
4×12 padding. Background is a ~12% tint of the state color; text/icon at full
state color. Fixed mapping (Locked=violet, Released/Verified=green, Refunded/
Rejected=red, Disputed/Review=amber). Always icon + label + color.

**`escrow-status-card`** — Escrow summary: order ref (mono), parties, amount
(number-display), a `{component.status-pill}`, and a state timeline (Locked →
Shipped → Confirmed → Released / Disputed). `{colors.surface-card-dark}`,
`{rounded.xl}`, 24px padding.

**`order-card`** — Purchase-order summary (buyer/seller, item, amount, currency,
status pill).

**`corridor-rates-card`** — Cross-border corridor rates table. Tabs (Popular /
All corridors). Rows via `{component.corridor-row}`: pair flags + codes, live
rate in `{typography.number-md}` (mono), 24h change via
`{component.rate-up-cell}` / `{component.rate-down-cell}`, est. fee, action.

**`corridor-row`** / **`rate-up-cell`** / **`rate-down-cell`** — Single corridor
row; rate-change cells colored by direction, paired with a small direction
arrow, mono type.

**`ledger-table-card`** — Double-entry ledger view. Columns Date / Description /
Debit / Credit / Balance. `{component.ledger-credit-cell}` (green) and
`{component.ledger-debit-cell}` (red) right-aligned in mono. Every money movement
is a balanced pair — the UI shows both sides.

**`dispute-panel-card`** — Dispute workspace: 24h countdown, evidence list
(invoice, tracking, OTP, courier, images), and both parties' submissions.
Contains one `{component.ai-recommendation-card}`.

**`ai-recommendation-card`** — Advisory AI output. `{colors.surface-elevated-dark}`,
`{rounded.lg}`, 20px padding. Must render: an **"Advisory"** tag, the
recommendation (Release / Refund / Manual Review) as a `{component.status-pill}`,
a **confidence** value in mono, an **explanation**, and the **signals used**.
Never present as a final verdict; the human action buttons (`button-release` /
`button-refund` / escalate) sit outside this card.

**`kyc-status-banner`** — Verification state banner (Verified / Under Review /
Rejected) using the matching status color + `{component.status-pill}`.

**`rwa-token-card`** — Tokenized-asset listing (invoice/commodity/real estate):
asset ref, face value + discount, term, expected yield, funded progress bar, and
`{component.button-invest}`. `{colors.surface-card-dark}`, `{rounded.xl}`.

**`investor-row`** — Row in the RWA marketplace / holdings table: asset + issuer
on left; yield %, amount, maturity columns; `{component.button-invest}` on right.

**`escrow-protected-band`** — Yellow-headlined trust band ("FUNDS STAY IN ESCROW
UNTIL DELIVERY IS CONFIRMED"). `{colors.canvas-dark}` bg, headline in
`{colors.primary}` at `{typography.display-lg}`, anchored by three
`{component.stat-callout-card}` numbers (total in escrow, disputes resolved,
funds released).

**`feature-photo-card`** / **`qr-promo-card`** / **`faq-row`** / **`cta-band-dark`**
— As in the source system: lifestyle photo strip, wallet-app QR promo, FAQ
accordion rows, and the pre-footer "Secure, low-fee cross-border payments" CTA
band (h2 `{typography.display-sm}` + right-aligned `{component.button-primary}`).

**`hero-gradient-band`** — Campaign/launch hero with a `{colors.primary}` →
`{colors.canvas-dark}` vertical gradient and a `{component.button-primary-pill}`.
Product-launch surfaces only; do not generalize.

### Light-Mode Transactional Components
**`send-payment-amount-card`** — Right-rail card on the Send Payment page.
`{colors.canvas-light}`, `{rounded.lg}`, 24px padding. Editable amount in
`{typography.number-display}` (mono), source→destination currency selector with
live rate + est. fee, and a yellow `{component.button-primary}` ("Continue").

**`steps-card`** — "How escrow works" 3-up (Deposit into escrow → Ship & confirm
delivery → Funds released). `{colors.canvas-light}`, `{rounded.lg}`, numbered
icon + `{typography.title-sm}` label + body.

**`fx-rate-chart-card`** — Corridor rate chart (e.g., USD→INR). Top row: pair +
current rate + delta; main area line chart in `{colors.value-up}` /
`{colors.value-down}`; bottom row timeframe selector (24H / 1W / 1M / 3M / 1Y).

**`conversion-cell`** — Row in a currency-conversion table; pair label left,
converted amount right in mono.

### Inputs & Forms
**`search-input-on-dark`** — "Search transactions / orders / corridors" input.
`{colors.surface-card-dark}`, `{rounded.lg}`, 40px height.

**`text-input-on-light`** — Standard transactional input. `{colors.canvas-light}`,
1px `{colors.hairline-on-light}`, `{rounded.md}`, 40px height, focus-ring on
focus.

**`cookie-consent-card`** — Cookie banner. `{colors.canvas-light}`,
`{rounded.lg}`, 16px padding, `{typography.body-sm}`, stacked options.

### Footer
**`footer-light`** — Light-gray footer closing every page (including dark ones).
`{colors.surface-soft-light}` bg, `{colors.body-on-light}` text, 6-column links
(Company / Product / Developers / Compliance / Support / Legal), 64px vertical
padding. The light footer on a dark page is a deliberate "reset" close.

## Do's and Don'ts

### Do
- Reserve `{colors.primary}` for primary actions, brand-claim headlines, and the
  wordmark. Its scarcity is its power.
- Keep `{component.button-primary}` (yellow + black text) as the universal
  primary CTA across both themes, identical on dark and light.
- Use `{component.button-release}` (green) and `{component.button-refund}` (red)
  only for explicit money decisions in escrow/disputes — never as generic
  confirm/cancel.
- Encode every money state with `{component.status-pill}` using the fixed color
  map, always icon + label + color.
- Render AI output only through `{component.ai-recommendation-card}` with the
  "Advisory" tag, confidence, and explanation. Keep human action buttons outside
  the card.
- Use IBM Plex Mono for every number, amount, rate, address, hash, and ID.
- Choose canvas by surface intent: dark for marketing/dashboards; light for
  transactional dialogs.
- Anchor editorial bands with `{spacing.section}` (80px).

### Don't
- Don't introduce a second brand color. One accent (`{colors.primary}`) only.
- Don't use yellow for body text, large fills, or to signal status (amber
  `{colors.status-disputed}` handles "attention", not brand yellow).
- Don't use `{colors.value-up}` / `{colors.value-down}` or status colors as card
  surface fills — they are text/pill signals, not backgrounds.
- Don't present AI recommendations as final verdicts or auto-trigger money
  movement above threshold from the AI card. Human gate required (Rules.md).
- Don't soften display weight below 700 for hero/display roles.
- Don't add atmospheric gradients/mesh/glow to the canvas. Trust color-block
  contrast.
- Don't invert `{component.button-primary}` text to white on yellow.

## Responsive Behavior

### Breakpoints
| Name | Width | Key Changes |
|---|---|---|
| Mobile | < 768px | Top nav → hamburger sheet; hero h1 64px → ~36px; corridor/ledger tables become horizontally-scrollable card lists; grids 1-up; footer 6→2 cols |
| Tablet | 768–1024px | Nav tightens, overflow items behind "More"; tables/grids 2-up |
| Desktop | 1024–1440px | Full nav; 5-column corridor table; dashboards in 8/4 split (detail + timeline) |
| Wide | > 1440px | As desktop with more outer air; content caps 1280–1440px |

### Touch Targets
- Primary CTAs ≥ 40×40px (meets 44×44 with surrounding spacing).
- `{component.button-invest}` at 28px — dense but industry-normal; whole row is
  tappable for a 44px+ effective target.
- Currency/flag icons 32×32; full escrow/ledger rows tappable.

### Collapsing Strategy
- Nav collapses to a full-screen sheet < 768px with yellow CTAs anchored bottom.
- Corridor and ledger tables reflow to one card per row on mobile.
- Hero stat numbers shrink proportionally rather than wrapping.
- Dashboard 8/4 split becomes stacked (detail, then timeline) on mobile; the
  dispute AI card stays full-width above the action buttons.
- The light footer stays full-bleed at every breakpoint.

## Iteration Guide
1. Focus on ONE component at a time; reference its YAML key
   (`{component.escrow-status-card}`, `{component.status-pill}`).
2. When adding a component, decide dark (marketing/dashboard) vs light
   (transactional) first; the same component flips surface tone across both.
3. Variants (`-active`, `-disabled`, release/refund) live as separate
   `components:` entries, not nested state objects.
4. Use `{token.refs}` everywhere prose names a color, radius, type role, or
   spacing value.
5. Document Default and Active/Pressed states only — not hover.
6. Numbers/amounts/addresses always IBM Plex Mono; copy always Inter.
7. Value green/red and status colors are semantic — never repurpose them as
   decorative or generic success/error fills; use the fixed status map.
8. Every AI surface is advisory + explainable; money actions are human-gated.

## Known Gaps
- Inter/IBM Plex Mono weight axes are documented at the static weights used
  here; variable-font tokens not yet formalized.
- Animation/transition timings (status transitions, rate flashes, timeline
  progression) are out of scope.
- Form validation variants beyond `{component.text-input-on-light}` (inline
  error/success) need the KYC and payment flows to finalize.
- Admin/compliance console surfaces (dispute queue, KYC review) reuse these
  tokens but their dense table layouts are not yet fully specified.
- Chart component internals (candlestick vs line, axis styling) for
  `{component.fx-rate-chart-card}` are not fully specified.
