/**
 * Avatar decoding.
 *
 * The point of these tests is that the caller's declared content type carries
 * no authority. A `data:image/png` prefix is just a string the uploader wrote,
 * so what matters is whether the bytes behind it are actually an image — these
 * files are stored and later rendered in a browser.
 */
import { describe, expect, it } from "vitest";
import { AVATAR_MAX_BYTES } from "@stellartrust/shared";
import { decodeAvatarDataUrl } from "./avatar.service.js";

function dataUrl(declaredType: string, bytes: Buffer): string {
  return `data:${declaredType};base64,${bytes.toString("base64")}`;
}

/** Real signatures, padded out so each clears its format's minimum length. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(32)]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("WEBP", "ascii"),
  Buffer.alloc(32),
]);

describe("decodeAvatarDataUrl", () => {
  it.each([
    ["PNG", PNG, "image/png"],
    ["JPEG", JPEG, "image/jpeg"],
    ["WebP", WEBP, "image/webp"],
  ])("accepts a %s and reports its real type", (_label, bytes, expected) => {
    const result = decodeAvatarDataUrl(dataUrl(expected, bytes));
    expect(result.contentType).toBe(expected);
    expect(result.bytes.length).toBe(bytes.length);
  });

  it("identifies the file from its bytes, not its declared type", () => {
    // Declared PNG, actually a JPEG. The bytes win; the label is ignored.
    const result = decodeAvatarDataUrl(dataUrl("image/png", JPEG));
    expect(result.contentType).toBe("image/jpeg");
  });

  it("refuses a script disguised as an image", () => {
    const html = Buffer.from("<script>alert(1)</script>", "utf8");
    expect(() => decodeAvatarDataUrl(dataUrl("image/png", html))).toThrow(
      /PNG, JPEG, or WebP/,
    );
  });

  it("refuses an SVG, which is an image but can carry script", () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      "utf8",
    );
    expect(() => decodeAvatarDataUrl(dataUrl("image/svg+xml", svg))).toThrow(
      /PNG, JPEG, or WebP/,
    );
  });

  it("refuses a file over the size limit", () => {
    const huge = Buffer.concat([PNG, Buffer.alloc(AVATAR_MAX_BYTES + 1)]);
    expect(() => decodeAvatarDataUrl(dataUrl("image/png", huge))).toThrow(
      /2 MB or smaller/,
    );
  });

  it("refuses an empty payload", () => {
    expect(() => decodeAvatarDataUrl("data:image/png;base64,")).toThrow();
  });

  it("refuses a data URL that is not base64", () => {
    expect(() => decodeAvatarDataUrl("data:image/png,notbase64")).toThrow(
      /base64/,
    );
  });

  it("refuses a truncated signature that only starts out valid", () => {
    // The first two JPEG bytes, without the third. Too short to identify.
    expect(() =>
      decodeAvatarDataUrl(dataUrl("image/jpeg", Buffer.from([0xff, 0xd8]))),
    ).toThrow(/PNG, JPEG, or WebP/);
  });

  it("refuses RIFF container that is not WebP", () => {
    // A WAV file is RIFF-framed too; only the WEBP form is an image.
    const wav = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from("WAVE", "ascii"),
      Buffer.alloc(32),
    ]);
    expect(() => decodeAvatarDataUrl(dataUrl("image/webp", wav))).toThrow(
      /PNG, JPEG, or WebP/,
    );
  });
});
