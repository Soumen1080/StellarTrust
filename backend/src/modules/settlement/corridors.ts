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
  type CorridorDTO,
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
): CorridorDTO {
  return {
    id: corridorId(source, destination),
    sourceCurrency: source,
    destinationCurrency: destination,
    anchorId: seed.anchorId,
    anchorName: seed.anchorName,
    bridgeAsset: BRIDGE_ASSET,
    anchorProtocol: seed.protocol,
    estimatedSeconds: seed.estimatedSeconds,
  };
}

const CORRIDOR_MAP: ReadonlyMap<string, CorridorDTO> = (() => {
  const map = new Map<string, CorridorDTO>();
  for (const seed of SEEDS) {
    const forward = toDTO(seed, seed.source, seed.destination);
    const reverse = toDTO(seed, seed.destination, seed.source);
    map.set(forward.id, forward);
    // Do not overwrite a directed corridor that already exists.
    if (!map.has(reverse.id)) map.set(reverse.id, reverse);
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
