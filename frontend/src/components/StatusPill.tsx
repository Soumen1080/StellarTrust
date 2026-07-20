import type { EscrowState, KycStatus, OrderStatus } from "@stellartrust/shared";

type Status = EscrowState | KycStatus | OrderStatus;

const STATUS_STYLE: Record<string, string> = {
  locked: "border-status-locked/30 bg-status-locked/10 text-status-locked",
  released: "border-status-released/30 bg-status-released/10 text-status-released",
  refunded: "border-status-refunded/30 bg-status-refunded/10 text-status-refunded",
  disputed: "border-status-disputed/30 bg-status-disputed/10 text-status-disputed",
  verified: "border-status-verified/30 bg-status-verified/10 text-status-verified",
  rejected: "border-status-rejected/30 bg-status-rejected/10 text-status-rejected",
  under_review: "border-status-review/30 bg-status-review/10 text-status-review",
  pending: "border-muted/30 bg-muted/10 text-muted-strong",
  created: "border-muted/30 bg-muted/10 text-muted-strong",
  accepted: "border-info/30 bg-info/10 text-info",
  deposited: "border-info/30 bg-info/10 text-info",
  confirmed: "border-status-verified/30 bg-status-verified/10 text-status-verified",
  cancelled: "border-status-refunded/30 bg-status-refunded/10 text-status-refunded",
};

export function StatusPill({ status }: { status: Status }) {
  const style = STATUS_STYLE[status] ?? "border-muted/30 bg-muted/10 text-muted-strong";
  return <span className={`inline-flex items-center gap-xs rounded-pill border px-sm py-xs text-xs font-semibold capitalize ${style}`}><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />{status.replace(/_/g, " ")}</span>;
}
