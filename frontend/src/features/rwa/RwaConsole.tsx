"use client";

import {
  AssetType,
  CURRENCY_SCALE,
  SUPPORTED_CURRENCIES,
  TokenizationStatus,
  type AssetDTO,
  type AuthSessionResponse,
  type CurrencyCode,
  type InvestorPortfolioResponse,
  type TokenizationDTO,
} from "@stellartrust/shared";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { useIdentity } from "@/components/IdentityProvider";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";

/** Format an integer minor-unit string into a human amount for a currency. */
function formatMinor(amount: string, currency: CurrencyCode): string {
  const scale = CURRENCY_SCALE[currency] ?? 2;
  const negative = amount.startsWith("-");
  const digits = (negative ? amount.slice(1) : amount).padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale) || "0";
  const frac = scale > 0 ? `.${digits.slice(digits.length - scale)}` : "";
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${frac}`;
}

/** Convert a decimal input into an integer minor-unit string. */
function toMinorUnits(value: string, currency: CurrencyCode): string {
  const scale = CURRENCY_SCALE[currency] ?? 2;
  if (!/^\d+(\.\d+)?$/.test(value.trim())) throw new Error("Enter a valid amount");
  const [whole, frac = ""] = value.trim().split(".");
  if (frac.length > scale) throw new Error(`At most ${scale} decimal places for ${currency}`);
  const minor = `${whole}${frac.padEnd(scale, "0")}`.replace(/^0+(?=\d)/, "");
  if (!/^\d+$/.test(minor) || minor === "0") throw new Error("Amount must be greater than zero");
  return minor;
}

/**
 * Convert a percentage typed by a human into basis points.
 *
 * The form asks for "80" because that is how people describe an advance rate;
 * the wire carries 8000 because bps are integers and percentages invite
 * floats. One decimal place is allowed (7.5% = 750bps), which is as fine as
 * these terms are ever quoted.
 */
function toBps(percent: string): number {
  const trimmed = percent.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new Error("Rates must be a percentage, e.g. 80 or 7.5");
  }
  const bps = Math.round(Number(trimmed) * 100);
  if (bps < 0 || bps > 10_000) {
    throw new Error("Rates must be between 0% and 100%");
  }
  return bps;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The tokenization operation failed";
}

const ASSET_TYPE_LABEL: Record<AssetType, string> = {
  [AssetType.Invoice]: "Invoice",
  [AssetType.Commodity]: "Commodity",
  [AssetType.RealEstate]: "Real estate",
  [AssetType.Other]: "Other",
};

type Tab = "marketplace" | "issue" | "portfolio";

export function RwaConsole() {
  const { session } = useIdentity();
  const [tab, setTab] = useState<Tab>("marketplace");
  const [tokenizations, setTokenizations] = useState<TokenizationDTO[]>([]);
  const [assets, setAssets] = useState<AssetDTO[]>([]);
  const [portfolio, setPortfolio] = useState<InvestorPortfolioResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (active: AuthSessionResponse) => {
    const [{ tokenizations: list }, { assets: myAssets }, myPortfolio] =
      await Promise.all([
        api.listTokenizations(active.accessToken),
        api.listAssets(active.accessToken),
        api.getRwaPortfolio(active.accessToken),
      ]);
    setTokenizations(list);
    setAssets(myAssets);
    setPortfolio(myPortfolio);
  }, []);

  useEffect(() => {
    if (!session) {
      setTokenizations([]);
      setAssets([]);
      setPortfolio(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void refresh(session)
      .catch((err: unknown) => setError(message(err)))
      .finally(() => setLoading(false));
  }, [refresh, session]);

  const reload = useCallback(async () => {
    if (!session) return;
    try {
      await refresh(session);
    } catch (err) {
      setError(message(err));
    }
  }, [session, refresh]);

  if (!session) {
    return (
      <section className="panel-dark overflow-hidden">
        <div className="p-lg sm:p-xl md:p-xxl">
          <span className="grid h-12 w-12 place-items-center rounded-lg bg-primary/10 text-primary">
            <Icon name="sparkles" className="h-6 w-6" />
          </span>
          <h2 className="mt-lg text-xl font-bold text-on-dark sm:text-2xl">Connect your wallet to tokenize and invest</h2>
          <p className="mt-sm max-w-xl leading-7 text-muted-strong">
            Authenticate with SEP-10 to tokenize invoices, commodities, or real estate, and to buy transparent fractional ownership — payouts distribute pro-rata when the buyer pays through escrow.
          </p>
          <Link href="/" className="btn-primary mt-lg">Connect wallet <Icon name="arrow-right" className="h-4 w-4" /></Link>
        </div>
      </section>
    );
  }

  const activeCount = tokenizations.filter((t) => t.status === TokenizationStatus.Active).length;

  return (
    <div>
      <section className="mb-lg grid gap-md sm:grid-cols-3">
        <Metric label="Tokenizations" value={String(tokenizations.length)} detail={`${activeCount} open for investment`} icon="sparkles" />
        <Metric label="Your assets" value={String(assets.length)} detail="Available to tokenize" icon="document" />
        <Metric
          label="Invested"
          value={portfolio ? formatMinor(portfolio.totalInvested, "USDC") : "0"}
          detail={portfolio ? `${portfolio.holdings.length} holdings` : "No holdings yet"}
          icon="wallet"
        />
      </section>

      {error ? (
        <div role="alert" className="mb-lg flex items-start justify-between gap-md rounded-lg border border-status-rejected/30 bg-status-rejected/10 p-md text-sm text-status-rejected">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss error" className="icon-button"><Icon name="x" className="h-4 w-4" /></button>
        </div>
      ) : null}
      {notice ? (
        <div role="status" className="mb-lg flex items-start justify-between gap-md rounded-lg border border-status-verified/30 bg-status-verified/10 p-md text-sm text-status-verified">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss notice" className="icon-button"><Icon name="x" className="h-4 w-4" /></button>
        </div>
      ) : null}

      <div role="tablist" aria-label="RWA sections" className="mb-lg -mx-md flex gap-xs overflow-x-auto border-b border-hairline-dark px-md sm:mx-0 sm:px-0">
        <TabButton current={tab} value="marketplace" onSelect={setTab}>Marketplace</TabButton>
        <TabButton current={tab} value="issue" onSelect={setTab}>Tokenize</TabButton>
        <TabButton current={tab} value="portfolio" onSelect={setTab}>Portfolio</TabButton>
      </div>

      {loading ? (
        <div className="space-y-md">{Array.from({ length: 3 }).map((_, index) => <div key={index} className="panel-dark h-32 animate-pulse" />)}</div>
      ) : tab === "marketplace" ? (
        <Marketplace
          session={session}
          tokenizations={tokenizations}
          onError={setError}
          onNotice={setNotice}
          onChanged={reload}
        />
      ) : tab === "issue" ? (
        <IssuePanel
          session={session}
          assets={assets}
          tokenizations={tokenizations}
          onError={setError}
          onNotice={setNotice}
          onChanged={reload}
        />
      ) : (
        <PortfolioPanel portfolio={portfolio} />
      )}
    </div>
  );
}

// ── Marketplace (investor view) ───────────────────────────────────────────────

function Marketplace({
  session,
  tokenizations,
  onError,
  onNotice,
  onChanged,
}: {
  session: AuthSessionResponse;
  tokenizations: TokenizationDTO[];
  onError: (m: string) => void;
  onNotice: (m: string) => void;
  onChanged: () => Promise<void>;
}) {
  const investable = tokenizations.filter(
    (t) => t.status === TokenizationStatus.Active || t.status === TokenizationStatus.Funded,
  );

  if (investable.length === 0) {
    return (
      <div className="panel-dark px-lg py-xxl text-center">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-surface-elevated-dark text-muted"><Icon name="sparkles" /></span>
        <h3 className="mt-md font-semibold text-on-dark">No tokenizations open for investment</h3>
        <p className="mx-auto mt-xs max-w-md text-sm text-muted">When issuers deploy tokenizations they will appear here for fractional purchase.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-md md:grid-cols-2">
      {investable.map((t) => (
        <TokenizationCard
          key={t.id}
          session={session}
          tokenization={t}
          onError={onError}
          onNotice={onNotice}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}

function TokenizationCard({
  session,
  tokenization,
  onError,
  onNotice,
  onChanged,
}: {
  session: AuthSessionResponse;
  tokenization: TokenizationDTO;
  onError: (m: string) => void;
  onNotice: (m: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [units, setUnits] = useState("");
  const [pending, setPending] = useState(false);

  const available = (BigInt(tokenization.totalUnits) - BigInt(tokenization.unitsSold)).toString();
  const soldPct = Number((BigInt(tokenization.unitsSold) * 100n) / BigInt(tokenization.totalUnits));
  const canInvest = tokenization.status === TokenizationStatus.Active && !tokenization.frozen && BigInt(available) > 0n;

  async function invest(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    try {
      if (!/^\d+$/.test(units.trim()) || BigInt(units) <= 0n) {
        throw new Error("Enter a whole number of units");
      }
      if (BigInt(units) > BigInt(available)) {
        throw new Error(`Only ${available} units available`);
      }
      await api.purchaseUnits(session.accessToken, tokenization.id, crypto.randomUUID(), {
        units: units.trim(),
        holderAddress: session.wallet.stellarPublicKey,
      });
      setUnits("");
      onNotice(`Purchased ${units} units successfully`);
      await onChanged();
    } catch (err) {
      onError(message(err));
    } finally {
      setPending(false);
    }
  }

  const estCost = units && /^\d+$/.test(units.trim())
    ? (BigInt(units) * BigInt(tokenization.pricePerUnitAmount)).toString()
    : "0";

  return (
    <article className="panel-dark overflow-hidden">
      <div className="p-lg">
        <div className="flex items-center justify-between gap-sm">
          <StatusPill status={tokenization.status} />
          {tokenization.frozen ? <StatusPill status={TokenizationStatus.Frozen} /> : null}
        </div>
        <p className="mt-md font-mono text-[11px] text-muted" title={tokenization.id}>
          Tokenization · {tokenization.id.slice(0, 8)}…{tokenization.id.slice(-6)}
        </p>
        <p className="mt-sm break-words font-mono text-xl font-semibold text-on-dark sm:text-2xl">
          {formatMinor(tokenization.pricePerUnitAmount, tokenization.pricePerUnitCurrency)}
          <span className="ml-xs text-sm text-muted">{tokenization.pricePerUnitCurrency} / unit</span>
        </p>

        <div className="mt-md">
          <div className="flex justify-between text-xs text-muted">
            <span>{tokenization.unitsSold} / {tokenization.totalUnits} units sold</span>
            <span>{soldPct}%</span>
          </div>
          <div className="mt-xs h-2 overflow-hidden rounded-pill bg-surface-elevated-dark">
            <div className="h-full rounded-pill bg-primary" style={{ width: `${soldPct}%` }} />
          </div>
        </div>

        {canInvest ? (
          <form onSubmit={invest} className="mt-lg flex flex-col gap-sm min-[420px]:flex-row min-[420px]:items-end">
            <label className="min-w-0 flex-1 text-sm font-medium text-body">Units
              <input
                value={units}
                onChange={(e) => setUnits(e.target.value)}
                placeholder={`Max ${available}`}
                inputMode="numeric"
                className="input mt-xs font-mono"
              />
            </label>
            <button disabled={pending} className="btn-primary w-full shrink-0 min-[420px]:w-auto">
              {pending ? "Buying…" : "Invest"}
            </button>
          </form>
        ) : (
          <p className="mt-lg text-xs text-muted">
            {tokenization.frozen ? "Transfers are frozen." : "Fully subscribed — no units available."}
          </p>
        )}
        {canInvest && BigInt(estCost) > 0n ? (
          <p className="mt-sm text-xs text-muted">
            Est. cost: <span className="font-mono text-body">{formatMinor(estCost, tokenization.pricePerUnitCurrency)} {tokenization.pricePerUnitCurrency}</span>
          </p>
        ) : null}
      </div>
    </article>
  );
}

// ── Issue panel (issuer view) ─────────────────────────────────────────────────

function IssuePanel({
  session,
  assets,
  tokenizations,
  onError,
  onNotice,
  onChanged,
}: {
  session: AuthSessionResponse;
  assets: AssetDTO[];
  tokenizations: TokenizationDTO[];
  onError: (m: string) => void;
  onNotice: (m: string) => void;
  onChanged: () => Promise<void>;
}) {
  // Asset creation form state
  const [assetType, setAssetType] = useState<AssetType>(AssetType.Invoice);
  const [assetRef, setAssetRef] = useState("");
  const [description, setDescription] = useState("");
  const [valuation, setValuation] = useState("");
  const [valuationCurrency, setValuationCurrency] = useState<CurrencyCode>("USDC");
  const [creatingAsset, setCreatingAsset] = useState(false);

  // Tokenization form state
  const [assetId, setAssetId] = useState("");
  const [totalUnits, setTotalUnits] = useState("");
  const [faceValue, setFaceValue] = useState("");
  const [priceCurrency, setPriceCurrency] = useState<CurrencyCode>("USDC");
  // Percentages in the form, basis points on the wire. Defaults are a
  // conventional net-90 receivable: finance 80%, 4% to the investor.
  const [advanceRatePct, setAdvanceRatePct] = useState("80");
  const [discountRatePct, setDiscountRatePct] = useState("4");
  const [maturityDate, setMaturityDate] = useState("");
  const [requireAuth, setRequireAuth] = useState(false);
  const [creatingToken, setCreatingToken] = useState(false);

  const myTokenizations = tokenizations.filter((t) => t.issuerUserId === session.user.id);

  async function createAsset(event: FormEvent) {
    event.preventDefault();
    setCreatingAsset(true);
    try {
      const valuationAmount = toMinorUnits(valuation, valuationCurrency);
      await api.createAsset(session.accessToken, crypto.randomUUID(), {
        assetType,
        assetRef: assetRef.trim(),
        description: description.trim(),
        valuationAmount,
        valuationCurrency,
      });
      setAssetRef("");
      setDescription("");
      setValuation("");
      onNotice("Asset created — you can now tokenize it below");
      await onChanged();
    } catch (err) {
      onError(message(err));
    } finally {
      setCreatingAsset(false);
    }
  }

  /**
   * What the terms currently in the form actually mean, in money.
   *
   * Mirrors the server's arithmetic so the issuer sees the consequence of a
   * rate before submitting rather than after. It is a preview, not an
   * authority: the server recomputes and rejects terms that cannot be paid.
   * Returns null whenever the inputs are incomplete or invalid, so a
   * half-typed form shows nothing instead of a misleading number.
   */
  const financingPreview = (() => {
    try {
      if (!faceValue.trim() || !totalUnits.trim()) return null;
      const face = BigInt(toMinorUnits(faceValue, priceCurrency));
      const units = BigInt(totalUnits.trim());
      if (units <= 0n) return null;

      const advanceBps = BigInt(toBps(advanceRatePct));
      const discountBps = BigInt(toBps(discountRatePct));

      // Round-half-up, matching applyBps on the server.
      const principal = (face * advanceBps + 5_000n) / 10_000n;
      const investorYield = (principal * discountBps + 5_000n) / 10_000n;
      const proceeds = principal - investorYield;
      const unitPrice = principal / units;
      if (unitPrice <= 0n) return null;

      const residual = face - principal - investorYield;
      if (residual < 0n) return null;

      return {
        principal: `${formatMinor(principal.toString(), priceCurrency)} ${priceCurrency}`,
        proceeds: `${formatMinor(proceeds.toString(), priceCurrency)} ${priceCurrency}`,
        unitPrice: `${formatMinor(unitPrice.toString(), priceCurrency)} ${priceCurrency}`,
        residual: `${formatMinor(residual.toString(), priceCurrency)} ${priceCurrency}`,
      };
    } catch {
      return null;
    }
  })();

  async function createTokenization(event: FormEvent) {
    event.preventDefault();
    setCreatingToken(true);
    try {
      if (!assetId) throw new Error("Select an asset to tokenize");
      if (!/^\d+$/.test(totalUnits.trim()) || BigInt(totalUnits) <= 0n) {
        throw new Error("Total units must be a positive whole number");
      }
      if (!maturityDate) throw new Error("Set a maturity date");
      // The unit price is not sent: the server derives it from these terms, so
      // a price and a set of terms can never disagree.
      await api.createTokenization(session.accessToken, crypto.randomUUID(), {
        assetId,
        totalUnits: totalUnits.trim(),
        faceValueAmount: toMinorUnits(faceValue, priceCurrency),
        faceValueCurrency: priceCurrency,
        advanceRateBps: toBps(advanceRatePct),
        discountRateBps: toBps(discountRatePct),
        maturityDate: new Date(maturityDate).toISOString(),
        requireAuthorization: requireAuth,
      });
      setAssetId("");
      setTotalUnits("");
      setFaceValue("");
      setMaturityDate("");
      setRequireAuth(false);
      onNotice("Tokenization created as a draft — deploy it to open for investment");
      await onChanged();
    } catch (err) {
      onError(message(err));
    } finally {
      setCreatingToken(false);
    }
  }

  async function deploy(tokenizationId: string) {
    try {
      await api.deployTokenization(session.accessToken, tokenizationId, crypto.randomUUID());
      onNotice("Tokenization deployed and open for investment");
      await onChanged();
    } catch (err) {
      onError(message(err));
    }
  }

  async function toggleFreeze(t: TokenizationDTO) {
    try {
      if (t.frozen) {
        await api.unfreezeTokenization(session.accessToken, t.id, crypto.randomUUID());
        onNotice("Transfers unfrozen");
      } else {
        await api.freezeTokenization(session.accessToken, t.id, crypto.randomUUID());
        onNotice("Transfers frozen");
      }
      await onChanged();
    } catch (err) {
      onError(message(err));
    }
  }

  const availableAssets = assets.filter(
    (a) => !tokenizations.some((t) => t.assetId === a.id && t.status !== TokenizationStatus.Cancelled),
  );

  return (
    <div className="grid items-start gap-lg xl:grid-cols-[minmax(0,1fr)_400px]">
      <section>
        <h2 className="mb-md text-sm font-semibold text-on-dark">Your tokenizations</h2>
        {myTokenizations.length === 0 ? (
          <div className="panel-dark px-lg py-xxl text-center">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-surface-elevated-dark text-muted"><Icon name="document" /></span>
            <h3 className="mt-md font-semibold text-on-dark">No tokenizations yet</h3>
            <p className="mx-auto mt-xs max-w-md text-sm text-muted">Create an asset and tokenize it to unlock working capital from investors.</p>
          </div>
        ) : (
          <div className="space-y-md">
            {myTokenizations.map((t) => (
              <article key={t.id} className="panel-dark p-md sm:p-lg">
                <div className="flex flex-wrap items-center justify-between gap-sm">
                  <StatusPill status={t.status} />
                  <span className="font-mono text-[11px] text-muted" title={t.id}>{t.id.slice(0, 8)}…{t.id.slice(-6)}</span>
                </div>
                <p className="mt-md break-words font-mono text-lg font-semibold text-on-dark">
                  {t.totalUnits} units · {formatMinor(t.pricePerUnitAmount, t.pricePerUnitCurrency)} {t.pricePerUnitCurrency}/unit
                </p>
                <p className="mt-xs text-xs text-muted">{t.unitsSold} sold · {t.requireAuthorization ? "authorization required" : "open transfers"}</p>
                <div className="mt-md flex flex-wrap gap-sm">
                  {t.status === TokenizationStatus.Draft ? (
                    <button type="button" onClick={() => void deploy(t.id)} className="btn-primary">
                      Deploy <Icon name="arrow-right" className="h-4 w-4" />
                    </button>
                  ) : null}
                  {t.contractId ? (
                    <button type="button" onClick={() => void toggleFreeze(t)} className="btn-secondary-dark">
                      {t.frozen ? "Unfreeze" : "Freeze"}
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <aside className="space-y-lg">
        <div className="panel-light overflow-hidden text-ink">
          <div className="border-b border-hairline-light p-lg">
            <h2 className="font-semibold">1 · Register an asset</h2>
            <p className="text-xs text-muted">Describe the real-world asset to tokenize</p>
          </div>
          <form onSubmit={createAsset} className="space-y-md p-lg">
            <label className="block text-sm font-medium">Asset type
              <select value={assetType} onChange={(e) => setAssetType(e.target.value as AssetType)} className="input mt-xs">
                {Object.values(AssetType).map((type) => (
                  <option key={type} value={type}>{ASSET_TYPE_LABEL[type]}</option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-medium">Reference
              <input required value={assetRef} onChange={(e) => setAssetRef(e.target.value)} placeholder="invoice:INV-001" className="input mt-xs font-mono" />
            </label>
            <label className="block text-sm font-medium">Description
              <input required value={description} onChange={(e) => setDescription(e.target.value)} placeholder="90-day receivable from Acme Corp" className="input mt-xs" />
            </label>
            <div className="grid grid-cols-[1fr_auto] gap-sm">
              <label className="block text-sm font-medium">Valuation
                <input required value={valuation} onChange={(e) => setValuation(e.target.value)} placeholder="0.00" inputMode="decimal" className="input mt-xs font-mono" />
              </label>
              <label className="block text-sm font-medium">Currency
                <select value={valuationCurrency} onChange={(e) => setValuationCurrency(e.target.value as CurrencyCode)} className="input mt-xs">
                  {SUPPORTED_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            </div>
            <button disabled={creatingAsset} className="btn-primary w-full">
              {creatingAsset ? "Creating…" : "Create asset"}
            </button>
          </form>
        </div>

        <div className="panel-light overflow-hidden text-ink">
          <div className="border-b border-hairline-light p-lg">
            <h2 className="font-semibold">2 · Tokenize the asset</h2>
            <p className="text-xs text-muted">Set fractional supply and unit price</p>
          </div>
          <form onSubmit={createTokenization} className="space-y-md p-lg">
            <label className="block text-sm font-medium">Asset
              <select required value={assetId} onChange={(e) => setAssetId(e.target.value)} className="input mt-xs">
                <option value="">Select an asset…</option>
                {availableAssets.map((a) => (
                  <option key={a.id} value={a.id}>{ASSET_TYPE_LABEL[a.assetType]} · {a.assetRef}</option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-[1fr_auto] gap-sm">
              <label className="block text-sm font-medium">Face value
                <input required value={faceValue} onChange={(e) => setFaceValue(e.target.value)} placeholder="100000.00" inputMode="decimal" className="input mt-xs font-mono" />
              </label>
              <label className="block text-sm font-medium">Currency
                <select value={priceCurrency} onChange={(e) => setPriceCurrency(e.target.value as CurrencyCode)} className="input mt-xs">
                  {SUPPORTED_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            </div>
            <p className="text-xs leading-5 text-muted">What the debtor owes you at maturity. Investors advance a share of it now.</p>
            <label className="block text-sm font-medium">Total units
              <input required value={totalUnits} onChange={(e) => setTotalUnits(e.target.value)} placeholder="1000" inputMode="numeric" className="input mt-xs font-mono" />
            </label>
            <div className="grid grid-cols-2 gap-sm">
              <label className="block text-sm font-medium">Advance %
                <input required value={advanceRatePct} onChange={(e) => setAdvanceRatePct(e.target.value)} placeholder="80" inputMode="decimal" className="input mt-xs font-mono" />
              </label>
              <label className="block text-sm font-medium">Investor yield %
                <input required value={discountRatePct} onChange={(e) => setDiscountRatePct(e.target.value)} placeholder="4" inputMode="decimal" className="input mt-xs font-mono" />
              </label>
            </div>
            <label className="block text-sm font-medium">Maturity date
              <input required type="date" value={maturityDate} onChange={(e) => setMaturityDate(e.target.value)} className="input mt-xs font-mono" />
            </label>
            {financingPreview ? (
              <dl className="space-y-xs rounded-md border border-hairline-light bg-surface-soft-light p-md text-xs">
                <div className="flex justify-between gap-md"><dt className="text-muted">Raised from investors</dt><dd className="font-mono font-semibold">{financingPreview.principal}</dd></div>
                <div className="flex justify-between gap-md"><dt className="text-muted">You receive now</dt><dd className="font-mono font-semibold text-status-verified">{financingPreview.proceeds}</dd></div>
                <div className="flex justify-between gap-md"><dt className="text-muted">Price per unit</dt><dd className="font-mono">{financingPreview.unitPrice}</dd></div>
                <div className="flex justify-between gap-md border-t border-hairline-light pt-xs"><dt className="text-muted">Your residual at collection</dt><dd className="font-mono">{financingPreview.residual}</dd></div>
              </dl>
            ) : null}
            <label className="flex items-center gap-sm text-sm font-medium">
              <input type="checkbox" checked={requireAuth} onChange={(e) => setRequireAuth(e.target.checked)} className="h-4 w-4 rounded border-hairline-light" />
              Require holder authorization (compliance-controlled)
            </label>
            <button disabled={creatingToken} className="btn-primary w-full">
              {creatingToken ? "Creating…" : "Create tokenization"}
            </button>
            <p className="flex items-start gap-xs text-xs leading-5 text-muted">
              <Icon name="shield" className="mt-0.5 h-4 w-4 shrink-0" />
              Investors are repaid first at collection, then the platform fee, and you keep the residual. Late payment accrues extra yield from your residual.
            </p>
          </form>
        </div>
      </aside>
    </div>
  );
}

// ── Portfolio panel (investor holdings) ───────────────────────────────────────

function PortfolioPanel({ portfolio }: { portfolio: InvestorPortfolioResponse | null }) {
  if (!portfolio || portfolio.holdings.length === 0) {
    return (
      <div className="panel-dark px-lg py-xxl text-center">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-surface-elevated-dark text-muted"><Icon name="wallet" /></span>
        <h3 className="mt-md font-semibold text-on-dark">No holdings yet</h3>
        <p className="mx-auto mt-xs max-w-md text-sm text-muted">Invest in a tokenization from the marketplace to build your portfolio.</p>
      </div>
    );
  }

  return (
    <div>
      <section className="mb-lg grid gap-md sm:grid-cols-2">
        <Metric label="Total invested" value={formatMinor(portfolio.totalInvested, "USDC")} detail="Across all holdings" icon="wallet" />
        <Metric label="Payouts received" value={formatMinor(portfolio.totalPayoutsReceived, "USDC")} detail="Pro-rata distributions" icon="sparkles" />
      </section>
      <div className="space-y-md">
        {portfolio.holdings.map(({ holding, tokenization, asset }) => (
          <article key={holding.id} className="panel-dark p-md sm:p-lg">
            <div className="flex flex-wrap items-center justify-between gap-sm">
              <div className="flex items-center gap-sm">
                <StatusPill status={tokenization.status} />
                <span className="rounded-pill border border-hairline-dark px-sm py-xs text-xs font-medium capitalize text-muted-strong">
                  {ASSET_TYPE_LABEL[asset.assetType]}
                </span>
              </div>
              <span className="font-mono text-[11px] text-muted">{asset.assetRef}</span>
            </div>
            <p className="mt-md break-words font-mono text-xl font-semibold text-on-dark">
              {holding.units} units
              <span className="ml-sm text-sm font-normal text-muted">
                of {tokenization.totalUnits}
              </span>
            </p>
            <p className="mt-xs text-sm text-muted">{asset.description}</p>
            {holding.status === "pending" ? (
              // Under issuer custody the units are paid for and reserved, but
              // the issuer has not signed them over yet. Saying "you own this"
              // would be untrue, and the investor cannot chase what they are
              // not told about.
              <p className="mt-md flex items-start gap-xs rounded-lg bg-surface-elevated-dark p-sm text-xs leading-5 text-muted">
                <Icon name="clock" className="mt-0.5 h-4 w-4 shrink-0" />
                Awaiting delivery — the issuer holds these units until they sign
                the transfer. Payouts start once they do.
              </p>
            ) : null}
            <dl className="mt-md grid grid-cols-2 gap-md border-t border-hairline-dark pt-md sm:grid-cols-3">
              <Detail label="Invested" value={`${formatMinor(holding.purchaseAmount, holding.purchaseCurrency)} ${holding.purchaseCurrency}`} />
              <Detail label="Ownership" value={`${Number((BigInt(holding.units) * 10000n) / BigInt(tokenization.totalUnits)) / 100}%`} />
              <Detail label="Delivery" value={holding.status === "pending" ? "Pending" : "Settled"} />
              <Detail label="Authorized" value={holding.authorized ? "Yes" : "Pending"} />
            </dl>
          </article>
        ))}
      </div>
    </div>
  );
}

// ── Small presentational helpers ──────────────────────────────────────────────

function TabButton({
  current,
  value,
  onSelect,
  children,
}: {
  current: Tab;
  value: Tab;
  onSelect: (t: Tab) => void;
  children: React.ReactNode;
}) {
  const active = current === value;
  return (
    <button
      role="tab"
      aria-selected={active}
      type="button"
      onClick={() => onSelect(value)}
      className={`-mb-px min-h-11 whitespace-nowrap border-b-2 px-md py-sm text-sm font-medium transition-colors ${active ? "border-primary text-on-dark" : "border-transparent text-muted-strong hover:text-on-dark"}`}
    >
      {children}
    </button>
  );
}

function Metric({ label, value, detail, icon }: { label: string; value: string; detail: string; icon: "sparkles" | "document" | "wallet" }) {
  return (
    <div className="panel-dark flex items-center justify-between p-lg">
      <div>
        <p className="text-xs font-medium text-muted">{label}</p>
        <p className="mt-xs break-words font-mono text-xl font-semibold text-on-dark sm:text-2xl">{value}</p>
        <p className="mt-xs text-xs text-muted">{detail}</p>
      </div>
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-surface-elevated-dark text-muted-strong"><Icon name={icon} /></span>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="data-label">{label}</dt>
      <dd className="mt-xs text-xs font-medium text-body">{value}</dd>
    </div>
  );
}
