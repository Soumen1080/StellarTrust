/**
 * Application root.
 *
 * Holds the splash screen until two things are true: the fonts have loaded and
 * the stored session has been read. Releasing earlier produces the flash of a
 * sign-in screen at every cold start for an already-signed-in user, which
 * reads as having been logged out.
 */
import {
  IBMPlexMono_400Regular,
  IBMPlexMono_500Medium,
  IBMPlexMono_600SemiBold,
} from "@expo-google-fonts/ibm-plex-mono";
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from "@expo-google-fonts/inter";
import {
  createNavigationContainerRef,
  NavigationContainer,
  type Theme,
} from "@react-navigation/native";
import { QueryClientProvider } from "@tanstack/react-query";
import { useFonts } from "expo-font";
import * as Notifications from "expo-notifications";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { AuthNavigator } from "./navigation/AuthNavigator";
import { RootNavigator } from "./navigation/RootNavigator";
import { targetFromNotification } from "./lib/notifications";
import { createQueryClient, useAppStateRefetch } from "./lib/query";
import type { RootStackParamList } from "./navigation/types";
import { color, font } from "./theme";

// Kept up until the first screen is genuinely ready to draw.
void SplashScreen.preventAutoHideAsync();

const queryClient = createQueryClient();

/**
 * Navigation ref.
 *
 * A notification tap arrives from outside React — there is no component in
 * scope to call `navigation.navigate` on — so the container is addressed
 * through a ref instead.
 */
const navigationRef = createNavigationContainerRef<RootStackParamList>();

/** React Navigation's own theme, so its chrome matches the design tokens. */
const navigationTheme: Theme = {
  dark: true,
  colors: {
    primary: color.primary,
    background: color.canvasDark,
    card: color.canvasDark,
    text: color.body,
    border: color.hairlineDark,
    notification: color.statusRejected,
  },
  fonts: {
    regular: { fontFamily: font.sans, fontWeight: "400" },
    medium: { fontFamily: font.sansMedium, fontWeight: "500" },
    bold: { fontFamily: font.sansSemibold, fontWeight: "600" },
    heavy: { fontFamily: font.sansBold, fontWeight: "700" },
  },
};

export default function App() {
  // Inter and IBM Plex Mono are the two faces DESIGN.md specifies; they are
  // registered under the token names so `theme/tokens.ts` stays the only place
  // a family is named.
  const [fontsLoaded, fontError] = useFonts({
    [font.sans]: Inter_400Regular,
    [font.sansMedium]: Inter_500Medium,
    [font.sansSemibold]: Inter_600SemiBold,
    [font.sansBold]: Inter_700Bold,
    [font.mono]: IBMPlexMono_400Regular,
    [font.monoMedium]: IBMPlexMono_500Medium,
    [font.monoSemibold]: IBMPlexMono_600SemiBold,
  });

  // A missing font file must not leave the app stuck behind the splash — the
  // system face is a worse rendering, not a broken one.
  const fontsSettled = fontsLoaded || fontError !== null;

  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <QueryClientProvider client={queryClient}>
            <AuthProvider>
              {/* Android is edge-to-edge in SDK 57, so the bar draws over the
                  app canvas; `backgroundColor` was removed accordingly. */}
              <StatusBar style="light" />
              <Gate fontsSettled={fontsSettled} />
            </AuthProvider>
          </QueryClientProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}

/** Chooses the navigator once everything needed to draw it is ready. */
function Gate({ fontsSettled }: { fontsSettled: boolean }) {
  const { session, restoring } = useAuth();
  useAppStateRefetch();
  useNotificationRouting(Boolean(session));

  const ready = fontsSettled && !restoring;

  const onReady = useCallback(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  const theme = useMemo(() => navigationTheme, []);

  if (!ready) return null;

  return (
    <NavigationContainer ref={navigationRef} theme={theme} onReady={onReady}>
      {session ? <RootNavigator /> : <AuthNavigator />}
    </NavigationContainer>
  );
}

/**
 * Routes a tapped notification to the screen it refers to.
 *
 * Handles both entry points: a tap while the app is running, and a tap that
 * launched it from cold, where the notification is waiting in the initial
 * response rather than arriving as an event.
 *
 * Only runs while signed in — a deep link into an order screen without a
 * session would render an authenticated screen with no token.
 */
function useNotificationRouting(signedIn: boolean): void {
  useEffect(() => {
    if (!signedIn) return;

    function go(data: Record<string, unknown> | undefined): void {
      const target = targetFromNotification(data);
      if (!target || !navigationRef.isReady()) return;
      // Switched rather than cast: each branch narrows the union to one
      // route, so its params are checked against that route's own type.
      switch (target.screen) {
        case "OrderDetail":
          navigationRef.navigate("OrderDetail", { orderId: target.orderId });
          return;
        case "SettlementDetail":
          navigationRef.navigate("SettlementDetail", {
            settlementId: target.settlementId,
          });
          return;
        case "DisputeDetail":
          navigationRef.navigate("DisputeDetail", {
            disputeId: target.disputeId,
          });
          return;
      }
    }

    // A cold start: the tap happened before this listener existed.
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      go(response?.notification.request.content.data);
    });

    const subscription =
      Notifications.addNotificationResponseReceivedListener((response) => {
        go(response.notification.request.content.data);
      });

    return () => subscription.remove();
  }, [signedIn]);
}
