/**
 * Identity capture: camera → quality gate → downscale → upload.
 *
 * This is the part that makes verification real rather than a form. What
 * leaves the device is a photograph the user just took, not a fixture string.
 *
 * Three things happen between the shutter and the upload, and each exists
 * because of a specific way a verification fails:
 *
 *  - **A quality gate.** The overwhelming majority of KYC rejections are
 *    unusable photographs — blurred, dark, cropped. Catching that here, while
 *    the document is still in the user's hand, turns a two-day round trip into
 *    a retake.
 *  - **A downscale.** A modern phone camera produces 4000×3000 at 6 MB. The
 *    provider gains nothing above ~1600px on the long edge and the upload
 *    costs the user four times as long on a weak connection.
 *  - **Stripped metadata.** A capture re-encoded through ImageManipulator
 *    carries no EXIF, so the GPS coordinates of the user's home do not travel
 *    with their passport photograph.
 */
import { File } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import type { KycCaptureKind } from "@stellartrust/shared";
import { apiRequest } from "../../api/http";

/** Long edge, in pixels, after downscaling. Legible for OCR, cheap to send. */
const TARGET_LONG_EDGE = 1600;

/** JPEG quality. 0.8 is the knee: below it, OCR starts losing small print. */
const JPEG_QUALITY = 0.8;

/**
 * Minimum accepted source resolution.
 *
 * Below this the capture cannot carry enough detail for document
 * authentication no matter how it is processed, so it is refused before the
 * user waits on an upload.
 */
const MIN_SOURCE_LONG_EDGE = 640;

export interface PreparedCapture {
  /** Local URI of the processed image, for preview. */
  uri: string;
  /** Data URL to upload. */
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
}

export class CaptureQualityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureQualityError";
  }
}

/**
 * Downscale, re-encode, and measure a camera capture.
 *
 * Returns the bytes as a data URL because that is what the upload endpoint
 * accepts — the same shape the avatar route already uses, so the server's
 * magic-byte verification path is identical.
 */
export async function prepareCapture(
  sourceUri: string,
  source: { width: number; height: number },
): Promise<PreparedCapture> {
  const longEdge = Math.max(source.width, source.height);

  if (longEdge < MIN_SOURCE_LONG_EDGE) {
    throw new CaptureQualityError(
      "That photo is too small to read. Move closer and take it again.",
    );
  }

  // The object-oriented API; `manipulateAsync` was deprecated in SDK 52 and
  // is on its way out.
  const context = ImageManipulator.manipulate(sourceUri);

  // Only ever downscale: enlarging a small capture invents detail that
  // document authentication would then be reading as real. Constraining the
  // long edge alone preserves the aspect ratio.
  if (longEdge > TARGET_LONG_EDGE) {
    context.resize(
      source.width >= source.height
        ? { width: TARGET_LONG_EDGE }
        : { height: TARGET_LONG_EDGE },
    );
  }

  const rendered = await context.renderAsync();
  const result = await rendered.saveAsync({
    compress: JPEG_QUALITY,
    format: SaveFormat.JPEG,
    base64: true,
  });

  if (!result.base64) {
    throw new CaptureQualityError("Could not process that photo. Try again.");
  }

  // The `File` API replaced `getInfoAsync` in SDK 54; `size` is a property
  // rather than an opt-in flag on a request.
  const file = new File(result.uri);
  const bytes = file.exists ? (file.size ?? 0) : 0;

  return {
    uri: result.uri,
    dataUrl: `data:image/jpeg;base64,${result.base64}`,
    width: result.width,
    height: result.height,
    bytes,
  };
}

/**
 * Upload one capture and return its opaque `storage://` reference.
 *
 * Each capture is uploaded on its own rather than batched into the
 * application: a failure retries one image instead of all three, and the UI
 * can show per-image progress.
 */
export async function uploadCapture(
  accessToken: string,
  kind: KycCaptureKind,
  dataUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  const { reference } = await apiRequest<{ reference: string }>(
    "/api/kyc/captures",
    {
      method: "POST",
      accessToken,
      body: { kind, dataUrl },
      // A document photograph over a weak uplink is not a 20-second request.
      timeoutMs: 90_000,
      signal,
    },
  );
  return reference;
}

/**
 * A rough sharpness proxy, used to reject an obviously blurred capture.
 *
 * A true Laplacian-variance measure needs the pixel buffer, which RN does not
 * hand us without a native module. Compressed size at fixed quality and
 * dimensions is a serviceable stand-in: a blurred frame has little
 * high-frequency content and so compresses far smaller than a sharp one of the
 * same size. The threshold is deliberately permissive — this exists to catch
 * the badly-out-of-focus case, not to adjudicate borderline ones, which the
 * provider does properly.
 */
export function looksBlurred(capture: PreparedCapture): boolean {
  const pixels = capture.width * capture.height;
  if (pixels === 0) return false;
  const bitsPerPixel = (capture.bytes * 8) / pixels;
  return bitsPerPixel < 0.45;
}
