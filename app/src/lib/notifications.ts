/**
 * Push notification registration and handling.
 *
 * Permission is requested at the moment it makes sense — after sign-in, when
 * the user has something worth being told about — rather than at first launch,
 * where a cold prompt is usually declined and cannot be asked again.
 */
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { apiRequest } from "../api/http";

/**
 * Foreground presentation.
 *
 * Shown even while the app is open: a settlement completing or a verification
 * decision is worth surfacing over whatever screen the user is on.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    // `shouldShowAlert` is the pre-SDK-51 spelling; it is still required by
    // the type and is what older runtimes read, so both are set.
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * Ask for permission and register this device with the API.
 *
 * Returns the token, or null when notifications are unavailable — a simulator,
 * a declined prompt, a build with no EAS project id. Never throws: a failure
 * here must not interrupt a sign-in.
 */
export async function registerForPush(
  accessToken: string,
): Promise<string | null> {
  try {
    // A simulator has no push service to register with.
    if (!Device.isDevice) return null;

    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== "granted") {
      // `canAskAgain` is false once the user has declined at the OS level;
      // asking again does nothing but is harmless, so it is only skipped to
      // avoid the pointless round trip.
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
    // Signing out locally already stopped this session; a failed deregistration
    // is not something the user can act on.
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
