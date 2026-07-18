import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { InMemoryAuditRepository } from "../src/modules/audit/audit.repository.js";
import { InMemoryIdentityRepository } from "../src/modules/identity/identity.repository.js";
import { InMemoryKycRepository } from "../src/modules/kyc/kyc.repository.js";
import { DeterministicKycRiskClient } from "../src/modules/kyc/kyc-risk.client.js";
import { KycService } from "../src/modules/kyc/kyc.service.js";
import { SandboxKycProvider } from "../src/modules/kyc/providers/sandbox.provider.js";

describe("KYC audit safety", () => {
  it("audit-logs AI and human decisions without PII", async () => {
    const identities = new InMemoryIdentityRepository();
    const { user } = await identities.upsertWalletIdentity(
      Keypair.random().publicKey(),
    );
    const audit = new InMemoryAuditRepository();
    const service = new KycService(
      new SandboxKycProvider(),
      new DeterministicKycRiskClient(),
      new InMemoryKycRepository(),
      identities,
      audit,
    );
    const submitted = await service.submit(user.id, {
      applicantType: "individual",
      email: "private.person@example.test",
      legalName: "Private Person",
      country: "US",
      dateOfBirth: "1990-01-01",
      document: {
        kind: "passport",
        issuingCountry: "US",
        number: "SECRET-DOCUMENT-123",
        expiryDate: "2099-01-01",
        frontImageRef: "sandbox://document/review",
      },
      faceImageRef: "sandbox://face/pass",
    });
    expect(submitted.reviewId).toBeTruthy();

    await service.resolveReview(submitted.reviewId!, "compliance-user", {
      decision: "approve",
      reason: "Manually verified against provider portal",
    });

    const events = await audit.listForEntity(
      "kyc_verification",
      submitted.verificationId,
    );
    expect(events.map((event) => event.action)).toEqual([
      "kyc.submitted",
      "kyc.review",
      "kyc.human_approve",
    ]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("private.person@example.test");
    expect(serialized).not.toContain("Private Person");
    expect(serialized).not.toContain("SECRET-DOCUMENT-123");
    expect(serialized).not.toContain("sandbox://document/review");
  });
});
