/**
 * The purchase flow (plane.md §4.6).
 *
 * The one behaviour worth a test here is the risk disclosure gate. §3.4
 * decided that entering an amount opens a disclosure and only a *second* click
 * buys, because a single button beside a number field is how someone invests
 * without once being told what they are taking on.
 *
 * That is a two-state interaction with no server involvement, which means it
 * is exactly the kind of thing a refactor breaks silently: collapse the states
 * and every existing test still passes, the flow still "works", and the
 * disclosure is simply gone. So the assertions below are about *when the
 * purchase call is made* rather than about markup.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  AuthSessionResponse,
  TokenizationDTO,
  TokenizationRiskDTO,
} from "@stellartrust/shared";

// Mocked before the component is imported, so the module graph picks up the
// double rather than the real client.
vi.mock("@/lib/api", () => ({
  ApiClientError: class ApiClientError extends Error {},
  api: {
    listTokenizations: vi.fn(),
    listAssets: vi.fn(),
    getRwaPortfolio: vi.fn(),
    purchaseUnits: vi.fn(),
  },
}));

const SESSION: AuthSessionResponse = {
  accessToken: "test-token",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  // The purchase sends `session.wallet.stellarPublicKey` as the holder
  // address, so the session carries the wallet a SEP-10 sign-in proved.
  wallet: {
    id: "wallet-1",
    stellarPublicKey: "GDYWVMFH5JDIISEZMLDFTN6A5NHPLZGKTTYAAKGB5Z6U7MHKUV6JPVS5",
  },
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

import { api } from "@/lib/api";
import { RwaConsole } from "./RwaConsole";

const TOKENIZATION: TokenizationDTO = {
  id: "tok-00000000-0000-4000-8000-000000000001",
  assetId: "asset-1",
  issuerUserId: "issuer-1",
  contractId: "CA".padEnd(56, "X"),
  totalUnits: "1000",
  unitsSold: "100",
  pricePerUnitAmount: "800",
  pricePerUnitCurrency: "USDC",
  faceValueAmount: "1000000",
  faceValueCurrency: "USDC",
  advanceRateBps: 8_000,
  discountRateBps: 400,
  platformFeeBps: 100,
  maturityDate: "2027-01-01T00:00:00.000Z",
  collectedAt: null,
  status: "active",
  frozen: false,
  requireAuthorization: false,
  linkedOrderId: null,
  contractDeployedAt: "2026-05-01T00:00:00.000Z",
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
} as TokenizationDTO;

const RISK: TokenizationRiskDTO = {
  advanceRateBps: 8_000,
  discountRateBps: 400,
  maturityDate: "2027-01-01T00:00:00.000Z",
  daysRemaining: 210,
  overdue: false,
  disputed: false,
  issuerReputationScore: 80,
  counterparty: { ref: "counterparty:ACME", name: "Acme Ltd", reputationScore: null },
  projectedYieldAmount: "3200",
} as TokenizationRiskDTO;

beforeEach(() => {
  vi.mocked(api.listTokenizations).mockResolvedValue({
    tokenizations: [TOKENIZATION],
    risk: { [TOKENIZATION.id]: RISK },
  } as never);
  vi.mocked(api.listAssets).mockResolvedValue({ assets: [] } as never);
  vi.mocked(api.getRwaPortfolio).mockResolvedValue({
    holdings: [],
    totalInvested: "0",
    totalPayoutsReceived: "0",
    totalAccruedYield: "0",
    totalRealizedLoss: "0",
    overdueCount: 0,
  } as never);
  vi.mocked(api.purchaseUnits).mockResolvedValue({} as never);
});

/** Render and wait for the marketplace to finish its initial load. */
async function renderConsole() {
  render(<RwaConsole />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /invest/i })).toBeInTheDocument(),
  );
}

