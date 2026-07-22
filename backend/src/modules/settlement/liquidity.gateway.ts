/**
 * Liquidity boundary (Phase 3 — Cross-Border Settlement).
 *
 * Cross-currency conversion runs on CLASSIC Stellar — path payments and AMM
 * liquidity pools — never Soroban (Rules.md #3). This adapter is wrapped behind
 * an interface so the deterministic local model can be swapped for a Horizon
 * path-finding + AMM client without touching the routing/settlement services.
 *
 * All money math uses integer minor units with BigInt (Decision D12: no floats).
 * The double-entry ledger — not the chain — remains the system of record.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  ChainTxStatus,
  CURRENCY_SCALE,
  RouteType,
  type CurrencyCode,
  type RouteHop,
  type SettlementRouteDTO,
} from "@stellartrust/shared";
import { config } from "../../config/index.js";
import { ChainError } from "../../lib/errors.js";

/** Mid-market price of one whole currency unit expressed in USD, as a fraction. */
interface UsdPrice {
  num: bigint;
  den: bigint;
}

// Indicative testnet/sandbox mid-market prices (USD per 1 whole unit). These are
// deterministic reference rates for local development, not a live feed.
const USD_PRICES: Record<CurrencyCode, UsdPrice> = {
  USD: { num: 1n, den: 1n },
  USDC: { num: 1n, den: 1n },
  EUR: { num: 108n, den: 100n },
  INR: { num: 1n, den: 83n },
  NGN: { num: 1n, den: 1600n },
  XLM: { num: 12n, den: 100n },
};

interface RouteModel {
  type: RouteType;
  /** Liquidity/protocol fee retained on the source side, in basis points. */
  feeBps: bigint;
  /** Rate degradation (slippage) applied to the mid-market output, in bps. */
  slippageBps: number;
  estimatedSeconds: number;
}

// Two liquidity mechanisms with different economics. Path payments quote tighter
// (deeper order-book liquidity) than the AMM pool, so routing has a real choice.
const ROUTE_MODELS: RouteModel[] = [
  {
    type: RouteType.PathPayment,
    feeBps: 10n,
    slippageBps: 8,
    estimatedSeconds: 6,
  },
  {
    type: RouteType.Amm,
    feeBps: 30n,
    slippageBps: 25,
    estimatedSeconds: 4,
  },
];

const BPS_DENOMINATOR = 10_000n;

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/**
 * Convert an integer minor-unit amount from one currency to another at the
 * deterministic mid-market rate, using exact rational BigInt arithmetic and
 * flooring the result. Accounts for differing minor-unit scales per currency.
 */
export function convertMinorUnits(
  amount: bigint,
  from: CurrencyCode,
  to: CurrencyCode,
): bigint {
  if (amount < 0n) throw new ChainError("Conversion amount must be non-negative");
  if (from === to) return amount;
  const priceFrom = USD_PRICES[from];
  const priceTo = USD_PRICES[to];
  const scaleFrom = CURRENCY_SCALE[from];
  const scaleTo = CURRENCY_SCALE[to];
  const scaleDelta = scaleTo - scaleFrom;

  // destMinor = amount * (priceFrom.num/priceFrom.den) * (priceTo.den/priceTo.num) * 10^scaleDelta
  let numerator = amount * priceFrom.num * priceTo.den;
  let denominator = priceFrom.den * priceTo.num;
  if (scaleDelta >= 0) numerator *= pow10(scaleDelta);
  else denominator *= pow10(-scaleDelta);

  return numerator / denominator;
}

/** Indicative destination-per-source price string for display (6 dp). */
function priceString(from: CurrencyCode, to: CurrencyCode): string {
  const scaleFrom = CURRENCY_SCALE[from];
  const oneUnit = pow10(scaleFrom); // 1 whole source unit in minor units
  const destMinor = convertMinorUnits(oneUnit, from, to);
  const destWhole = Number(destMinor) / 10 ** CURRENCY_SCALE[to];
  return destWhole.toFixed(6);
}

