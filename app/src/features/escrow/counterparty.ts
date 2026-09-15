/**
 * Who the other side of an order is, from this user's point of view.
 *
 * The API returns both parties; which one is "the counterparty" depends on who
 * is asking. Falls back to the role when the public ref is absent, so a row
 * never renders a bare id at a user.
 */
import type { OrderDetailsResponse } from "@stellartrust/shared";

export function counterpartyOf(
  entry: OrderDetailsResponse,
  viewerUserId: string | undefined,
): { label: string; role: "buyer" | "seller" } {
  const viewerIsBuyer = entry.order.buyerId === viewerUserId;
  const other = viewerIsBuyer ? entry.seller : entry.buyer;
  return {
    label: other?.username ? `@${other.username}` : viewerIsBuyer ? "Seller" : "Buyer",
    role: viewerIsBuyer ? "seller" : "buyer",
  };
}

/** Short one-line description for a list row. */
export function counterpartyLabel(
  entry: OrderDetailsResponse,
  viewerUserId?: string,
): string {
  const { label, role } = counterpartyOf(entry, viewerUserId);
  return role === "seller" ? `To ${label}` : `From ${label}`;
}
