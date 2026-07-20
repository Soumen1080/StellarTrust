import type { Metadata } from "next";
import { KycOnboarding } from "@/features/kyc/KycOnboarding";

export const metadata: Metadata = { title: "Identity verification", description: "Complete identity or business verification for StellarTrust." };

export default function KycPage() {
  return <main id="main-content" className="min-h-[calc(100vh-4rem)] bg-surface-soft-light"><div className="mx-auto max-w-[1280px] px-md py-xl sm:px-lg sm:py-xxl"><div className="mb-xl max-w-2xl"><p className="eyebrow">Identity & compliance</p><h1 className="mt-sm text-3xl font-bold tracking-tight text-ink sm:text-4xl">Verify once. Transact with confidence.</h1><p className="mt-sm leading-7 text-muted">Secure identity checks help protect every participant while keeping sensitive document data out of application logs.</p></div><KycOnboarding /></div></main>;
}
