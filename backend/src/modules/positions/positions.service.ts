/**
 * The unified position view (plane.md §2.4).
 *
 * Four domains, four consoles, one user wondering which of them is about their
 * money. Someone who financed an invoice, funded the escrow through a corridor,
 * and then disputed the delivery had to open three screens and infer for
 * themselves that all three described a single trade.
 *
 * This assembles that story server-side. Not because the client could not make
 * four calls, but because the *links* between the records are joins the client
 * has no way to compute: which settlement funded which order, which
 * tokenization pays out when that order releases. Those relationships live in
 * columns the four list endpoints do not return.
 *
 * Read-only, and scoped to the caller throughout — every underlying list method
 * already filters by user, and this adds no way to widen that.
 */
import type {
  DisputeDTO,
  InvestorPortfolioResponse,
  OrderDetailsResponse,
  PositionLink,
  PositionsResponse,
  SettlementDetailsResponse,
} from "@stellartrust/shared";

/** The four domain reads a position view needs. Narrow ports, not services. */
export interface PositionSources {
  listOrders(userId: string): Promise<OrderDetailsResponse[]>;
  listSettlements(userId: string): Promise<SettlementDetailsResponse[]>;
  listDisputes(userId: string): Promise<DisputeDTO[]>;
  portfolio(userId: string): Promise<InvestorPortfolioResponse>;
  /** Tokenizations whose payout a given order triggers. */
  tokenizationIdsForOrder(orderId: string): Promise<string[]>;
}

export class PositionsService {
  constructor(private readonly sources: PositionSources) {}

  async forUser(userId: string): Promise<PositionsResponse> {
    // Independent reads across four domains; nothing here depends on anything
    // else, so paying four sequential round trips would be waste.
    const [orders, settlements, disputes, portfolio] = await Promise.all([
      this.sources.listOrders(userId),
      this.sources.listSettlements(userId),
      this.sources.listDisputes(userId),
      this.sources.portfolio(userId),
    ]);

    const links = await Promise.all(
      orders.map(async ({ order }): Promise<PositionLink> => ({
        orderId: order.id,
        fundedBySettlementId:
          settlements.find((s) => s.settlement.orderId === order.id)?.settlement
            .id ?? null,
        disputeIds: disputes
          .filter((dispute) => dispute.orderId === order.id)
          .map((dispute) => dispute.id),
        tokenizationIds: await this.sources.tokenizationIdsForOrder(order.id),
      })),
    );

    return {
      orders,
      settlements,
      disputes,
      holdings: portfolio.holdings,
      links,
    };
  }
}
