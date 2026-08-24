/**
 * Supported settlement corridors (Phase 3).
 *
 * A corridor is a directed source→destination currency pair served by a
 * controlled sandbox anchor and bridged on-chain through a Stellar asset
 * (USDC on testnet). Launch corridors are an open product decision
 * (Memory.md §5); this curated catalog is the local/sandbox set. Each entry is
 * deterministic so quotes and routing are reproducible for tests and audit.
 */
import {
  AnchorProtocol,
  CurrencyCode,
  payoutCountryForCurrency,
  railsForCurrency,
  type CorridorDTO,
  type PayoutRailSpec,
} from "@stellartrust/shared";

interface CorridorSeed {
  source: CurrencyCode;
  destination: CurrencyCode;
  anchorId: string;
  anchorName: string;
  protocol: AnchorProtocol;
  estimatedSeconds: number;
}

// Bidirectional corridors are expanded from these directed seeds.
const SEEDS: CorridorSeed[] = [
  {
    source: CurrencyCode.USD,
    destination: CurrencyCode.INR,
    anchorId: "sandbox-in",
    anchorName: "Sandbox India Ramp",
    protocol: AnchorProtocol.Sep31,
    estimatedSeconds: 45,
  },
  {
    source: CurrencyCode.USD,
    destination: CurrencyCode.EUR,
    anchorId: "sandbox-eu",
    anchorName: "Sandbox Euro Ramp",
    protocol: AnchorProtocol.Sep24,
    estimatedSeconds: 30,
  },
  {
    source: CurrencyCode.USD,
    destination: CurrencyCode.NGN,
    anchorId: "sandbox-ng",
    anchorName: "Sandbox Nigeria Ramp",
    protocol: AnchorProtocol.Sep31,
    estimatedSeconds: 60,
  },
  {
    source: CurrencyCode.EUR,
    destination: CurrencyCode.INR,
    anchorId: "sandbox-in",
    anchorName: "Sandbox India Ramp",
    protocol: AnchorProtocol.Sep31,
    estimatedSeconds: 50,
  },
];

const BRIDGE_ASSET = CurrencyCode.USDC;

function corridorId(source: CurrencyCode, destination: CurrencyCode): string {
  return `${source}-${destination}`;
}

function toDTO(
  seed: CorridorSeed,
  source: CurrencyCode,
  destination: CurrencyCode,
): CorridorDTO | undefined {
  // A corridor is only real if fiat can actually be delivered on the far side.
  // Without a local rail the transfer would convert on-chain and then strand at
  // the anchor, so an unserviceable direction is dropped from the catalog
  // rather than offered and failed at payout time.
  const country = payoutCountryForCurrency(destination);
  const rails = railsForCurrency(destination);
  if (!country || rails.length === 0) return undefined;

  return {
    id: corridorId(source, destination),
    sourceCurrency: source,
    destinationCurrency: destination,
    anchorId: seed.anchorId,
    anchorName: seed.anchorName,
    bridgeAsset: BRIDGE_ASSET,
    anchorProtocol: seed.protocol,
    estimatedSeconds: seed.estimatedSeconds,
    destinationCountry: country,
    payoutRails: rails as PayoutRailSpec[],
  };
}

const CORRIDOR_MAP: ReadonlyMap<string, CorridorDTO> = (() => {
  const map = new Map<string, CorridorDTO>();
  for (const seed of SEEDS) {
    const forward = toDTO(seed, seed.source, seed.destination);
    const reverse = toDTO(seed, seed.destination, seed.source);
    if (forward) map.set(forward.id, forward);
    // Do not overwrite a directed corridor that already exists.
    if (reverse && !map.has(reverse.id)) map.set(reverse.id, reverse);
  }
  return map;
})();

export const CORRIDORS: readonly CorridorDTO[] = [...CORRIDOR_MAP.values()];

export function findCorridor(
  source: CurrencyCode,
  destination: CurrencyCode,
): CorridorDTO | undefined {
  return CORRIDOR_MAP.get(corridorId(source, destination));
}

export function findCorridorById(id: string): CorridorDTO | undefined {
  return CORRIDOR_MAP.get(id);
}

/**
 * The rail a corridor delivers on when the caller does not choose one: the
 * fastest scheme serving the destination currency (rails are stored fastest
 * first). UPI for India, SEPA Instant for the euro area, NIP for Nigeria.
 */
export function defaultRailFor(corridor: CorridorDTO): PayoutRailSpec {
  const rail = corridor.payoutRails[0];
  if (!rail) {
    throw new Error(`Corridor ${corridor.id} has no payout rail`);
  }
  return rail;
}

/** The corridor's spec for a rail, or undefined if that rail is not offered. */
export function railForCorridor(
  corridor: CorridorDTO,
  rail: string,
): PayoutRailSpec | undefined {
  return corridor.payoutRails.find((spec) => spec.rail === rail);
}
