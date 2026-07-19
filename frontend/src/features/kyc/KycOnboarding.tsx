"use client";

import {
  ApplicantType,
  type AuthSessionResponse,
  type IdentityProfileResponse,
  type KycApplicationResponse,
} from "@stellartrust/shared";
import { type FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { loadSession } from "@/lib/wallet-auth";

type SandboxScenario = "pass" | "review" | "fail" | "aml-hit";

export function KycOnboarding() {
  const [session, setSession] = useState<AuthSessionResponse | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [profile, setProfile] = useState<IdentityProfileResponse | null>(null);
  const [result, setResult] = useState<KycApplicationResponse | null>(null);
  const [applicantType, setApplicantType] = useState<"individual" | "business">(
    ApplicantType.Individual,
  );
  const [scenario, setScenario] = useState<SandboxScenario>("pass");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const currentSession = loadSession();
    setSession(currentSession);
    setSessionChecked(true);
    if (!currentSession) return;
    void api
      .getIdentity(currentSession.accessToken)
      .then((identity) => {
        setProfile(identity);
        setResult(identity.latestVerification);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Could not load profile"),
      );
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) {
      setError("Connect and sign in with your Stellar wallet first.");
      return;
    }

    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const isAmlHit = scenario === "aml-hit";
    const visualScenario = scenario === "aml-hit" ? "pass" : scenario;
    try {
      const response = await api.submitKyc(
        session.accessToken,
        window.crypto.randomUUID(),
        {
          applicantType,
          email: String(form.get("email")),
          legalName: String(form.get("legalName")),
          country: String(form.get("country")).toUpperCase(),
          dateOfBirth:
            applicantType === ApplicantType.Individual
              ? String(form.get("dateOfBirth"))
              : undefined,
          registrationNumber:
            applicantType === ApplicantType.Business
              ? String(form.get("registrationNumber"))
              : undefined,
          businessName:
            applicantType === ApplicantType.Business
              ? String(form.get("businessName"))
              : undefined,
          document: {
            kind: "passport",
            issuingCountry: String(form.get("country")).toUpperCase(),
            number: isAmlHit
              ? `AML-HIT-${String(form.get("documentNumber"))}`
              : String(form.get("documentNumber")),
            expiryDate: String(form.get("expiryDate")),
            frontImageRef: `sandbox://document/${visualScenario}`,
          },
          faceImageRef: `sandbox://face/${visualScenario}`,
        },
      );
      setResult(response);
      setProfile(await api.getIdentity(session.accessToken));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setPending(false);
    }
  }

  if (!sessionChecked) {
    return <p className="text-sm text-muted">Loading wallet session…</p>;
  }

  if (!session) {
    return (
      <section className="rounded-xl border border-hairline-light bg-white p-xl">
        <h1 className="text-2xl font-semibold">Identity verification</h1>
        <p className="mt-sm text-sm text-muted">
          Connect and sign a SEP-10 challenge from the home page before starting
          KYC/KYB.
        </p>
        <Link
          href="/"
          className="mt-lg inline-block rounded-md bg-primary px-lg py-sm text-sm font-semibold text-on-primary"
        >
          Connect wallet
        </Link>
      </section>
    );
  }

  return (
    <div className="grid gap-lg lg:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
      <form
        onSubmit={submit}
        className="rounded-xl border border-hairline-light bg-white p-xl"
      >
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">
          Sandbox KYC/KYB
        </p>
        <h1 className="mt-xs text-2xl font-semibold">Verify your identity</h1>
        <p className="mt-sm text-sm text-muted">
          Test ID + OCR + face + liveness + AML checks. Raw document values are
          not written to application logs or the project database.
        </p>

        <div className="mt-lg grid gap-md sm:grid-cols-2">
          <Field label="Applicant type">
            <select
              value={applicantType}
              onChange={(event) =>
                setApplicantType(
                  event.target.value as "individual" | "business",
                )
              }
              className="input"
            >
              <option value="individual">Individual</option>
              <option value="business">Business</option>
            </select>
          </Field>
          <Field label="Sandbox outcome">
            <select
              value={scenario}
              onChange={(event) =>
                setScenario(event.target.value as SandboxScenario)
              }
              className="input"
            >
              <option value="pass">Pass</option>
              <option value="review">Borderline → human review</option>
              <option value="fail">Provider hard-fail → human review</option>
              <option value="aml-hit">AML hit → compliance review</option>
            </select>
          </Field>
          <Field label="Email">
            <input name="email" type="email" required className="input" />
          </Field>
          <Field label="Legal name">
            <input name="legalName" required className="input" />
          </Field>
          <Field label="Country (ISO-2)">
            <input
              name="country"
              required
              minLength={2}
              maxLength={2}
              defaultValue="US"
              className="input uppercase"
            />
          </Field>
          {applicantType === ApplicantType.Individual ? (
            <Field label="Date of birth">
              <input name="dateOfBirth" type="date" required className="input" />
            </Field>
          ) : (
            <>
              <Field label="Business name">
                <input name="businessName" required className="input" />
              </Field>
              <Field label="Registration number">
                <input name="registrationNumber" required className="input" />
              </Field>
            </>
          )}
          <Field label="Passport / ID number">
            <input name="documentNumber" required minLength={4} className="input" />
          </Field>
          <Field label="Document expiry">
            <input
              name="expiryDate"
              type="date"
              required
              defaultValue="2099-01-01"
              className="input"
            />
          </Field>
        </div>

        {error ? (
          <p role="alert" className="mt-md text-sm text-status-refunded">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={pending}
          className="mt-lg rounded-md bg-primary px-lg py-sm text-sm font-semibold text-on-primary disabled:bg-primary-disabled disabled:text-muted"
        >
          {pending ? "Running provider checks…" : "Submit verification"}
        </button>
      </form>

      <aside className="space-y-lg">
        <section className="rounded-xl border border-hairline-light bg-white p-lg">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">
            Profile status
          </p>
          <div className="mt-sm">
            {profile ? (
              <StatusPill status={profile.user.kycStatus} />
            ) : (
              <span className="text-sm text-muted">Loading…</span>
            )}
          </div>
          {profile?.wallets[0] ? (
            <p className="mt-md break-all font-mono text-xs text-muted">
              {profile.wallets[0].stellarPublicKey}
            </p>
          ) : null}
          {profile?.business ? (
            <p className="mt-md text-sm font-medium">
              {profile.business.legalName}
            </p>
          ) : null}
        </section>

        {result ? (
          <section className="rounded-xl bg-surface-card-dark p-lg text-body">
            <div className="flex items-center justify-between gap-sm">
              <span className="rounded-pill border border-status-review px-sm py-xxs text-xs text-status-review">
                Advisory
              </span>
              <StatusPill status={result.status} />
            </div>
            <p className="mt-md font-mono text-sm">
              Confidence {(result.advisory.confidence * 100).toFixed(0)}%
            </p>
            <p className="mt-sm text-sm text-muted-strong">
              {result.advisory.explanation}
            </p>
            <ul className="mt-md space-y-xs text-xs text-muted">
              {result.advisory.signals.map((signal) => (
                <li key={signal}>• {signal}</li>
              ))}
            </ul>
            {result.reviewId ? (
              <p className="mt-md text-xs text-status-review">
                Queued for human review · {result.reviewId}
              </p>
            ) : null}
          </section>
        ) : null}
      </aside>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm font-medium">
      {label}
      <span className="mt-xs block">{children}</span>
    </label>
  );
}
