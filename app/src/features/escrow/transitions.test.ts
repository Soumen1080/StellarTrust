/**
 * Escrow action-availability tests.
 *
 * These encode who may do what, and when. The contract and the API enforce the
 * same rules; this is the layer that decides which buttons a user sees, so a
 * mistake here offers someone an action that will be refused — or worse, hides
 * the one step that would release their funds.
 */
import { OrderStatus, PaymentTransition } from "@stellartrust/shared";
import { actionsFor, statusExplanation } from "./transitions";

const transitions = (status: string, party: "buyer" | "seller") =>
  actionsFor(status, party).map((action) => action.transition);

describe("actionsFor", () => {
  it("lets only the seller accept a new order", () => {
    expect(transitions(OrderStatus.Created, "seller")).toEqual([
      PaymentTransition.Accept,
    ]);
    expect(transitions(OrderStatus.Created, "buyer")).toEqual([]);
  });

  it("lets only the buyer deposit and lock", () => {
    expect(transitions(OrderStatus.Accepted, "buyer")).toEqual([
      PaymentTransition.Deposit,
    ]);
    expect(transitions(OrderStatus.Accepted, "seller")).toEqual([]);

    expect(transitions(OrderStatus.Deposited, "buyer")).toEqual([
      PaymentTransition.Lock,
    ]);
    expect(transitions(OrderStatus.Deposited, "seller")).toEqual([]);
  });

  it("lets the buyer confirm or dispute once funds are locked", () => {
    expect(transitions(OrderStatus.Locked, "buyer")).toEqual([
      PaymentTransition.Confirm,
      PaymentTransition.Dispute,
    ]);
  });

  it("lets the seller dispute, but never confirm on the buyer's behalf", () => {
    const sellerActions = transitions(OrderStatus.Locked, "seller");
    expect(sellerActions).toEqual([PaymentTransition.Dispute]);
    expect(sellerActions).not.toContain(PaymentTransition.Confirm);
  });

  it("offers no action in a terminal state", () => {
    for (const status of [
      OrderStatus.Released,
      OrderStatus.Refunded,
      OrderStatus.Cancelled,
    ]) {
      expect(transitions(status, "buyer")).toEqual([]);
      expect(transitions(status, "seller")).toEqual([]);
    }
  });

  it("offers no action while a dispute is being arbitrated", () => {
    // The arbiter decides; neither party can move the escrow themselves.
    expect(transitions(OrderStatus.Disputed, "buyer")).toEqual([]);
    expect(transitions(OrderStatus.Disputed, "seller")).toEqual([]);
  });

  it("marks every fund-moving step as needing confirmation", () => {
    const fundMoving = [
      ...actionsFor(OrderStatus.Accepted, "buyer"),
      ...actionsFor(OrderStatus.Deposited, "buyer"),
      ...actionsFor(OrderStatus.Locked, "buyer"),
      ...actionsFor(OrderStatus.Confirmed, "seller"),
    ];
    expect(fundMoving.length).toBeGreaterThan(0);
    for (const action of fundMoving) {
      expect(action.confirm).toBe(true);
    }
  });

  it("does not gate the non-monetary accept behind a confirm sheet", () => {
    const [accept] = actionsFor(OrderStatus.Created, "seller");
    expect(accept?.confirm).toBe(false);
  });

  it("styles raising a dispute as destructive", () => {
    const dispute = actionsFor(OrderStatus.Locked, "buyer").find(
      (action) => action.transition === PaymentTransition.Dispute,
    );
    expect(dispute?.variant).toBe("danger");
  });
});

describe("statusExplanation", () => {
  it("tells each party who is being waited on", () => {
    expect(statusExplanation(OrderStatus.Created, "buyer")).toContain("seller");
    expect(statusExplanation(OrderStatus.Accepted, "seller")).toContain("buyer");
  });

  it("has wording for every order status", () => {
    for (const status of Object.values(OrderStatus)) {
      expect(statusExplanation(status, "buyer")).not.toBe("");
      expect(statusExplanation(status, "seller")).not.toBe("");
    }
  });
});
