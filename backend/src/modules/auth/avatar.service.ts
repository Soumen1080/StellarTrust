/**
 * Avatar decoding, verification, and storage.
 *
 * This is the first path in the system that accepts and stores a binary. The
 * schema deliberately keeps identity documents out of Postgres, and that stance
 * still holds here: an avatar is admissible only because it is user-chosen and
 * public by intent. What follows is the set of checks that keeps it that way.
 *
 * The declared content type of an upload is never trusted. A caller controls
 * the whole data URL, including its `data:image/png` prefix, so the prefix says
 * nothing about the bytes behind it. The file is identified from its own magic
 * bytes and rejected if that signature is not one of the three formats a
 * browser will render as an image.
 */
import {
  AVATAR_MAX_BYTES,
  AVATAR_MIME_TYPES,
} from "@stellartrust/shared";
import { ExternalServiceError, ValidationError } from "../../lib/errors.js";
import { getSupabaseAdmin, isSupabaseConfigured } from "./supabase.client.js";

/** Bucket the avatars live in. Must exist and be publicly readable. */
const AVATAR_BUCKET = "avatars";

type AvatarMimeType = (typeof AVATAR_MIME_TYPES)[number];

/**
 * Identifies an image from its leading bytes.
 *
 * Only these three formats are accepted. SVG is deliberately excluded despite
 * being an image: it can carry script, and these files are served from storage
 * and rendered in the browser.
 */
function sniffImageType(bytes: Buffer): AvatarMimeType | undefined {
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
  // JPEG: SOI marker. The third byte begins the first segment marker.
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  // WebP is RIFF-framed: "RIFF" <4-byte size> "WEBP".
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

const EXTENSION: Record<AvatarMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/**
 * Decodes a `data:` URL into verified image bytes.
 *
 * The size is checked twice: once against the encoded length, so an oversized
 * payload is refused before it is expanded in memory, and once against the
 * decoded buffer, which is the limit that actually matters.
 */
export function decodeAvatarDataUrl(dataUrl: string): {
  bytes: Buffer;
  contentType: AvatarMimeType;
} {
  const comma = dataUrl.indexOf(",");
  const header = comma === -1 ? "" : dataUrl.slice(0, comma);
  if (comma === -1 || !header.includes(";base64")) {
    throw new ValidationError("Avatar must be a base64 data URL");
  }

  const base64 = dataUrl.slice(comma + 1);
  // 4 base64 characters encode 3 bytes; this bounds the decode without doing it.
  if ((base64.length * 3) / 4 > AVATAR_MAX_BYTES) {
    throw new ValidationError("Image must be 2 MB or smaller");
  }

  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) throw new ValidationError("Avatar image was empty");
  if (bytes.length > AVATAR_MAX_BYTES) {
    throw new ValidationError("Image must be 2 MB or smaller");
  }

  const contentType = sniffImageType(bytes);
  if (!contentType) {
    throw new ValidationError(
      "Image must be a PNG, JPEG, or WebP file",
    );
  }
  return { bytes, contentType };
}

/**
 * Stores a user's avatar and returns its public URL.
 *
 * The object key is derived from the user id, so a re-upload replaces the
 * previous file instead of accumulating orphans. A version suffix defeats CDN
 * and browser caching of the old image at what would otherwise be a stable URL.
 */
export async function storeAvatar(
  userId: string,
  dataUrl: string,
): Promise<string> {
  const { bytes, contentType } = decodeAvatarDataUrl(dataUrl);

  if (!isSupabaseConfigured()) {
    throw new ExternalServiceError(
      "Profile picture uploads are not configured on this environment",
    );
  }

  const path = `${userId}/avatar-${Date.now()}.${EXTENSION[contentType]}`;
  const storage = getSupabaseAdmin().storage.from(AVATAR_BUCKET);

  // Remove prior avatars first: `upsert` alone would not catch files left under
  // a different extension or version suffix.
  const { data: existing } = await storage.list(userId);
  if (existing?.length) {
    await storage.remove(existing.map((file) => `${userId}/${file.name}`));
  }

  const { error } = await storage.upload(path, bytes, {
    contentType,
    upsert: true,
  });
  if (error) {
    throw new ExternalServiceError("Could not store the profile picture", error);
  }

  return storage.getPublicUrl(path).data.publicUrl;
}
