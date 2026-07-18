# StellarTrust — Design System

> **Status:** Living document. Update when tokens, fonts, or UI patterns change.
> **Last updated:** 2026-07-18

Design goal: convey **trust, clarity, and precision** — this is a financial
platform moving real money. Calm, professional, high-contrast, accessible. No
gimmicks. Numbers must be unambiguous.

---

## 1. Design Principles

1. **Trust first.** Clean layouts, generous spacing, clear hierarchy. Nothing
   that feels risky or playful around money.
2. **Clarity over decoration.** Every element earns its place.
3. **Numbers are sacred.** Monetary values use a tabular, monospaced style with
   explicit currency codes. Never truncate money.
4. **State is always visible.** Escrow/dispute/payment states are clearly
   labeled and color-coded consistently.
5. **Accessible by default.** WCAG 2.1 AA: contrast ≥ 4.5:1 for text, keyboard
   navigable, focus states visible, no color-only signaling.

---

## 2. Color Palette

### Brand
| Token | Hex | Use |
|---|---|---|
| `--brand-900` | `#0B1F3A` | Deep navy — headers, primary text on light |
| `--brand-700` | `#12386B` | Primary brand |
| `--brand-500` | `#1E63C4` | Primary actions, links |
| `--brand-300` | `#7FB0EE` | Hover/tint |
| `--brand-100` | `#E7F0FC` | Subtle backgrounds |

### Accent (trust/settlement)
| Token | Hex | Use |
|---|---|---|
| `--accent-teal-500` | `#0FB5A6` | Success accents, settlement, "released" |
| `--accent-teal-100` | `#DBF5F1` | Success surface |

### Neutrals
| Token | Hex | Use |
|---|---|---|
| `--neutral-950` | `#0C0F14` | Primary text (dark) |
| `--neutral-700` | `#3A4250` | Secondary text |
| `--neutral-500` | `#6B7280` | Muted text |
| `--neutral-300` | `#D1D6DE` | Borders |
| `--neutral-100` | `#F3F5F8` | App background |
| `--neutral-0`   | `#FFFFFF` | Surfaces/cards |

### Semantic / Status
| Token | Hex | Meaning |
|---|---|---|
| `--success` | `#15A34A` | Released, verified, approved |
| `--warning` | `#D97706` | Pending, review, action needed |
| `--danger`  | `#DC2626` | Refund, rejected, failed, disputed |
| `--info`    | `#2563EB` | Informational |
| `--pending` | `#7C3AED` | In-progress / escrow locked |

### Status → color mapping (consistent everywhere)
| State | Color |
|---|---|
| Escrow Locked | `--pending` (violet) |
| Released | `--success` (green) |
| Refunded | `--danger` (red) |
| Disputed | `--warning` (amber) |
| KYC Approved | `--success` |
| KYC Review | `--warning` |
| KYC Rejected | `--danger` |

### Dark mode
Provide a dark theme: `--neutral-950` background, elevated surfaces at
`#161B22`, text `#E6EAF0`. Keep semantic hues, lower saturation slightly for
contrast comfort. All tokens defined as CSS variables and switched by theme.

---

## 3. Typography

### Font families
| Role | Font | Fallback |
|---|---|---|
| UI / body / headings | **Inter** | system-ui, sans-serif |
| Monetary values & data | **IBM Plex Mono** (tabular) | ui-monospace, monospace |
| Code (docs/admin) | **JetBrains Mono** | ui-monospace, monospace |

> Money, wallet addresses, tx hashes, and IDs always render in the monospaced,
> tabular font so digits align.

### Type scale (rem, 16px base)
| Token | Size | Weight | Use |
|---|---|---|---|
| `display` | 2.5 (40px) | 700 | Page hero |
| `h1` | 2.0 (32px) | 700 | Page title |
| `h2` | 1.5 (24px) | 600 | Section |
| `h3` | 1.25 (20px) | 600 | Subsection |
| `body-lg` | 1.125 (18px) | 400 | Lead text |
| `body` | 1.0 (16px) | 400 | Default |
| `body-sm` | 0.875 (14px) | 400 | Secondary |
| `caption` | 0.75 (12px) | 500 | Labels, meta |
| `mono-amount` | 1.0–1.5 | 500 | Monetary values |

- Line height: 1.5 body, 1.2 headings.
- Letter spacing: slight negative on large headings (-0.01em).

---

## 4. Spacing, Radius, Elevation

- **Spacing scale (px):** 4, 8, 12, 16, 24, 32, 48, 64.
- **Radius:** `sm` 6px, `md` 10px (cards/inputs), `lg` 16px (modals), `full` pills.
- **Elevation:** subtle shadows only.
  - `shadow-sm`: `0 1px 2px rgba(11,31,58,.06)`
  - `shadow-md`: `0 4px 12px rgba(11,31,58,.10)`
- **Layout:** max content width 1200–1280px; 12-column grid; comfortable gutters.

---

## 5. Core Components

- **Buttons:** primary (`--brand-500`), secondary (outline), destructive
  (`--danger`), ghost. Clear disabled + loading states.
- **Status badge/pill:** uses status color mapping + label + optional icon
  (never color alone).
- **Money display:** monospaced, right-aligned in tables, always with currency
  code (e.g., `1,250.00 USD`). Show source→destination for FX
  (`1,000.00 USD → 83,120.00 INR`).
- **Cards:** white surface, `--neutral-300` border, `shadow-sm`.
- **Tables:** dense financial tables, sticky headers, tabular numerals.
- **Timeline/stepper:** for escrow lifecycle and dispute stages.
- **Evidence viewer:** document/image preview for disputes.
- **Toasts/alerts:** semantic colors; concise, non-technical messages.
- **Forms:** inline validation, clear error text (never color-only).

---

## 6. Iconography & Imagery

- Line icons (e.g., Lucide), 1.5–2px stroke, consistent 20/24px sizes.
- Avoid decorative stock imagery; use diagrams and data viz where helpful.
- Charts: clear axes, colorblind-safe palette, direct labels over legends.

---

## 7. Accessibility Checklist

- [ ] Text contrast ≥ 4.5:1 (≥ 3:1 for large text/icons).
- [ ] Visible focus states on all interactive elements.
- [ ] Full keyboard navigation; logical tab order.
- [ ] Status conveyed by icon/label + color, never color alone.
- [ ] Form errors announced (aria-live) and text-described.
- [ ] Respect `prefers-reduced-motion` and `prefers-color-scheme`.

---

## 8. Implementation Notes

- Tailwind config maps the tokens above (colors, fonts, spacing, radius).
- Expose all colors as CSS variables for light/dark theming.
- Centralize status→color/label mapping in `shared/` so frontend + admin +
  emails stay consistent.