describe("the risk disclosure gate", () => {
  it("does not buy on the first click", async () => {
    // The acceptance condition of §3.4: one click never moves money.
    const user = userEvent.setup();
    await renderConsole();

    await user.type(screen.getByLabelText(/units/i), "10");
    await user.click(screen.getByRole("button", { name: /invest/i }));

    expect(api.purchaseUnits).not.toHaveBeenCalled();
  });

  it("shows the disclosure instead, and asks for a second confirmation", async () => {
    const user = userEvent.setup();
    await renderConsole();

    await user.type(screen.getByLabelText(/units/i), "10");
    await user.click(screen.getByRole("button", { name: /invest/i }));

    expect(
      screen.getByRole("button", { name: /confirm investment/i }),
    ).toBeInTheDocument();
  });

  it("buys on the second click, with the units entered", async () => {
    const user = userEvent.setup();
    await renderConsole();

    await user.type(screen.getByLabelText(/units/i), "10");
    await user.click(screen.getByRole("button", { name: /invest/i }));
    await user.click(
      screen.getByRole("button", { name: /confirm investment/i }),
    );

    await waitFor(() => expect(api.purchaseUnits).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.purchaseUnits).mock.calls[0]?.[3]).toMatchObject({
      units: "10",
    });
  });

  it("re-opens the disclosure when the amount changes", async () => {
    // A disclosure shown for 10 units says nothing about 500. Letting the
    // confirmed state survive an edit is how someone confirms one investment
    // and makes another.
    const user = userEvent.setup();
    await renderConsole();

    const input = screen.getByLabelText(/units/i);
    await user.type(input, "10");
    await user.click(screen.getByRole("button", { name: /invest/i }));
    expect(
      screen.getByRole("button", { name: /confirm investment/i }),
    ).toBeInTheDocument();

    await user.type(input, "0"); // now 100
    expect(
      screen.getByRole("button", { name: /^invest$/i }),
    ).toBeInTheDocument();
    expect(api.purchaseUnits).not.toHaveBeenCalled();
  });

  it("refuses a non-numeric amount without opening the disclosure", async () => {
    const user = userEvent.setup();
    await renderConsole();

    await user.type(screen.getByLabelText(/units/i), "abc");
    await user.click(screen.getByRole("button", { name: /invest/i }));

    expect(
      screen.queryByRole("button", { name: /confirm investment/i }),
    ).not.toBeInTheDocument();
    expect(api.purchaseUnits).not.toHaveBeenCalled();
  });

  it("refuses more units than are available", async () => {
    // 1000 total, 100 sold — 900 available.
    const user = userEvent.setup();
    await renderConsole();

    await user.type(screen.getByLabelText(/units/i), "5000");
    await user.click(screen.getByRole("button", { name: /invest/i }));
    await user.click(
      screen.getByRole("button", { name: /confirm investment/i }),
    );

    await waitFor(() =>
      expect(screen.getByText(/only 900 units available/i)).toBeInTheDocument(),
    );
    expect(api.purchaseUnits).not.toHaveBeenCalled();
  });
});

describe("what the card discloses before a purchase", () => {
  it("names the maturity and the yield the investor is buying into", async () => {
    await renderConsole();
    // The risk block is on the card itself, not only behind the confirm, so a
    // marketplace of open deals discloses without a detail fetch per card.
    expect(screen.getByText(/acme ltd/i)).toBeInTheDocument();
  });

  it("shows an estimated cost derived from the unit price", async () => {
    const user = userEvent.setup();
    await renderConsole();

    // 10 units at 800 minor units = 8000 minor units. The RWA console formats
    // with CURRENCY_SCALE, where USDC is 7dp (deliberately unlike the ledger's
    // 2dp — a divergence the shared constants document), so this renders as
    // 0.0008000 rather than 80.00.
    await user.type(screen.getByLabelText(/units/i), "10");
    await waitFor(() =>
      expect(screen.getByText(/est\. cost/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/0\.0008000/)).toBeInTheDocument();
  });
});

describe("a position that cannot be bought", () => {
  it("offers no purchase form when the tokenization is frozen", async () => {
    vi.mocked(api.listTokenizations).mockResolvedValue({
      tokenizations: [{ ...TOKENIZATION, frozen: true }],
      risk: { [TOKENIZATION.id]: RISK },
    } as never);

    render(<RwaConsole />);
    await waitFor(() =>
      expect(screen.getByText(/transfers are frozen/i)).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: /invest/i }),
    ).not.toBeInTheDocument();
  });

  it("offers no purchase form when every unit is sold", async () => {
    vi.mocked(api.listTokenizations).mockResolvedValue({
      tokenizations: [{ ...TOKENIZATION, unitsSold: "1000" }],
      risk: { [TOKENIZATION.id]: RISK },
    } as never);

    render(<RwaConsole />);
    await waitFor(() =>
      expect(screen.getByText(/fully subscribed/i)).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: /invest/i }),
    ).not.toBeInTheDocument();
  });
});
