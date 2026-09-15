/**
 * Status → color mapping.
 *
 * Mirrors frontend/src/components/StatusPill.tsx one-for-one so a status
 * reads the same color on both clients. RN has no `/10` opacity shorthand, so
 * each entry carries the explicit tint and border it renders with.
 */
import { color } from "./tokens";

export interface StatusStyle {
  fg: string;
  bg: string;
  border: string;
}

/** `hex` at `alpha` over the dark canvas, precomputed to an 8-digit hex. */
function tint(hex: string, alpha: number): string {
  const a = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${a}`;
}

function style(fg: string): StatusStyle {
  return { fg, bg: tint(fg, 0.1), border: tint(fg, 0.3) };
}

const NEUTRAL: StatusStyle = {
  fg: color.mutedStrong,
  bg: tint(color.muted, 0.1),
  border: tint(color.muted, 0.3),
};

const STATUS_STYLE: Record<string, StatusStyle> = {
  // Escrow / order
  locked: style(color.statusLocked),
  released: style(color.statusReleased),
  refunded: style(color.statusRefunded),
  disputed: style(color.statusDisputed),
  pending: NEUTRAL,
  created: NEUTRAL,
  accepted: style(color.info),
  deposited: style(color.info),
  confirmed: style(color.statusVerified),
  cancelled: style(color.statusRefunded),

  // KYC
  verified: style(color.statusVerified),
  rejected: style(color.statusRejected),
  under_review: style(color.statusReview),

  // Settlement
  completed: style(color.statusVerified),
  quoted: NEUTRAL,
  deposit_pending: style(color.info),
  converting: style(color.statusLocked),
  payout_pending: style(color.info),
  failed: style(color.statusRejected),

  // Disputes
  open: style(color.statusReview),
  evidence_window: style(color.info),
  resolved: style(color.statusVerified),

  // RWA tokenization + payouts
  draft: NEUTRAL,
  active: style(color.info),
  funded: style(color.statusVerified),
  distributing: style(color.statusLocked),
  distributed: style(color.statusReleased),
  frozen: style(color.statusDisputed),
  processing: style(color.statusLocked),
};

export function statusStyle(status: string): StatusStyle {
  return STATUS_STYLE[status] ?? NEUTRAL;
}

/** `under_review` → `under review`, for display only. */
export function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}
