/**
 * Camera capture surface for documents and liveness selfies.
 *
 * One component serves both because the mechanics are identical and only the
 * guidance differs: a document is framed inside a card-shaped cutout on the
 * rear camera, a selfie inside an oval on the front one.
 *
 * The overlay is not decoration. Users hold documents at an angle, half out of
 * frame, or under a light that blows out the hologram; a visible target
 * rectangle is the single most effective fix for all three, and it is why the
 * capture is usable often enough that verification completes on the first try.
 */
import { CameraView, useCameraPermissions, type CameraType } from "expo-camera";
import * as Haptics from "expo-haptics";
import { useRef, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { Text } from "../../components/Text";
import { color, radius, space } from "../../theme";
import {
  CaptureQualityError,
  looksBlurred,
  prepareCapture,
  type PreparedCapture,
} from "./capture";

export type CaptureTarget = "document" | "selfie";

export interface CameraCaptureProps {
  target: CaptureTarget;
  title: string;
  instruction: string;
  onCaptured: (capture: PreparedCapture) => void;
  onCancel: () => void;
}

export function CameraCapture({
  target,
  title,
  instruction,
  onCaptured,
  onCancel,
}: CameraCaptureProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cameraRef = useRef<CameraView>(null);
  const insets = useSafeAreaInsets();

  const facing: CameraType = target === "selfie" ? "front" : "back";

  if (!permission) {
    return (
      <View style={styles.permission}>
        <ActivityIndicator color={color.primary} />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.permission}>
        <Text variant="titleMd" tone={color.onDark} center>
          Camera access is needed
        </Text>
        <Text variant="bodySm" tone={color.muted} center style={styles.blurb}>
          {target === "selfie"
            ? "We use the front camera once, to check that the person holding the document is you. The photo goes only to the identity checks."
            : "We use the camera to photograph your identity document. The photo goes only to the identity checks."}
        </Text>
        <Button
          label="Allow camera"
          onPress={() => void requestPermission()}
          fullWidth={false}
        />
        <Button
          label="Not now"
          onPress={onCancel}
          variant="ghost"
          fullWidth={false}
        />
      </View>
    );
  }

  async function capture(): Promise<void> {
    if (busy || !cameraRef.current) return;
    setBusy(true);
    setError(null);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        // Processed immediately afterwards; skipping here avoids paying for
        // the same work twice on a large sensor.
        skipProcessing: true,
        exif: false,
      });
      if (!photo?.uri) throw new CaptureQualityError("The photo did not save.");

      const prepared = await prepareCapture(photo.uri, {
        width: photo.width,
        height: photo.height,
      });

      if (looksBlurred(prepared)) {
        throw new CaptureQualityError(
          "That looks out of focus. Hold steady and take it again.",
        );
      }

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onCaptured(prepared);
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(
        err instanceof Error
          ? err.message
          : "Could not take that photo. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.root}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing={facing}
        // Mirroring a selfie preview matches what a user expects from a
        // mirror; the saved image is unmirrored either way.
        mirror={target === "selfie"}
      />

      <View style={styles.overlay} pointerEvents="box-none">
        <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
          <Text variant="titleMd" tone={color.onDark} center>
            {title}
          </Text>
          <Text variant="bodySm" tone={color.body} center style={styles.blurb}>
            {instruction}
          </Text>
        </View>

        <View style={styles.frameRow} pointerEvents="none">
          <View
            style={[
              styles.frame,
              target === "selfie" ? styles.frameOval : styles.frameCard,
            ]}
          />
        </View>

        <View
          style={[styles.footer, { paddingBottom: insets.bottom + space.lg }]}
        >
          {error ? (
            <View accessibilityRole="alert" style={styles.errorBanner}>
              <Text variant="bodySm" tone={color.onDark} center>
                {error}
              </Text>
            </View>
          ) : null}

          <View style={styles.controls}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              onPress={onCancel}
              style={styles.cancel}
            >
              <Text variant="button" tone={color.onDark}>
                Cancel
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Take photo"
              accessibilityState={{ busy }}
              disabled={busy}
              onPress={() => void capture()}
              style={({ pressed }) => [
                styles.shutter,
                pressed && styles.shutterPressed,
              ]}
            >
              {busy ? (
                <ActivityIndicator color={color.onPrimary} />
              ) : (
                <View style={styles.shutterInner} />
              )}
            </Pressable>

            {/* Balances the row so the shutter stays centred. */}
            <View style={styles.cancel} />
          </View>
        </View>
      </View>
    </View>
  );
}

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const FRAME_WIDTH = SCREEN_WIDTH - space.xl * 2;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  overlay: { flex: 1, justifyContent: "space-between" },
  header: {
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    gap: space.xxs,
    backgroundColor: "#000000a6",
  },
  blurb: { maxWidth: 320, alignSelf: "center" },
  frameRow: { alignItems: "center", justifyContent: "center" },
  frame: {
    borderWidth: 2,
    borderColor: color.primary,
    backgroundColor: "transparent",
  },
  // ID-1 card ratio (85.6 × 54mm), the shape of every document this accepts.
  frameCard: {
    width: FRAME_WIDTH,
    height: FRAME_WIDTH / 1.586,
    borderRadius: radius.xl,
  },
  frameOval: {
    width: FRAME_WIDTH * 0.72,
    height: FRAME_WIDTH * 0.96,
    borderRadius: FRAME_WIDTH,
  },
  footer: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    gap: space.md,
    backgroundColor: "#000000a6",
  },
  errorBanner: {
    padding: space.sm,
    borderRadius: radius.md,
    backgroundColor: color.statusRejected,
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  cancel: { width: 72, minHeight: 44, justifyContent: "center" },
  shutter: {
    width: 72,
    height: 72,
    borderRadius: radius.pill,
    backgroundColor: color.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  shutterPressed: { opacity: 0.8, transform: [{ scale: 0.96 }] },
  shutterInner: {
    width: 58,
    height: 58,
    borderRadius: radius.pill,
    borderWidth: 3,
    borderColor: color.onPrimary,
  },
  permission: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    padding: space.lg,
    backgroundColor: color.canvasDark,
  },
});
