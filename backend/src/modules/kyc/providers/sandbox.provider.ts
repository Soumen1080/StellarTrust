/**
 * Deterministic Phase 1 KYC/KYB sandbox provider.
 *
 * Fixture controls use opaque references so tests/UI can exercise every branch:
 *   sandbox://document/pass|review|fail
 *   sandbox://face/pass|review|fail
 *   document number beginning `AML-HIT-` simulates a sanctions/AML match
 *
 * The adapter returns normalized checks/signals only. It never logs or persists
 * the input, document number, date of birth, or image references.
 */
import { randomUUID } from "node:crypto";
import {
  ProviderCheckStatus,
  type KycApplicationInput,
  type KycProviderChecks,
} from "@stellartrust/shared";
import type {
  KycProvider,
  KycProviderResult,
  RiskSignal,
} from "./kyc-provider.js";

function fixtureStatus(
  reference: string,
): (typeof ProviderCheckStatus)[keyof typeof ProviderCheckStatus] {
  const normalized = reference.toLowerCase();
  if (normalized.includes("/fail")) return ProviderCheckStatus.Fail;
  if (normalized.includes("/review")) return ProviderCheckStatus.Review;
  return ProviderCheckStatus.Pass;
}

function riskFor(
  status: (typeof ProviderCheckStatus)[keyof typeof ProviderCheckStatus],
): number {
  if (status === ProviderCheckStatus.Fail) return 0.95;
  if (status === ProviderCheckStatus.Review) return 0.5;
  return 0.05;
}

export class SandboxKycProvider implements KycProvider {
  async submit(input: KycApplicationInput): Promise<KycProviderResult> {
    const document = fixtureStatus(input.document.frontImageRef);
    const ocr = input.document.frontImageRef.toLowerCase().includes("ocr-review")
      ? ProviderCheckStatus.Review
      : document;
    const faceMatch = fixtureStatus(input.faceImageRef);
    const liveness = input.faceImageRef.toLowerCase().includes("liveness-fail")
      ? ProviderCheckStatus.Fail
      : faceMatch;
    const expired = new Date(input.document.expiryDate).getTime() <= Date.now();
    const sanctionsHit = input.document.number
      .toUpperCase()
      .startsWith("AML-HIT-");
    const aml = sanctionsHit
      ? ProviderCheckStatus.Fail
      : ProviderCheckStatus.Pass;

    const checks: KycProviderChecks = {
      document: expired ? ProviderCheckStatus.Fail : document,
      ocr,
      faceMatch,
      liveness,
      aml,
    };
    const riskSignals: RiskSignal[] = Object.entries(checks).map(
      ([name, status]) => ({ name, value: riskFor(status) }),
    );
    if (expired) riskSignals.push({ name: "document_expired", value: 1 });

    return {
      provider: "sandbox",
      providerReference: `sandbox-${randomUUID()}`,
      checks,
      riskSignals,
      sanctionsHit,
    };
  }
}
