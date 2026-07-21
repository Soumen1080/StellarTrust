"use client";

import { ApplicantType, KycStatus, type KycApplicationResponse } from "@stellartrust/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { useIdentity } from "@/components/IdentityProvider";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";

type SandboxScenario = "pass" | "review" | "fail" | "aml-hit";

const checks = [
  ["Document authenticity", "OCR and document integrity"],
  ["Biometric match", "Face comparison and liveness"],
  ["AML screening", "Sanctions and watchlist signals"],
];

export function KycOnboarding() {
  const router = useRouter();
  const {
    session,
    profile,
    loading: identityLoading,
    error: identityError,
    isVerified,
    refreshProfile,
  } = useIdentity();
  const [result, setResult] = useState<KycApplicationResponse | null>(null);
  const [applicantType, setApplicantType] = useState<"individual" | "business">(ApplicantType.Individual);
  const [scenario, setScenario] = useState<SandboxScenario>("pass");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setResult(profile?.latestVerification ?? null);
  }, [profile]);

  useEffect(() => {
    if (!identityLoading && isVerified) router.replace("/dashboard");
  }, [identityLoading, isVerified, router]);

  // Development auto-approval: when a submission is pending auto-verify, poll the
  // status endpoint (which resolves the timer server-side) until Verified.
  useEffect(() => {
    if (!session) return;
    if (!result?.autoApproveAt) return;
    if (result.status !== KycStatus.UnderReview) return;
    let active = true;
    const timer = setInterval(async () => {
      try {
        const snapshot = await api.kycStatus(session.accessToken);
        if (!active) return;
        if (snapshot.verification) setResult(snapshot.verification);
        if (snapshot.status === KycStatus.Verified) {
          clearInterval(timer);
          await refreshProfile();
          router.replace("/dashboard");
        }
      } catch {
        // Transient failure — keep polling until verified or unmounted.
      }
    }, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [result, session, refreshProfile, router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) { setError("Connect and sign in with your Stellar wallet first."); return; }
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const isAmlHit = scenario === "aml-hit";
    const visualScenario = scenario === "aml-hit" ? "pass" : scenario;
    try {
      const response = await api.submitKyc(session.accessToken, window.crypto.randomUUID(), {
        applicantType,
        email: String(form.get("email")),
        legalName: String(form.get("legalName")),
        country: String(form.get("country")).toUpperCase(),
        dateOfBirth: applicantType === ApplicantType.Individual ? String(form.get("dateOfBirth")) : undefined,
        registrationNumber: applicantType === ApplicantType.Business ? String(form.get("registrationNumber")) : undefined,
        businessName: applicantType === ApplicantType.Business ? String(form.get("businessName")) : undefined,
        document: { kind: "passport", issuingCountry: String(form.get("country")).toUpperCase(), number: isAmlHit ? `AML-HIT-${String(form.get("documentNumber"))}` : String(form.get("documentNumber")), expiryDate: String(form.get("expiryDate")), frontImageRef: `sandbox://document/${visualScenario}` },
        faceImageRef: `sandbox://face/${visualScenario}`,
      });
      setResult(response);
      const refreshedProfile = await refreshProfile();
      if (refreshedProfile?.user.kycStatus === KycStatus.Verified) {
        router.replace("/dashboard");
      }
    } catch (err) { setError(err instanceof Error ? err.message : "Verification failed"); }
    finally { setPending(false); }
  }

  if (identityLoading || isVerified) return <LoadingState />;

  if (!session) {
    return <section className="panel-light overflow-hidden"><div className="grid lg:grid-cols-[1fr_.8fr]"><div className="p-xl sm:p-xxl"><span className="grid h-12 w-12 place-items-center rounded-lg bg-primary/20 text-primary-active"><Icon name="wallet" className="h-6 w-6" /></span><p className="eyebrow mt-lg">Step 1 of 2</p><h2 className="mt-xs text-2xl font-bold">Connect your Stellar wallet</h2><p className="mt-sm max-w-xl leading-7 text-muted">Your wallet proves account ownership through a signed SEP-10 challenge. StellarTrust never receives or stores your private key.</p><Link href="/" className="btn-primary mt-lg">Connect from overview <Icon name="arrow-right" className="h-4 w-4" /></Link></div><div className="border-t border-hairline-light bg-surface-strong-light p-xl lg:border-l lg:border-t-0"><p className="text-sm font-semibold">What you will need</p><ul className="mt-md space-y-md text-sm text-muted"><li className="flex gap-sm"><Icon name="check" className="h-5 w-5 shrink-0 text-status-verified" />A supported Stellar testnet wallet</li><li className="flex gap-sm"><Icon name="check" className="h-5 w-5 shrink-0 text-status-verified" />Identity or business information</li><li className="flex gap-sm"><Icon name="check" className="h-5 w-5 shrink-0 text-status-verified" />A valid passport or identity document</li></ul></div></div></section>;
  }

  return <div className="grid items-start gap-lg lg:grid-cols-[minmax(0,1fr)_340px]">
    <form onSubmit={submit} className="panel-light overflow-hidden">
      <div className="border-b border-hairline-light p-lg sm:p-xl"><div className="flex flex-wrap items-start justify-between gap-md"><div><p className="eyebrow">Verification application</p><h2 className="mt-xs text-2xl font-bold">Applicant details</h2><p className="mt-sm max-w-2xl text-sm leading-6 text-muted">Use the sandbox controls to exercise approval and human-review paths. Sensitive values are not written to application logs.</p></div><span className="rounded-pill border border-info/30 bg-info/10 px-sm py-xs text-xs font-semibold text-info">Sandbox mode</span></div></div>

      <div className="p-lg sm:p-xl">
        <fieldset><legend className="text-sm font-semibold">Application setup</legend><div className="mt-md grid gap-md sm:grid-cols-2"><Field label="Applicant type" hint="Choose the legal entity being verified"><select value={applicantType} onChange={(event) => setApplicantType(event.target.value as "individual" | "business")} className="input"><option value="individual">Individual</option><option value="business">Business</option></select></Field><Field label="Sandbox outcome" hint="Simulates the provider response"><select value={scenario} onChange={(event) => setScenario(event.target.value as SandboxScenario)} className="input"><option value="pass">Pass all checks</option><option value="review">Borderline · human review</option><option value="fail">Provider fail · human review</option><option value="aml-hit">AML hit · compliance review</option></select></Field></div></fieldset>
        <div className="my-xl border-t border-hairline-light" />
        <fieldset><legend className="text-sm font-semibold">Legal identity</legend><div className="mt-md grid gap-md sm:grid-cols-2"><Field label="Email address"><input name="email" type="email" required autoComplete="email" placeholder="name@company.com" className="input" /></Field><Field label="Legal name"><input name="legalName" required autoComplete="name" placeholder="Name as shown on document" className="input" /></Field><Field label="Country" hint="Two-letter ISO code"><input name="country" required minLength={2} maxLength={2} defaultValue="US" className="input uppercase" /></Field>{applicantType === ApplicantType.Individual ? <Field label="Date of birth"><input name="dateOfBirth" type="date" required className="input" /></Field> : <><Field label="Business name"><input name="businessName" required placeholder="Registered business name" className="input" /></Field><Field label="Registration number"><input name="registrationNumber" required placeholder="Official registry number" className="input" /></Field></>}</div></fieldset>
        <div className="my-xl border-t border-hairline-light" />
        <fieldset><legend className="text-sm font-semibold">Identity document</legend><p className="mt-xs text-sm text-muted">Passport is used by the current sandbox provider.</p><div className="mt-md grid gap-md sm:grid-cols-2"><Field label="Passport / ID number"><input name="documentNumber" required minLength={4} autoComplete="off" placeholder="Document number" className="input" /></Field><Field label="Document expiry"><input name="expiryDate" type="date" required defaultValue="2099-01-01" className="input" /></Field></div></fieldset>
        {error ?? identityError ? <div role="alert" className="mt-lg rounded-lg border border-status-rejected/30 bg-status-rejected/5 p-md text-sm text-status-rejected">{error ?? identityError}</div> : null}
        <div className="mt-xl flex flex-col-reverse gap-sm border-t border-hairline-light pt-lg sm:flex-row sm:items-center sm:justify-between"><p className="flex items-center gap-xs text-xs text-muted"><Icon name="lock" className="h-4 w-4" />Encrypted in transit · idempotent submission</p><button type="submit" disabled={pending} className="btn-primary min-w-[190px]">{pending ? "Running checks…" : "Submit verification"}<Icon name={pending ? "clock" : "arrow-right"} className="h-4 w-4" /></button></div>
      </div>
    </form>

    <aside className="space-y-lg lg:sticky lg:top-24">
      <section className="panel-light p-lg"><div className="flex items-center justify-between"><p className="text-sm font-semibold">Profile status</p>{profile ? <StatusPill status={profile.user.kycStatus} /> : <span className="text-xs text-muted">Loading…</span>}</div>{profile?.wallets[0] ? <div className="mt-md rounded-lg bg-surface-strong-light p-sm"><p className="text-[10px] uppercase tracking-wider text-muted">Connected wallet</p><p className="mt-xs truncate font-mono text-xs" title={profile.wallets[0].stellarPublicKey}>{profile.wallets[0].stellarPublicKey}</p></div> : null}{profile?.business ? <p className="mt-md text-sm font-medium">{profile.business.legalName}</p> : null}</section>
      <section className="panel-light p-lg"><p className="text-sm font-semibold">Checks included</p><ul className="mt-md space-y-md">{checks.map(([title, copy]) => <li key={title} className="flex gap-sm"><span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-surface-strong-light text-muted"><Icon name="check" className="h-4 w-4" /></span><div><p className="text-sm font-medium">{title}</p><p className="mt-xxs text-xs text-muted">{copy}</p></div></li>)}</ul></section>
      {result ? <section aria-live="polite" className="rounded-xl border border-hairline-dark bg-surface-card-dark p-lg text-body"><div className="flex items-center justify-between gap-sm"><span className="inline-flex items-center gap-xs rounded-pill border border-status-review/30 bg-status-review/10 px-sm py-xs text-xs font-semibold text-status-review"><Icon name="sparkles" className="h-3.5 w-3.5" />AI advisory</span><StatusPill status={result.status} /></div><div className="mt-lg flex items-end justify-between"><div><p className="text-xs text-muted">Confidence</p><p className="mt-xs font-mono text-2xl font-semibold text-on-dark">{(result.advisory.confidence * 100).toFixed(0)}%</p></div></div><p className="mt-md text-sm leading-6 text-muted-strong">{result.advisory.explanation}</p><ul className="mt-md space-y-xs border-t border-hairline-dark pt-md text-xs text-muted">{result.advisory.signals.map((signal) => <li key={signal} className="flex gap-xs"><span>•</span>{signal}</li>)}</ul>{result.reviewId ? <p className="mt-md rounded-md bg-status-review/10 px-sm py-xs font-mono text-xs text-status-review">Review queued · {result.reviewId}</p> : null}{result.autoApproveAt && result.status === KycStatus.UnderReview ? <p className="mt-md flex items-center gap-xs rounded-md bg-status-review/10 px-sm py-xs text-xs text-status-review"><Icon name="clock" className="h-3.5 w-3.5" />Verifying automatically… redirecting when complete</p> : null}</section> : null}
    </aside>
  </div>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="block text-sm font-medium text-ink">{label}{hint ? <span className="ml-xs text-xs font-normal text-muted">· {hint}</span> : null}<span className="mt-xs block">{children}</span></label>;
}

function LoadingState() {
  return <div className="grid gap-lg lg:grid-cols-[1fr_340px]" aria-label="Loading verification"><div className="panel-light p-xl"><div className="h-5 w-40 animate-pulse rounded bg-hairline-light"/><div className="mt-md h-10 w-72 max-w-full animate-pulse rounded bg-hairline-light"/><div className="mt-xl grid gap-md sm:grid-cols-2">{Array.from({ length: 6 }).map((_, index) => <div key={index} className="h-16 animate-pulse rounded-lg bg-surface-strong-light"/>)}</div></div><div className="panel-light h-48 animate-pulse"/></div>;
}
