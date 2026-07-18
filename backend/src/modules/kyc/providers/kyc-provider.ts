/** Normalized KYC provider boundary (sandbox -> regulated live provider). */
import type {
  KycApplicationInput,
  KycProviderChecks,
} from "@stellartrust/shared";

export interface RiskSignal {
  name: string;
  /** 0..1 where higher means higher risk. */
  value: number;
}

export interface KycProviderResult {
  provider: string;
  providerReference: string;
  checks: KycProviderChecks;
  riskSignals: RiskSignal[];
  sanctionsHit: boolean;
}

export interface KycProvider {
  submit(input: KycApplicationInput): Promise<KycProviderResult>;
}
