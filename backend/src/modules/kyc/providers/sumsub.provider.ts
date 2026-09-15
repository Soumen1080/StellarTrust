/**
 * Sumsub KYC/KYB provider adapter.
 *
 * The first real provider behind the `KycProvider` boundary. It performs the
 * verification the sandbox adapter only simulates: the document and selfie
 * bytes are handed to a regulated vendor that runs document authentication,
 * OCR, face comparison, liveness, and sanctions/PEP screening, and returns
 * findings this adapter normalizes into the platform's own check vocabulary.
 *
 * The shape of the integration matters as much as the vendor choice:
 *
 *  - **The platform's decision engine still decides.** This adapter returns
 *    normalized checks and risk signals, never a verdict. Approval remains the
 *    business of `kyc-decision.engine.ts` and, above the risk threshold, a
 *    human reviewer. A vendor saying "green" does not auto-approve anyone.
 *  - **Images are sent, never stored twice.** The bytes are read from the
 *    private bucket through a short-lived signed URL and streamed to the
 *    vendor. This adapter persists nothing.
 *  - **Applicant identifiers are opaque.** The vendor sees a per-application
 *    external id, not a platform user id, so a leak on either side does not
 *    join the two datasets.
 *
 * Swapping to Persona/Onfido means writing a sibling of this file and adding
 * one case to the factory. Nothing above the boundary changes.
 */
import { createHmac, randomUUID } from "node:crypto";
import {
  ProviderCheckStatus,
  type KycApplicationInput,
  type KycProviderChecks,
} from "@stellartrust/shared";
import { config } from "../../../config/index.js";
import { ExternalServiceError } from "../../../lib/errors.js";
import { logger } from "../../../lib/logger.js";
import { signCaptureUrl } from "../document-storage.service.js";
import type {
  KycProvider,
  KycProviderResult,
  RiskSignal,
} from "./kyc-provider.js";

/** Sumsub review answers, normalized below into ProviderCheckStatus. */
type ReviewAnswer = "GREEN" | "RED" | "YELLOW";

interface SumsubApplicantStatus {
  reviewResult?: {
    reviewAnswer?: ReviewAnswer;
    rejectLabels?: string[];
    reviewRejectType?: "FINAL" | "RETRY";
  };
  reviewStatus?: string;
}

/**
 * Maps a vendor finding onto the platform's three-state check.
 *
 * A RETRY rejection is `Review`, not `Fail`: the vendor is saying the capture
 * was unusable, which is a request for a better photograph rather than a
 * judgment about the person.
 */
function answerToStatus(
  answer: ReviewAnswer | undefined,
  rejectType?: "FINAL" | "RETRY",
): ProviderCheckStatus {
  if (answer === "GREEN") return ProviderCheckStatus.Pass;
  if (answer === "RED") {
    return rejectType === "RETRY"
      ? ProviderCheckStatus.Review
      : ProviderCheckStatus.Fail;
  }
  return ProviderCheckStatus.Review;
}

/**
 * Reject labels that indicate a specific failed check rather than a general
 * decline. Used to attribute a rejection to the check that caused it, so a
 * reviewer sees "liveness failed" rather than an undifferentiated red.
 */
const LABEL_TO_CHECK: Record<string, keyof KycProviderChecks> = {
  FORGERY: "document",
  DOCUMENT_TEMPLATE: "document",
  DOCUMENT_PAGE_MISSING: "document",
  SCREENSHOT: "document",
  BLACK_AND_WHITE: "document",
  BAD_PHOTO_QUALITY: "ocr",
  UNSATISFACTORY_PHOTOS: "ocr",
  WRONG_USER_REGION: "ocr",
  SELFIE_MISMATCH: "faceMatch",
  FACE_MISMATCH: "faceMatch",
  LIVENESS_FAILED: "liveness",
  SPOOFING_ATTEMPT: "liveness",
  DB_DATA_MISMATCH: "aml",
  SANCTIONS: "aml",
  PEP: "aml",
  ADVERSE_MEDIA: "aml",
  CRIMINAL: "aml",
};

const SANCTIONS_LABELS = new Set([
  "SANCTIONS",
  "PEP",
  "ADVERSE_MEDIA",
  "CRIMINAL",
]);

export class SumsubKycProvider implements KycProvider {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly secret: string;
  private readonly levelName: string;

  constructor() {
    const { SUMSUB_BASE_URL, SUMSUB_APP_TOKEN, SUMSUB_SECRET_KEY, SUMSUB_LEVEL_NAME } =
      config;
    if (!SUMSUB_APP_TOKEN || !SUMSUB_SECRET_KEY) {
      throw new Error(
        "KYC_PROVIDER=sumsub requires SUMSUB_APP_TOKEN and SUMSUB_SECRET_KEY.",
      );
    }
    this.baseUrl = SUMSUB_BASE_URL;
    this.token = SUMSUB_APP_TOKEN;
    this.secret = SUMSUB_SECRET_KEY;
    this.levelName = SUMSUB_LEVEL_NAME;
  }

