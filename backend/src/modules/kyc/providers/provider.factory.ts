/**
 * Selects the KYC provider adapter for this deployment.
 *
 * Adding a regulated vendor (Persona, Onfido) means writing a sibling adapter
 * and adding one case here. Nothing above the `KycProvider` boundary changes,
 * which is the point of the boundary.
 */
import { config } from "../../../config/index.js";
import type { KycProvider } from "./kyc-provider.js";
import { SandboxKycProvider } from "./sandbox.provider.js";
import { SumsubKycProvider } from "./sumsub.provider.js";

export function createKycProvider(): KycProvider {
  switch (config.KYC_PROVIDER) {
    case "sumsub":
      return new SumsubKycProvider();
    case "sandbox":
      return new SandboxKycProvider();
  }
}
