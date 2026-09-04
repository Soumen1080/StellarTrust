/**
 * The unified position view (plane.md §2.4).
 *
 * The value of this endpoint is entirely in the `links` block — the four lists
 * it returns are already available separately. So that is what these test: that
 * one trade spanning a settlement, an order, a dispute, and a tokenization comes
 * back as one story rather than four disconnected records.
 */
import { describe, expect, it } from "vitest";
import { PositionsService, type PositionSources } from "./positions.service.js";

/** A source set with everything empty, overridden per test. */
function sources(overrides: Partial<PositionSources> = {}): PositionSources {
  return {
    listOrders: async () => [],
    listSettlements: async () => [],
    listDisputes: async () => [],
    portfolio: async () => ({
      holdings: [],
      totalInvested: "0",
      totalPayoutsReceived: "0",
    }),
    tokenizationIdsForOrder: async () => [],
    ...overrides,
  };
}

const order = (id: string) =>
  ({
    order: { id, status: "locked" },
    escrow: null,
    transitions: [],
    blockedByReconciliation: false,
  }) as never;

const settlement = (id: string, orderId: string | null) =>
  ({
    settlement: { id, orderId },
    transitions: [],
    blockedByReconciliation: false,
  }) as never;

describe("unified position view (§2.4)", () => {
  it("returns empty collections for a user with no activity", async () => {
    const service = new PositionsService(sources());

    const result = await service.forUser("user-1");

    expect(result.orders).toEqual([]);
    expect(result.links).toEqual([]);
  });

  it("links a settlement, a dispute, and a tokenization to one order", async () => {
    const service = new PositionsService(
      sources({
        listOrders: async () => [order("order-1")],
        listSettlements: async () => [settlement("stl-1", "order-1")],
        listDisputes: async () =>
          [{ id: "dispute-1", orderId: "order-1" }] as never,
        tokenizationIdsForOrder: async (orderId) =>
          orderId === "order-1" ? ["tok-1"] : [],
      }),
    );

    const result = await service.forUser("user-1");

    // The whole point: one call, and the caller can see that these four
    // records describe a single trade.
    expect(result.links).toEqual([
      {
        orderId: "order-1",
        fundedBySettlementId: "stl-1",
        disputeIds: ["dispute-1"],
        tokenizationIds: ["tok-1"],
      },
    ]);
  });

  it("leaves an unlinked order's relationships empty rather than guessing", async () => {
    const service = new PositionsService(
      sources({
        listOrders: async () => [order("order-1")],
        // A settlement the user made that funded nothing.
        listSettlements: async () => [settlement("stl-1", null)],
      }),
    );

    const result = await service.forUser("user-1");

    expect(result.links[0]).toEqual({
      orderId: "order-1",
      fundedBySettlementId: null,
      disputeIds: [],
      tokenizationIds: [],
    });
  });

  it("keeps each order's links to itself when a user has several", async () => {
    const service = new PositionsService(
      sources({
        listOrders: async () => [order("order-1"), order("order-2")],
        listSettlements: async () => [settlement("stl-2", "order-2")],
        listDisputes: async () =>
          [{ id: "dispute-1", orderId: "order-1" }] as never,
      }),
    );

    const result = await service.forUser("user-1");

    expect(result.links[0]?.fundedBySettlementId).toBeNull();
    expect(result.links[0]?.disputeIds).toEqual(["dispute-1"]);
    expect(result.links[1]?.fundedBySettlementId).toBe("stl-2");
    expect(result.links[1]?.disputeIds).toEqual([]);
  });
});
