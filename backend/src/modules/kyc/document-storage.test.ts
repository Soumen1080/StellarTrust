/**
 * Identity-capture decoding tests.
 *
 * These cover the boundary where untrusted bytes enter the system. The
 * property under test is that the *bytes* decide what a file is — a caller
 * controls the whole data URL, including its `data:image/png` prefix, so the
 * prefix is evidence of nothing.
 */
import { describe, expect, it } from "vitest";
import { decodeCapture } from "./document-storage.service.js";
import { ValidationError } from "../../lib/errors.js";

/** Smallest byte sequences that carry each format's magic number. */
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP", "ascii"),
]);

const dataUrl = (declared: string, bytes: Buffer): string =>
  `data:${declared};base64,${bytes.toString("base64")}`;

describe("decodeCapture", () => {
  it("accepts the three renderable image formats", () => {
    expect(decodeCapture(dataUrl("image/png", PNG)).contentType).toBe(
      "image/png",
    );
    expect(decodeCapture(dataUrl("image/jpeg", JPEG)).contentType).toBe(
      "image/jpeg",
    );
    expect(decodeCapture(dataUrl("image/webp", WEBP)).contentType).toBe(
      "image/webp",
    );
  });

  it("identifies the file from its bytes, not its declared type", () => {
    // Declared PNG, actually JPEG. The bytes win.
    const result = decodeCapture(dataUrl("image/png", JPEG));
    expect(result.contentType).toBe("image/jpeg");
  });

  it("rejects a payload whose bytes are not an image at all", () => {
    // The attack this closes: an SVG or a script declared as an image.
    const svg = Buffer.from('<svg onload="alert(1)"></svg>', "utf8");
    expect(() => decodeCapture(dataUrl("image/png", svg))).toThrow(
      ValidationError,
    );
  });

  it("rejects a data URL that is not base64-encoded", () => {
    expect(() => decodeCapture("data:image/png,notbase64")).toThrow(
      ValidationError,
    );
  });

  it("rejects a string that is not a data URL", () => {
    expect(() => decodeCapture("https://example.com/passport.png")).toThrow(
      ValidationError,
    );
  });

  it("rejects an empty payload", () => {
    expect(() => decodeCapture("data:image/png;base64,")).toThrow(
      ValidationError,
    );
  });

  it("refuses an oversized upload before decoding it", () => {
    // Bounded on the encoded length, so a huge body is never expanded in
    // memory just to be rejected.
    const oversized = "A".repeat(13 * 1024 * 1024);
    expect(() => decodeCapture(`data:image/jpeg;base64,${oversized}`)).toThrow(
      /8 MB or smaller/,
    );
  });

  it("returns the decoded bytes intact", () => {
    const result = decodeCapture(dataUrl("image/png", PNG));
    expect(result.bytes.equals(PNG)).toBe(true);
  });
});
