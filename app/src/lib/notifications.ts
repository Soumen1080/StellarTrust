/**
 * Push notification registration and handling.
 *
 * Permission is requested at the moment it makes sense — after sign-in, when
 * the user has something worth being told about — rather than at first launch,
 * where a cold prompt is usually declined and cannot be asked again.
 *
 * **Why `expo-notifications` is imported lazily.** Expo Go dropped remote push
 * support in SDK 53, and the module throws the moment it is loaded there — not
 * when a function is called. A static import would therefore take the whole app
 * down at startup with a red screen, before any screen renders, purely because
 * a developer opened it in Expo Go. Every entry point below resolves the module
 * at call time and returns a no-op when push is unavailable, so the app runs
 * normally in Expo Go with notifications simply switched off, and works fully
 * in a development or production build.
 */
import Constants from "expo-constants";
import * as Device from "expo-device";
import { Platform } from "react-native";
import { apiRequest } from "../api/http";

/**
 * Whether this binary can do remote push at all.
 *
 * `appOwnership` is `"expo"` only inside Expo Go; a development build made
 * with expo-dev-client reports `null` even though both are "store clients",
 * which is why `executionEnvironment` cannot be used to tell them apart.
 *
 * Compared against the string rather than the `AppOwnership` enum: this runs
 * at module load, and reading a property off an enum object some runtime did
 * not export would throw here — in the very file whose job is to not throw.
 */
export const pushSupported: boolean = Constants.appOwnership !== "expo";

/** Human-readable reason push is off, for a settings screen. Null when it works. */
export const pushUnavailableReason: string | null = pushSupported
  ? null
  : "Notifications need a development build — Expo Go cannot receive them.";

type NotificationsModule = typeof import("expo-notifications");

let modulePromise: Promise<NotificationsModule | null> | null = null;

/**
 * Loads `expo-notifications`, or resolves null where it cannot run.
 *
 * Cached, so the foreground handler below is installed exactly once.
 */
async function loadNotifications(): Promise<NotificationsModule | null> {
  if (!pushSupported) return null;
  if (!modulePromise) {
    modulePromise = (async () => {
      try {
        const mod = await import("expo-notifications");
        // Shown even while the app is open: a settlement completing or a
        // verification decision is worth surfacing over the current screen.
        mod.setNotificationHandler({
          handleNotification: async () => ({
            // `shouldShowAlert` is the pre-SDK-51 spelling; it is still
            // required by the type and is what older runtimes read.
            shouldShowAlert: true,
            shouldShowBanner: true,
            shouldShowList: true,
            shouldPlaySound: true,
            shouldSetBadge: false,
          }),
        });
        return mod;
      } catch {
        // A runtime without the native module. Push is simply off.
        return null;
      }
    })();
  }
  return modulePromise;
}

/**
 * Ask for permission and register this device with the API.
 *
 * Returns the token, or null when notifications are unavailable — Expo Go, a
 * simulator, a declined prompt, or a build with no EAS project id. Never
 * throws: a failure here must not interrupt a sign-in.
 */
export async function registerForPush(
  accessToken: string,
): Promise<string | null> {
  try {
    const Notifications = await loadNotifications();
    if (!Notifications) return null;

    // A simulator has no push service to register with.
    if (!Device.isDevice) return null;

    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== "granted") {
      // `canAskAgain` is false once the user has declined at the OS level;
      // asking again does nothing, so it is skipped.
      if (!existing.canAskAgain) return null;
      ({ status } = await Notifications.requestPermissionsAsync());
    }
    if (status !== "granted") return null;

    if (Platform.OS === "android") {
      // Android requires a channel before anything will be delivered.
      await Notifications.setNotificationChannelAsync("default", {
        name: "Account activity",
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: "#fcd535",
      });
    }

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;
    if (!projectId) return null;

    const { data: token } = await Notifications.getExpoPushTokenAsync({
      projectId,
    });

    await apiRequest("/api/notifications/devices", {
      method: "POST",
      accessToken,
      body: { token, platform: Platform.OS === "ios" ? "ios" : "android" },
    });

    return token;
  } catch {
    // Notifications are a convenience; never let them break a session.
    return null;
  }
}

/** Stop delivery to this device, on sign-out. */
export async function unregisterPush(
  accessToken: string,
  token: string,
): Promise<void> {
  try {
    await apiRequest("/api/notifications/devices", {
      method: "DELETE",
      accessToken,
      body: { token },
    });
  } catch {
    // Signing out locally already stopped this session; a failed
    // deregistration is not something the user can act on.
  }
}

/**
 * Where a notification should take the user.
 *
 * The payload carries a screen name and its params. Validated rather than
 * trusted: a tapped notification should never be able to push an arbitrary
 * route, so only these three are honoured.
 */
export type NotificationTarget =
  | { screen: "OrderDetail"; orderId: string }
  | { screen: "SettlementDetail"; settlementId: string }
  | { screen: "DisputeDetail"; disputeId: string };

export function targetFromNotification(
  data: Record<string, unknown> | undefined,
): NotificationTarget | null {
  const screen = data?.screen;
  if (screen === "OrderDetail" && typeof data?.orderId === "string") {
    return { screen, orderId: data.orderId };
  }
  if (screen === "SettlementDetail" && typeof data?.settlementId === "string") {
    return { screen, settlementId: data.settlementId };
  }
  if (screen === "DisputeDetail" && typeof data?.disputeId === "string") {
    return { screen, disputeId: data.disputeId };
  }
  return null;
}

/**
 * Subscribe to notification taps.
 *
 * Handles both entry points — a tap while the app is running, and one that
 * launched it from cold, where the response is waiting rather than arriving as
 * an event. Returns an unsubscribe function; a no-op where push is
 * unavailable.
 */
export function subscribeToNotificationTaps(
  onTarget: (target: NotificationTarget) => void,
): () => void {
  let subscription: { remove(): void } | null = null;
  let cancelled = false;

  void (async () => {
    const Notifications = await loadNotifications();
    if (!Notifications || cancelled) return;

    const handle = (data: Record<string, unknown> | undefined): void => {
      const target = targetFromNotification(data);
      if (target) onTarget(target);
    };

    // A cold start: the tap happened before this listener existed.
    const initial = await Notifications.getLastNotificationResponseAsync();
    if (cancelled) return;
    handle(initial?.notification.request.content.data);

    subscription = Notifications.addNotificationResponseReceivedListener(
      (response) => handle(response.notification.request.content.data),
    );
  })();

  return () => {
    cancelled = true;
    subscription?.remove();
  };
}