  /**
   * Signs a request per Sumsub's HMAC scheme.
   *
   * The signature covers timestamp + method + path + body, so a captured
   * request cannot be replayed against a different endpoint.
   */
  private headers(
    method: string,
    path: string,
    body: string | Buffer = "",
  ): Record<string, string> {
    const ts = Math.floor(Date.now() / 1000).toString();
    const hmac = createHmac("sha256", this.secret)
      .update(ts)
      .update(method.toUpperCase())
      .update(path);
    if (body.length > 0) {
      hmac.update(typeof body === "string" ? Buffer.from(body) : body);
    }
    return {
      "X-App-Token": this.token,
      "X-App-Access-Ts": ts,
      "X-App-Access-Sig": hmac.digest("hex"),
    };
  }

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...this.headers(method, path, payload),
        ...(payload ? { "content-type": "application/json" } : {}),
      },
      body: payload || undefined,
      signal: AbortSignal.timeout(config.KYC_PROVIDER_TIMEOUT_MS),
    });

    if (!response.ok) {
      // The body may carry PII-adjacent detail; only the status is logged.
      logger.warn(
        { status: response.status, path },
        "sumsub: request failed",
      );
      throw new ExternalServiceError(
        "The identity verification provider could not process this application",
      );
    }
    return (await response.json()) as T;
  }

  /** Streams one stored capture to the applicant as an ID document. */
  private async uploadCapture(
    applicantId: string,
    reference: string,
    docType: string,
    country: string,
    side?: "FRONT" | "BACK",
  ): Promise<void> {
    const signedUrl = await signCaptureUrl(reference, 120);
    const imageResponse = await fetch(signedUrl, {
      signal: AbortSignal.timeout(config.KYC_PROVIDER_TIMEOUT_MS),
    });
    if (!imageResponse.ok) {
      throw new ExternalServiceError("Could not read the stored document image");
    }
    const bytes = Buffer.from(await imageResponse.arrayBuffer());

    const path = `/resources/applicants/${applicantId}/info/idDoc`;
    const metadata = JSON.stringify({
      idDocType: docType,
      country,
      ...(side ? { idDocSubType: side } : {}),
    });

    const form = new FormData();
    form.append("metadata", metadata);
    form.append(
      "content",
      new Blob([bytes], { type: imageResponse.headers.get("content-type") ?? "image/jpeg" }),
      "capture.jpg",
    );

    // Multipart bodies are excluded from the HMAC payload per Sumsub's spec.
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers("POST", path),
      body: form,
      signal: AbortSignal.timeout(config.KYC_PROVIDER_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn({ status: response.status }, "sumsub: capture upload failed");
      throw new ExternalServiceError("Could not submit the document for review");
    }
  }

  async submit(input: KycApplicationInput): Promise<KycProviderResult> {
    // Opaque to the vendor: it identifies this application, not this person.
    const externalUserId = randomUUID();

    const applicant = await this.call<{ id: string }>(
      "POST",
      `/resources/applicants?levelName=${encodeURIComponent(this.levelName)}`,
      {
        externalUserId,
        info: {
          country: input.country,
          ...(input.dateOfBirth ? { dob: input.dateOfBirth } : {}),
          ...(input.legalName ? { firstName: input.legalName } : {}),
        },
      },
    );

    const docType =
      input.document.kind === "passport"
        ? "PASSPORT"
        : input.document.kind === "drivers_license"
          ? "DRIVERS"
          : "ID_CARD";

    await this.uploadCapture(
      applicant.id,
      input.document.frontImageRef,
      docType,
      input.document.issuingCountry,
      "FRONT",
    );
    if (input.document.backImageRef) {
      await this.uploadCapture(
        applicant.id,
        input.document.backImageRef,
        docType,
        input.document.issuingCountry,
        "BACK",
      );
    }
    await this.uploadCapture(
      applicant.id,
      input.faceImageRef,
      "SELFIE",
      input.document.issuingCountry,
    );

    await this.call(
      "POST",
      `/resources/applicants/${applicant.id}/status/pending?reasonCode=null`,
    );

    const status = await this.call<SumsubApplicantStatus>(
      "GET",
      `/resources/applicants/${applicant.id}/status`,
    );

    return this.normalize(applicant.id, status, input);
  }

  /**
   * Turns a vendor verdict into the platform's own check vocabulary.
   *
   * When the vendor is still reviewing — the common case, since document
   * review is not instantaneous — every check is `Review` and the application
   * lands in the human queue rather than being decided on absent evidence.
   */
  private normalize(
    applicantId: string,
    status: SumsubApplicantStatus,
    input: KycApplicationInput,
  ): KycProviderResult {
    const answer = status.reviewResult?.reviewAnswer;
    const rejectType = status.reviewResult?.reviewRejectType;
    const labels = status.reviewResult?.rejectLabels ?? [];
    const overall = answerToStatus(answer, rejectType);

    const checks: KycProviderChecks = {
      document: overall,
      ocr: overall,
      faceMatch: overall,
      liveness: overall,
      aml: overall,
    };

    // Attribute a rejection to the specific check that caused it.
    for (const label of labels) {
      const target = LABEL_TO_CHECK[label];
      if (target) {
        checks[target] =
          rejectType === "RETRY"
            ? ProviderCheckStatus.Review
            : ProviderCheckStatus.Fail;
      }
    }

    // An expired document is a fact the vendor may not flag; the platform
    // checks it independently, as the sandbox adapter does.
    if (new Date(input.document.expiryDate).getTime() <= Date.now()) {
      checks.document = ProviderCheckStatus.Fail;
    }

    const sanctionsHit = labels.some((label) => SANCTIONS_LABELS.has(label));
    if (sanctionsHit) checks.aml = ProviderCheckStatus.Fail;

    const riskSignals: RiskSignal[] = Object.entries(checks).map(
      ([name, value]) => ({
        name,
        value:
          value === ProviderCheckStatus.Fail
            ? 0.95
            : value === ProviderCheckStatus.Review
              ? 0.5
              : 0.05,
      }),
    );

    return {
      provider: "sumsub",
      providerReference: applicantId,
      checks,
      riskSignals,
      sanctionsHit,
    };
  }
}
