/* eslint-disable @typescript-eslint/no-require-imports */
require("react-native-get-random-values");

jest.mock("expo-secure-store", () => {
  const store = new Map();
  return {
    setItemAsync: jest.fn(async (k, v) => void store.set(k, v)),
    getItemAsync: jest.fn(async (k) => store.get(k) ?? null),
    deleteItemAsync: jest.fn(async (k) => void store.delete(k)),
    isAvailableAsync: jest.fn(async () => true),
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: "whenUnlockedThisDeviceOnly",
  };
});

jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
  authenticateAsync: jest.fn(async () => ({ success: true })),
  supportedAuthenticationTypesAsync: jest.fn(async () => [1, 2]),
}));

jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(),
  notificationAsync: jest.fn(),
  selectionAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
}));

/**
 * Expo manifest extra.
 *
 * `lib/config.ts` deliberately throws when the API base is unset — that guard
 * is what stops a build shipping without one. Tests supply a manifest so the
 * guard stays in force in the app while the suite can still import the module.
 */
jest.mock("expo-constants", () => ({
  __esModule: true,
  default: {
    expoConfig: {
      extra: {
        apiBaseUrl: "https://api.test.stellartrust.local",
        stellarNetwork: "testnet",
        horizonUrl: "https://horizon-testnet.stellar.org",
        walletConnectProjectId: "",
        sep10HomeDomain: "test.stellartrust.local",
      },
    },
  },
}));

jest.mock("expo-crypto", () => ({
  randomUUID: jest.fn(() => "00000000-0000-4000-8000-000000000000"),
}));

/**
 * Native image modules.
 *
 * `capture.ts` is unit-tested for its quality heuristic, not for the native
 * bridge; importing the real modules pulls in Expo's asset registry, which has
 * no place in a Node test run.
 */
jest.mock("expo-image-manipulator", () => ({
  manipulateAsync: jest.fn(),
  SaveFormat: { JPEG: "jpeg", PNG: "png", WEBP: "webp" },
}));

jest.mock("expo-file-system", () => ({
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 0 })),
}));

/**
 * Notification modules.
 *
 * `notifications.ts` calls `setNotificationHandler` at import time, which
 * reaches the native bridge. The payload-validation logic under test is pure,
 * so the module is stubbed rather than the bridge simulated.
 */
jest.mock("expo-notifications", () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => undefined),
  getPermissionsAsync: jest.fn(async () => ({
    status: "granted",
    canAskAgain: true,
  })),
  requestPermissionsAsync: jest.fn(async () => ({ status: "granted" })),
  getExpoPushTokenAsync: jest.fn(async () => ({
    data: "ExponentPushToken[test]",
  })),
  getLastNotificationResponseAsync: jest.fn(async () => null),
  addNotificationResponseReceivedListener: jest.fn(() => ({
    remove: jest.fn(),
  })),
  AndroidImportance: { HIGH: 4, DEFAULT: 3 },
}));

jest.mock("expo-device", () => ({ isDevice: true }));
