/**
 * Money-state status pill (DESIGN.md `status-pill`).
 * Fixed color mapping; always label + color (icon added later). Never uses brand
 * yellow for status.
 */
import type { EscrowState, KycStatus, OrderStatus } from "@stellartrust/shared";

type Status = EscrowState | KycStatus | OrderStatus;

const STATUS_CLASS: Record<string, string> = {
  locked: "text-status-locked",
  released: "text-status-released",
  refunded: "text-status-refunded",
  disputed: "text-status-disputed",
  verified: "text-status-verified",
  rejected: "text-status-rejected",
  under_review: "text-status-review",
  pending: "text-muted",
  created: "text-muted",
  accepted: "text-info",
  deposited: "text-info",
  confirmed: "text-status-verified",
  cancelled: "text-status-refunded",
};

export function StatusPill({ status }: { status: Status }) {
  const cls = STATUS_CLASS[status] ?? "text-muted";
  return (
    <span
      className={`inline-flex items-center rounded-pill border border-hairline-dark px-sm py-xxs text-xs font-medium ${cls}`}
    >
      <span aria-hidden="true" className="mr-xs">●</span>
      {status.replace(/_/g, " ")}
    </span>
  );
}
