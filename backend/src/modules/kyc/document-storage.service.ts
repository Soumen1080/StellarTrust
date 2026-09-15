/**
 * Identity-document and liveness-capture storage.
 *
 * This is the second binary path in the system, and it is nothing like the
 * first. An avatar is public by intent; a passport photograph and a liveness
 * selfie are the most sensitive data this platform will ever hold. The
 * differences are deliberate and load-bearing:
 *
 *  - **The bucket is private.** There is no public URL and none is ever
 *    produced. What the caller gets back is an opaque `storage://` reference,
 *    which the KYC input schema already accepts alongside `sandbox://`.
 *    Reading the bytes again requires a short-lived signed URL minted
 *    server-side for a provider or a reviewer.
 *  - **Nothing is written to Postgres.** The schema deliberately keeps
 *    identity documents out of the database; only the reference travels.
 *  - **The reference is unguessable.** The object key carries a random
 *    segment, so holding one user's reference tells you nothing about
 *    another's, even with the user id.
 *
 * As with avatars, the declared content type of the upload is not trusted: the
 * bytes are identified from their own magic numbers.
 */
import { randomUUID } from "node:crypto";
import { ExternalServiceError, ValidationError } from "../../lib/errors.js";
import {
  getSupabaseAdmin,
  isSupabaseConfigured,
} from "../auth/supabase.client.js";

/** Private bucket. Must exist and must NOT be public. */
const KYC_BUCKET = "kyc-documents";

/**
 * 8 MB. Larger than an avatar because a document photograph has to stay
 * legible enough for OCR after the client has already downscaled it.
 */
const MAX_BYTES = 8 * 1024 * 1024;

const MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
type KycMimeType = (typeof MIME_TYPES)[number];

const EXTENSION: Record<KycMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** What the image is of. Becomes part of the object key. */
export type CaptureKind =
  | "document-front"
  | "document-back"
  | "selfie"
  | "liveness";

/**
 * Identifies an image from its leading bytes.
 *
 * SVG is excluded for the same reason as in the avatar path: it can carry
 * script. HEIC is excluded because the client converts to JPEG before upload —
 * accepting it here would mean a format the downstream provider may not read.
 */
function sniffImageType(bytes: Buffer): KycMimeType | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

/** Decodes a `data:` URL into verified image bytes. */
export function decodeCapture(dataUrl: string): {
  bytes: Buffer;
  contentType: KycMimeType;
} {
  const comma = dataUrl.indexOf(",");
  const header = comma === -1 ? "" : dataUrl.slice(0, comma);
  if (comma === -1 || !header.includes(";base64")) {
    throw new ValidationError("Capture must be a base64 data URL");
  }

  const base64 = dataUrl.slice(comma + 1);
  // Bound the decode before performing it: 4 base64 chars encode 3 bytes.
  if ((base64.length * 3) / 4 > MAX_BYTES) {
    throw new ValidationError("Image must be 8 MB or smaller");
  }

  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) throw new ValidationError("Image was empty");
  if (bytes.length > MAX_BYTES) {
    throw new ValidationError("Image must be 8 MB or smaller");
  }

  const contentType = sniffImageType(bytes);
  if (!contentType) {
    throw new ValidationError("Image must be a PNG, JPEG, or WebP file");
  }
  return { bytes, contentType };
}

/**
 * Stores one capture and returns its opaque `storage://` reference.
 *
 * The returned string is what goes into `frontImageRef` / `faceImageRef` on
 * the KYC application. It is a reference, not a URL: it grants no access by
 * itself.
 */
export async function storeCapture(
  userId: string,
  kind: CaptureKind,
  dataUrl: string,
): Promise<string> {
  const { bytes, contentType } = decodeCapture(dataUrl);

  if (!isSupabaseConfigured()) {
    throw new ExternalServiceError(
      "Identity document storage is not configured on this environment",
    );
  }

  // The random segment is what makes the key unguessable; the user id prefix
  // is what makes per-user cleanup and retention sweeps possible.
  const path = `${userId}/${kind}-${randomUUID()}.${EXTENSION[contentType]}`;
  const storage = getSupabaseAdmin().storage.from(KYC_BUCKET);

  const { error } = await storage.upload(path, bytes, {
    contentType,
    // Never overwrite: each capture is evidence of a distinct attempt, and a
    // silently replaced document would break an audit trail.
    upsert: false,
  });
  if (error) {
    throw new ExternalServiceError("Could not store the document image", error);
  }

  return `storage://${KYC_BUCKET}/${path}`;
}

/**
 * Mints a short-lived signed URL for a stored capture.
 *
 * For server-side use only — handing a KYC provider or a compliance reviewer
 * time-boxed read access. It is never returned to the submitting user, who has
 * no reason to re-read their own document through the API.
 */
export async function signCaptureUrl(
  reference: string,
  expiresInSeconds = 300,
): Promise<string> {
  const prefix = `storage://${KYC_BUCKET}/`;
  if (!reference.startsWith(prefix)) {
    throw new ValidationError("Not a KYC document reference");
  }
  const path = reference.slice(prefix.length);

  if (!isSupabaseConfigured()) {
    throw new ExternalServiceError(
      "Identity document storage is not configured on this environment",
    );
  }

  const { data, error } = await getSupabaseAdmin()
    .storage.from(KYC_BUCKET)
    .createSignedUrl(path, expiresInSeconds);

  if (error || !data?.signedUrl) {
    throw new ExternalServiceError("Could not read the document image", error);
  }
  return data.signedUrl;
}

/**
 * Deletes every capture held for a user.
 *
 * Retention: identity documents are kept only as long as the verification
 * decision needs them. A rejected or superseded application's captures should
 * be swept rather than accumulated.
 */
export async function deleteUserCaptures(userId: string): Promise<void> {
  if (!isSupabaseConfigured()) return;
  const storage = getSupabaseAdmin().storage.from(KYC_BUCKET);
  const { data: existing } = await storage.list(userId);
  if (existing?.length) {
    await storage.remove(existing.map((file) => `${userId}/${file.name}`));
  }
}
