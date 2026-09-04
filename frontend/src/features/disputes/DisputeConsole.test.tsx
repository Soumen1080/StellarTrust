/**
 * The dispute form (plane.md §4.6).
 *
 * A dispute is the mechanism by which a buyer stops money reaching a seller,
 * and — since §2.2 — it also freezes any RWA payout on the linked order. The
 * form that files one is therefore load-bearing, and the things worth
 * asserting are that it sends what the user typed, that it clears afterwards
 * so the next dispute is not filed against the previous order, and that a
 * server refusal is shown rather than swallowed.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AuthSessionResponse } from "@stellartrust/shared";

vi.mock("@/lib/api", () => ({
  ApiClientError: class ApiClientError extends Error {},
  api: {
    listDisputes: vi.fn(),
    listDisputeQueue: vi.fn(),
    openDispute: vi.fn(),
    submitDisputeEvidence: vi.fn(),
    resolveDispute: vi.fn(),
  },
}));

const SESSION: AuthSessionResponse = {
  accessToken: "test-token",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  wallet: {
    id: "wallet-1",
    stellarPublicKey: "GDYWVMFH5JDIISEZMLDFTN6A5NHPLZGKTTYAAKGB5Z6U7MHKUV6JPVS5",
  },
  // The dispute list passes `session.user.id` to each card so it can tell
  // which side of the claim the viewer is on.
  user: { id: "buyer-1", email: "buyer@example.test", kycStatus: "verified" },
} as AuthSessionResponse;

vi.mock("@/components/IdentityProvider", () => ({
  useIdentity: () => ({
    session: SESSION,
    profile: null,
    loading: false,
    error: null,
    isVerified: true,
    refreshProfile: async () => null,
  }),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/disputes",
}));

import { api } from "@/lib/api";
import { DisputeConsole } from "./DisputeConsole";

const ORDER_ID = "11111111-2222-4333-8444-555555555555";

beforeEach(() => {
  vi.mocked(api.listDisputes).mockResolvedValue({ disputes: [] } as never);
  vi.mocked(api.listDisputeQueue).mockRejectedValue(
    // The queue is compliance-only; an ordinary user is refused, and the
    // console must still render their own disputes.
    new Error("forbidden"),
  );
  vi.mocked(api.openDispute).mockResolvedValue({} as never);
});

async function renderConsole() {
  render(<DisputeConsole />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /open dispute/i }),
    ).toBeInTheDocument(),
  );
}

describe("filing a dispute", () => {
  it("sends the order and the reason the user typed", async () => {
    const user = userEvent.setup();
    await renderConsole();

    await user.type(screen.getByPlaceholderText(/order uuid/i), ORDER_ID);
    await user.type(
      screen.getByPlaceholderText(/describe the problem/i),
      "Goods never arrived",
    );
    await user.click(screen.getByRole("button", { name: /open dispute/i }));

    await waitFor(() => expect(api.openDispute).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.openDispute).mock.calls[0]?.[2]).toEqual({
      orderId: ORDER_ID,
      reason: "Goods never arrived",
    });
  });

  it("trims surrounding whitespace off both fields", async () => {
    // A pasted order id routinely carries a trailing space, and an untrimmed
    // one is a 404 the user cannot see the cause of.
    const user = userEvent.setup();
    await renderConsole();

    await user.type(
      screen.getByPlaceholderText(/order uuid/i),
      `  ${ORDER_ID}  `,
    );
    await user.type(
      screen.getByPlaceholderText(/describe the problem/i),
      "  spaced  ",
    );
    await user.click(screen.getByRole("button", { name: /open dispute/i }));

    await waitFor(() => expect(api.openDispute).toHaveBeenCalled());
    expect(vi.mocked(api.openDispute).mock.calls[0]?.[2]).toEqual({
      orderId: ORDER_ID,
      reason: "spaced",
    });
  });

  it("sends a fresh idempotency key per filing (Rules.md #4)", async () => {
    const user = userEvent.setup();
    await renderConsole();

    await user.type(screen.getByPlaceholderText(/order uuid/i), ORDER_ID);
    await user.type(
      screen.getByPlaceholderText(/describe the problem/i),
      "Goods never arrived",
    );
    await user.click(screen.getByRole("button", { name: /open dispute/i }));

    await waitFor(() => expect(api.openDispute).toHaveBeenCalled());
    // The key is the second argument, before the body.
    expect(vi.mocked(api.openDispute).mock.calls[0]?.[1]).toEqual(
      expect.any(String),
    );
  });

  it("clears the form after a successful filing", async () => {
    // Otherwise the next dispute is filed against the previous order — the
    // form still holds it, and the user only has to click.
    const user = userEvent.setup();
    await renderConsole();

    const orderField = screen.getByPlaceholderText(/order uuid/i);
    await user.type(orderField, ORDER_ID);
    await user.type(
      screen.getByPlaceholderText(/describe the problem/i),
      "Goods never arrived",
    );
    await user.click(screen.getByRole("button", { name: /open dispute/i }));

    await waitFor(() => expect(orderField).toHaveValue(""));
  });

  it("shows a server refusal instead of swallowing it", async () => {
    vi.mocked(api.openDispute).mockRejectedValue(
      new Error("Order is not in a disputable state"),
    );
    const user = userEvent.setup();
    await renderConsole();

    await user.type(screen.getByPlaceholderText(/order uuid/i), ORDER_ID);
    await user.type(
      screen.getByPlaceholderText(/describe the problem/i),
      "Goods never arrived",
    );
    await user.click(screen.getByRole("button", { name: /open dispute/i }));

    await waitFor(() =>
      expect(
        screen.getByText(/order is not in a disputable state/i),
      ).toBeInTheDocument(),
    );
  });

  it("keeps what the user typed when the filing is refused", async () => {
    // Clearing the form on failure makes the user retype everything to retry.
    vi.mocked(api.openDispute).mockRejectedValue(new Error("nope"));
    const user = userEvent.setup();
    await renderConsole();

    const orderField = screen.getByPlaceholderText(/order uuid/i);
    await user.type(orderField, ORDER_ID);
    await user.type(
      screen.getByPlaceholderText(/describe the problem/i),
      "Goods never arrived",
    );
    await user.click(screen.getByRole("button", { name: /open dispute/i }));

    await waitFor(() => expect(screen.getByText(/nope/i)).toBeInTheDocument());
    expect(orderField).toHaveValue(ORDER_ID);
  });
});

describe("the form's own validation", () => {
  it("does not submit with an empty order id", async () => {
    // `required` on the input, so the browser refuses before any handler runs.
    const user = userEvent.setup();
    await renderConsole();

    await user.type(
      screen.getByPlaceholderText(/describe the problem/i),
      "Goods never arrived",
    );
    await user.click(screen.getByRole("button", { name: /open dispute/i }));

    expect(api.openDispute).not.toHaveBeenCalled();
  });

  it("does not submit with an empty reason", async () => {
    const user = userEvent.setup();
    await renderConsole();

    await user.type(screen.getByPlaceholderText(/order uuid/i), ORDER_ID);
    await user.click(screen.getByRole("button", { name: /open dispute/i }));

    expect(api.openDispute).not.toHaveBeenCalled();
  });
});

describe("when the compliance queue is not available", () => {
  it("still renders the caller's own disputes", async () => {
    // `listDisputeQueue` 403s for an ordinary user. That must not take the
    // whole console down with it — the user's own disputes are theirs to see.
    vi.mocked(api.listDisputes).mockResolvedValue({
      disputes: [
        {
          id: "dispute-1",
          orderId: ORDER_ID,
          escrowId: "escrow-1",
          contractId: null,
          status: "open",
          amount: { amount: "100000", currency: "USDC" },
          reason: "Goods never arrived",
          openedBy: "buyer-1",
          buyerId: "buyer-1",
          sellerId: "seller-1",
          evidence: [],
          advisory: null,
          resolution: null,
          evidenceWindowClosesAt: "2026-05-02T00:00:00.000Z",
          createdAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-05-01T00:00:00.000Z",
        },
      ],
    } as never);

    await renderConsole();
    expect(screen.getAllByText(/goods never arrived/i).length).toBeGreaterThan(
      0,
    );
  });
});
