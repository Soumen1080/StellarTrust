/**
 * Capture quality tests.
 *
 * The blur heuristic is the one piece of judgment in the capture path. These
 * pin its intent: reject the obviously unusable, never reject a normal photo.
 * A false positive here blocks a real user from verifying at all, which is
 * worse than letting a marginal capture through to the provider.
 */
import { looksBlurred, type PreparedCapture } from "./capture";

const capture = (overrides: Partial<PreparedCapture>): PreparedCapture => ({
  uri: "file:///capture.jpg",
  dataUrl: "data:image/jpeg;base64,AAAA",
  width: 1600,
  height: 1009,
  bytes: 420_000,
  ...overrides,
});

describe("looksBlurred", () => {
  it("passes a normally-detailed document photo", () => {
    // ~2.1 bits/pixel: an ordinary in-focus JPEG at this quality.
    expect(looksBlurred(capture({}))).toBe(false);
  });

  it("flags a capture that compressed away to almost nothing", () => {
    // 20KB for 1.6MP is ~0.1 bits/pixel — no high-frequency detail survives.
    expect(looksBlurred(capture({ bytes: 20_000 }))).toBe(true);
  });

  it("passes a small but detailed capture", () => {
    // Dimensions alone must not condemn an image; density is the signal.
    expect(
      looksBlurred(capture({ width: 800, height: 505, bytes: 120_000 })),
    ).toBe(false);
  });

  it("does not divide by zero on a degenerate capture", () => {
    expect(looksBlurred(capture({ width: 0, height: 0, bytes: 0 }))).toBe(false);
  });

  it("is permissive at the boundary rather than strict", () => {
    // Just above the threshold must pass: the provider adjudicates the
    // borderline cases properly, this only catches the hopeless ones.
    const pixels = 1600 * 1000;
    const justAbove = Math.ceil((0.46 * pixels) / 8);
    expect(
      looksBlurred(capture({ width: 1600, height: 1000, bytes: justAbove })),
    ).toBe(false);
  });
});