export interface LiquidityReceipt {
  hash: string;
  type: string;
  status: ChainTxStatus;
  routeType: RouteType;
  fromCurrency: CurrencyCode;
  toCurrency: CurrencyCode;
  sourceAmount: string;
  destinationAmount: string;
  feeAmount: string;
}

export interface LiquidityGateway {
  /** Return every costed candidate route for a corridor, unordered. */
  quoteRoutes(
    source: CurrencyCode,
    destination: CurrencyCode,
    sourceAmount: string,
  ): Promise<SettlementRouteDTO[]>;
  /** Execute a conversion on the selected route; returns a chain receipt. */
  executeConversion(
    route: SettlementRouteDTO,
    bridgeAsset: CurrencyCode,
  ): Promise<LiquidityReceipt>;
}

/**
 * Deterministic local liquidity model. Reproduces path-payment vs AMM economics
 * without touching Horizon. Staging/production must replace this with a Horizon
 * path-finding + AMM adapter (LIQUIDITY_GATEWAY=horizon).
 */
export class DeterministicLiquidityGateway implements LiquidityGateway {
  async quoteRoutes(
    source: CurrencyCode,
    destination: CurrencyCode,
    sourceAmount: string,
  ): Promise<SettlementRouteDTO[]> {
    const amount = BigInt(sourceAmount);
    return ROUTE_MODELS.map((model) => this.costRoute(model, source, destination, amount));
  }

  private costRoute(
    model: RouteModel,
    source: CurrencyCode,
    destination: CurrencyCode,
    amount: bigint,
  ): SettlementRouteDTO {
    const fee = (amount * model.feeBps) / BPS_DENOMINATOR;
    const netSource = amount - fee;
    const midDestination = convertMinorUnits(netSource, source, destination);
    // Apply slippage (rate degradation) to the mid-market output.
    const destinationAmount =
      (midDestination * (BPS_DENOMINATOR - BigInt(model.slippageBps))) /
      BPS_DENOMINATOR;

    const effectiveRate =
      amount === 0n
        ? "0"
        : (
            Number(destinationAmount) /
            10 ** CURRENCY_SCALE[destination] /
            (Number(amount) / 10 ** CURRENCY_SCALE[source])
          ).toFixed(6);

    const hops: RouteHop[] = [
      {
        type: model.type,
        fromCurrency: source,
        toCurrency: destination,
        price: priceString(source, destination),
      },
    ];

    return {
      type: model.type,
      hops,
      source: { amount: amount.toString(), currency: source },
      destinationAmount: {
        amount: destinationAmount.toString(),
        currency: destination,
      },
      fee: { amount: fee.toString(), currency: source },
      effectiveRate,
      slippageBps: model.slippageBps,
      estimatedSeconds: model.estimatedSeconds,
    };
  }

  async executeConversion(
    route: SettlementRouteDTO,
    _bridgeAsset: CurrencyCode,
  ): Promise<LiquidityReceipt> {
    const digest = createHash("sha256")
      .update(
        `${route.type}:${route.source.currency}:${route.destinationAmount.currency}:${route.source.amount}:${randomUUID()}`,
      )
      .digest("hex");
    return {
      hash: digest,
      type: `liquidity_${route.type}`,
      status: ChainTxStatus.Success,
      routeType: route.type,
      fromCurrency: route.source.currency,
      toCurrency: route.destinationAmount.currency,
      sourceAmount: route.source.amount,
      destinationAmount: route.destinationAmount.amount,
      feeAmount: route.fee.amount,
    };
  }
}

/** Fail closed rather than running a synthetic liquidity model outside dev/test. */
export function createLiquidityGateway(): LiquidityGateway {
  if (config.LIQUIDITY_GATEWAY === "deterministic") {
    if (config.NODE_ENV === "staging" || config.NODE_ENV === "production") {
      throw new ChainError(
        "LIQUIDITY_GATEWAY=deterministic is forbidden outside development/test",
      );
    }
    return new DeterministicLiquidityGateway();
  }
  throw new ChainError(
    "LIQUIDITY_GATEWAY=horizon requires the Horizon path-finding + AMM adapter",
  );
}
