/**
 * The escrow transition flow (plane.md §4.6).
 *
 * `nextAction` is the escrow state machine as the UI understands it: which
 * side of the trade may act, and on what. It decides whether someone is shown
 * a button that moves money, so the two failures worth guarding against are
 * offering a step to the wrong party, and offering one at the wrong point in
 * the sequence. Both render as a button that always errors — the server
 * refuses correctly — which is a confusing way to discover a UI bug.
 *
 * A pure function, so this needs no DOM, no mocking, and no session: it is
 * table-driven over every (status, viewer) pair the state machine can see.
 */
import { describe, expect, it } from "vitest";
import { OrderStatus, type OrderDetailsResponse } from "@stellartrust/shared";
import { nextAction } from "./EscrowDashboard";

const BUYER = "buyer-1";
const SELLER = "seller-1";
const STRANGER = "someone-else";

function order(status: OrderStatus): OrderDetailsResponse {
  return {
    order: {
      id: "order-1",
      buyerId: BUYER,
      sellerId: SELLER,
      amount: { amount: "100000", currency: "USDC" },
      status,
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    },
    escrow: null,
    transitions: [],
    blockedByReconciliation: false,
  } as unknown as OrderDetailsResponse;
}

describe("what the buyer is offered", () => {
  it.each([
    [OrderStatus.Accepted, "deposit"],
    [OrderStatus.Deposited, "lock"],
    [OrderStatus.Locked, "confirm"],
    [OrderStatus.Confirmed, "release"],
  ] as const)("offers %s → %s", (status, expected) => {
    expect(nextAction(order(status), BUYER)).toBe(expected);
  });

  it("offers nothing while the order is still awaiting the seller", () => {
    // `created` is the seller's move. Offering the buyer a step here would be
    // a button that acts before the other side has agreed to trade at all.
    expect(nextAction(order(OrderStatus.Created), BUYER)).toBeNull();
  });

  it.each([
    OrderStatus.Released,
    OrderStatus.Refunded,
    OrderStatus.Cancelled,
  ] as const)("offers nothing once the order is %s", (status) => {
    // Terminal. There is no next step, and a button here would submit a
    // transition the server refuses.
    expect(nextAction(order(status), BUYER)).toBeNull();
  });

  it("offers nothing while a dispute is open", () => {
    // A disputed order is resolved through the dispute path, by an arbiter —
    // not by the buyer pressing release.
    expect(nextAction(order(OrderStatus.Disputed), BUYER)).toBeNull();
  });
});

describe("what the seller is offered", () => {
  it("offers acceptance on a newly created order", () => {
    expect(nextAction(order(OrderStatus.Created), SELLER)).toBe("accept");
  });

  it.each([
    OrderStatus.Accepted,
    OrderStatus.Deposited,
    OrderStatus.Locked,
    OrderStatus.Confirmed,
  ] as const)("offers nothing at %s — those are the buyer's steps", (status) => {
    // Deposit, lock, confirm and release all move the buyer's money. A seller
    // shown any of them is being offered a button that spends someone else's
    // funds.
    expect(nextAction(order(status), SELLER)).toBeNull();
  });
});

describe("what a third party is offered", () => {
  it.each(Object.values(OrderStatus))(
    "offers nothing at %s to someone not party to the order",
    (status) => {
      expect(nextAction(order(status), STRANGER)).toBeNull();
    },
  );
});

describe("the sequence as a whole", () => {
  it("gives exactly one party a step at each stage", () => {
    // Two parties offered the same order at once is a race the UI invited.
    for (const status of Object.values(OrderStatus)) {
      const offered = [BUYER, SELLER, STRANGER].filter(
        (viewer) => nextAction(order(status), viewer) !== null,
      );
      expect(offered.length).toBeLessThanOrEqual(1);
    }
  });

  it("walks the happy path from creation to release without a gap", () => {
    // Each step's result is the status that unlocks the next. A gap here is an
    // order that gets stuck with no button to press.
    const walk: Array<[OrderStatus, string, string]> = [
      [OrderStatus.Created, SELLER, "accept"],
      [OrderStatus.Accepted, BUYER, "deposit"],
      [OrderStatus.Deposited, BUYER, "lock"],
      [OrderStatus.Locked, BUYER, "confirm"],
      [OrderStatus.Confirmed, BUYER, "release"],
    ];
    for (const [status, viewer, action] of walk) {
      expect(nextAction(order(status), viewer)).toBe(action);
    }
    expect(nextAction(order(OrderStatus.Released), BUYER)).toBeNull();
  });
});
