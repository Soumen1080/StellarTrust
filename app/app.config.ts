import type { ExpoConfig } from "expo/config";

/**
 * Expo application config.
 *
 * Runtime values that differ per environment (API base, Stellar network,
 * WalletConnect project id) are read from the environment at build time and
 * surfaced through `extra`, never hardcoded. `app/.env.example` documents the
 * full set; secrets are not committed (Rules.md #2).
 */
const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL ?? "http://localhost:8080";
const STELLAR_NETWORK = process.env.EXPO_PUBLIC_STELLAR_NETWORK ?? "testnet";

const config: ExpoConfig = {
  name: "StellarTrust",
  slug: "stellartrust",
  version: "1.0.0",
  orientation: "portrait",
  scheme: "stellartrust",
  userInterfaceStyle: "dark",
  backgroundColor: "#0b0e11",
  primaryColor: "#fcd535",
  icon: "./assets/icon.png",
  assetBundlePatterns: ["**/*"],
  ios: {
    supportsTablet: true,
    bundleIdentifier: "com.stellartrust.app",
    buildNumber: "1",
    config: { usesNonExemptEncryption: false },
    infoPlist: {
      NSCameraUsageDescription:
        "StellarTrust uses the camera to capture your identity document and a liveness selfie for identity verification.",
      NSPhotoLibraryUsageDescription:
        "StellarTrust needs photo access so you can attach evidence to a dispute or upload a profile photo.",
      NSFaceIDUsageDescription:
        "StellarTrust uses Face ID to unlock the wallet key that signs your transactions.",
    },
  },
  android: {
    package: "com.stellartrust.app",
    versionCode: 1,
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#0b0e11",
    },
    permissions: [
      "android.permission.CAMERA",
      "android.permission.USE_BIOMETRIC",
      "android.permission.USE_FINGERPRINT",
    ],
  },
  plugins: [
    "expo-secure-store",
    "expo-local-authentication",
    "expo-updates",
    // The top-level `splash` key was removed in SDK 54; the splash screen is
    // configured through this plugin instead. `imageWidth` is what keeps the
    // mark from being blown up to the full screen width.
    [
      "expo-splash-screen",
      {
        image: "./assets/splash.png",
        backgroundColor: "#0b0e11",
        imageWidth: 180,
        resizeMode: "contain",
      },
    ],
    [
      "expo-camera",
      {
        cameraPermission:
          "StellarTrust uses the camera to verify your identity document and liveness.",
      },
    ],
    [
      "expo-image-picker",
      {
        photosPermission:
          "StellarTrust needs photo access to attach dispute evidence.",
      },
    ],
    [
      "expo-notifications",
      {
        icon: "./assets/notification-icon.png",
        color: "#fcd535",
      },
    ],
  ],
  updates: {
    fallbackToCacheTimeout: 0,
  },
  runtimeVersion: { policy: "appVersion" },
  extra: {
    apiBaseUrl: API_BASE_URL,
    stellarNetwork: STELLAR_NETWORK,
    horizonUrl:
      process.env.EXPO_PUBLIC_HORIZON_URL ??
      "https://horizon-testnet.stellar.org",
    walletConnectProjectId: process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "",
    sep10HomeDomain: process.env.EXPO_PUBLIC_SEP10_HOME_DOMAIN ?? "",
    eas: { projectId: process.env.EAS_PROJECT_ID ?? "" },
  },
  experiments: { typedRoutes: false },
};

export default config;
