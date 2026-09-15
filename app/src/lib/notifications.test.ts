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

/**
 * Expo Go guard.
 *
 * `expo-notifications` throws at *import* time in Expo Go (SDK 53 removed
 * remote push there), so a static import crashes the whole app at startup with
 * a red screen. These pin the two properties that prevent that: the module is
 * never imported eagerly, and every entry point degrades to a no-op rather
 * than throwing.
 */
describe("running under Expo Go", () => {
  it("does not import expo-notifications at module load", () => {
    // The real module is not mocked here on purpose: if `notifications.ts`
    // imported it statically, requiring this test file would already have
    // pulled it in. Reaching this line at all is the assertion.
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("./notifications");
      expect(typeof mod.registerForPush).toBe("function");
      expect(typeof mod.subscribeToNotificationTaps).toBe("function");
    });
  });

  it("reports push as unsupported and returns no token", async () => {
    jest.resetModules();
    jest.doMock("expo-constants", () => ({
      __esModule: true,
      default: {
        // What Expo Go reports; a development build reports null here.
        appOwnership: "expo",
        // `lib/config.ts` reads these at import and throws without them, so
        // the mock has to carry them or the test would fail for the wrong
        // reason.
        expoConfig: {
          extra: {
            apiBaseUrl: "https://api.test.stellartrust.local",
            stellarNetwork: "testnet",
          },
        },
      },
    }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("./notifications");
    expect(mod.pushSupported).toBe(false);
    expect(mod.pushUnavailableReason).toMatch(/development build/i);
    await expect(mod.registerForPush("token")).resolves.toBeNull();

    jest.dontMock("expo-constants");
    jest.resetModules();
  });

  it("returns an unsubscribe function that is safe to call", () => {
    jest.resetModules();
    jest.doMock("expo-constants", () => ({
      __esModule: true,
      default: {
        appOwnership: "expo",
        expoConfig: {
          extra: {
            apiBaseUrl: "https://api.test.stellartrust.local",
            stellarNetwork: "testnet",
          },
        },
      },
    }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("./notifications");
    const unsubscribe = mod.subscribeToNotificationTaps(() => {
      throw new Error("must not fire when push is unavailable");
    });
    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe()).not.toThrow();

    jest.dontMock("expo-constants");
    jest.resetModules();
  });
});
