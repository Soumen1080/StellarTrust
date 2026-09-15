/**
 * Notification-target tests.
 *
 * A push payload is attacker-influenced in principle — anything holding a
 * device token can attempt a send. So a tapped notification must never be able
 * to route the app somewhere arbitrary; only the three known screens, each
 * with the param it actually needs, are honoured.
 */
import { targetFromNotification } from "./notifications";

describe("targetFromNotification", () => {
  it("accepts each of the three known screens with its own param", () => {
    expect(
      targetFromNotification({ screen: "OrderDetail", orderId: "o-1" }),
    ).toEqual({ screen: "OrderDetail", orderId: "o-1" });

    expect(
      targetFromNotification({
        screen: "SettlementDetail",
        settlementId: "s-1",
      }),
    ).toEqual({ screen: "SettlementDetail", settlementId: "s-1" });

    expect(
      targetFromNotification({ screen: "DisputeDetail", disputeId: "d-1" }),
    ).toEqual({ screen: "DisputeDetail", disputeId: "d-1" });
  });

  it("rejects a screen that is not on the allow-list", () => {
    expect(
      targetFromNotification({ screen: "Profile", orderId: "o-1" }),
    ).toBeNull();
    expect(
      targetFromNotification({ screen: "../../etc/passwd" }),
    ).toBeNull();
  });

  it("rejects a known screen whose param is missing", () => {
    expect(targetFromNotification({ screen: "OrderDetail" })).toBeNull();
  });

  it("rejects a param of the wrong type", () => {
    // A number or an object here would reach navigation as a bad route param.
    expect(
      targetFromNotification({ screen: "OrderDetail", orderId: 42 }),
    ).toBeNull();
    expect(
      targetFromNotification({ screen: "OrderDetail", orderId: { a: 1 } }),
    ).toBeNull();
  });

  it("rejects a mismatched param for the named screen", () => {
    // Right shape, wrong pairing — must not fall through to another branch.
    expect(
      targetFromNotification({ screen: "OrderDetail", disputeId: "d-1" }),
    ).toBeNull();
  });

  it("handles an absent or empty payload", () => {
    expect(targetFromNotification(undefined)).toBeNull();
    expect(targetFromNotification({})).toBeNull();
  });
});
