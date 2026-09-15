/**
 * Identity verification.
 *
 * A real KYC submission: the user enters their details, photographs their
 * document and their face, and those images are uploaded to private storage
 * and submitted to the verification provider. There is no scenario picker —
 * the outcome comes from the checks, not from a dropdown.
 *
 * The flow is stepped rather than one long form because the failure modes are
 * different at each stage and a user who fails at the last one should not have
 * to redo the first.
 */
import {
  ApplicantType,
  KycCaptureKind,
  KycStatus,
  type KycApplicationInput,
} from "@stellartrust/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { api } from "../../api/client";
import { messageFor } from "../../api/errors";
import { useAccessToken, useAuth } from "../../auth/AuthProvider";
import { Button } from "../../components/Button";
import { Card, DataRow, Divider } from "../../components/Card";
import { Input } from "../../components/Input";
import { Screen } from "../../components/Screen";
import { StatusPill } from "../../components/StatusPill";
import { Eyebrow, Label, Text } from "../../components/Text";
import { InlineError, SkeletonList } from "../../components/States";
import { useIdempotencyKey } from "../../lib/idempotency";
import { queryKeys } from "../../lib/query";
import { color, radius, space } from "../../theme";
import { CameraCapture } from "./CameraCapture";
import { uploadCapture, type PreparedCapture } from "./capture";
import { CapturePreview, StepDots } from "./components";

type Step = "details" | "document" | "selfie" | "review";

interface CaptureSlot {
  capture: PreparedCapture;
  /** Set once uploaded; this is what the application carries. */
  reference?: string;
}

const DOCUMENT_KINDS = [
  { value: "passport", label: "Passport" },
  { value: "national_id", label: "National ID" },
  { value: "drivers_license", label: "Driver's licence" },
] as const;

export function VerificationScreen() {
  const accessToken = useAccessToken();
  const { profile, refreshProfile } = useAuth();
  const queryClient = useQueryClient();
  const idempotency = useIdempotencyKey();

  const [step, setStep] = useState<Step>("details");
  const [capturing, setCapturing] = useState<"document" | "selfie" | null>(null);

  // Details
  const [applicantType, setApplicantType] = useState<ApplicantType>(
    ApplicantType.Individual,
  );
  const [legalName, setLegalName] = useState("");
  const [email, setEmail] = useState(profile?.user.email ?? "");
  const [country, setCountry] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [registrationNumber, setRegistrationNumber] = useState("");
  const [documentKind, setDocumentKind] =
    useState<(typeof DOCUMENT_KINDS)[number]["value"]>("passport");
  const [documentNumber, setDocumentNumber] = useState("");
  const [expiryDate, setExpiryDate] = useState("");

  // Captures
  const [documentFront, setDocumentFront] = useState<CaptureSlot | null>(null);
  const [selfie, setSelfie] = useState<CaptureSlot | null>(null);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const { data: status, isLoading } = useQuery({
    queryKey: queryKeys.kycStatus(),
    queryFn: () => api.kycStatus(accessToken),
    // A submitted application is decided asynchronously; poll while it is in
    // flight so the result appears without the user pulling to refresh.
    refetchInterval: (query) =>
      query.state.data?.status === KycStatus.Pending ||
      query.state.data?.status === KycStatus.UnderReview
        ? 5_000
        : false,
  });

  const submit = useMutation({
    mutationFn: async () => {
      if (!documentFront || !selfie) {
        throw new Error("Both photos are required.");
      }

      // Upload captures first. Each returns an opaque reference; the images
      // themselves never travel inside the application body.
      const [frontRef, faceRef] = await Promise.all([
        documentFront.reference ??
          uploadCapture(
            accessToken,
            KycCaptureKind.DocumentFront,
            documentFront.capture.dataUrl,
          ),
        selfie.reference ??
          uploadCapture(
            accessToken,
            KycCaptureKind.Liveness,
            selfie.capture.dataUrl,
          ),
      ]);

      // Retained so a retry after a failed submission does not re-upload
      // images that already landed.
      setDocumentFront((current) =>
        current ? { ...current, reference: frontRef } : current,
      );
      setSelfie((current) =>
        current ? { ...current, reference: faceRef } : current,
      );

      const input: KycApplicationInput = {
        applicantType,
        email: email.trim(),
        legalName: legalName.trim(),
        country: country.trim().toUpperCase(),
        ...(applicantType === ApplicantType.Individual
          ? { dateOfBirth: dateOfBirth.trim() }
          : {
              businessName: businessName.trim(),
              registrationNumber: registrationNumber.trim(),
            }),
        document: {
          kind: documentKind,
          issuingCountry: country.trim().toUpperCase(),
          number: documentNumber.trim(),
          expiryDate: expiryDate.trim(),
          frontImageRef: frontRef,
        },
        faceImageRef: faceRef,
      };

      return api.submitKyc(accessToken, idempotency.next(), input);
    },
    onSuccess: async () => {
      idempotency.reset();
      await queryClient.invalidateQueries({ queryKey: queryKeys.kycStatus() });
      await refreshProfile();
    },
  });

  function validateDetails(): boolean {
    const errors: Record<string, string> = {};
    if (legalName.trim().length < 2) {
      errors.legalName = "Enter your full legal name as it appears on the document.";
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      errors.email = "Enter a valid email address.";
    }
    if (!/^[A-Za-z]{2}$/.test(country.trim())) {
      errors.country = "Use the two-letter country code, such as GB or IN.";
    }
    if (documentNumber.trim().length < 4) {
      errors.documentNumber = "Enter the document number.";
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate.trim())) {
      errors.expiryDate = "Use YYYY-MM-DD.";
    } else if (Date.parse(expiryDate.trim()) <= Date.now()) {
      errors.expiryDate = "That document has expired.";
    }
    if (applicantType === ApplicantType.Individual) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth.trim())) {
        errors.dateOfBirth = "Use YYYY-MM-DD.";
      }
    } else {
      if (businessName.trim().length < 2) {
        errors.businessName = "Enter the registered business name.";
      }
      if (registrationNumber.trim().length < 2) {
        errors.registrationNumber = "Enter the company registration number.";
      }
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  // ── Already decided or in flight ─────────────────────────────────────────
  if (isLoading) {
    return (
      <Screen>
        <SkeletonList count={2} />
      </Screen>
    );
  }

  const current = status?.status;
  if (
    current === KycStatus.Verified ||
    current === KycStatus.UnderReview ||
    (current === KycStatus.Pending && status?.verification)
  ) {
    return <VerificationOutcome status={status} />;
  }

  // ── Camera takes the whole screen ────────────────────────────────────────
  if (capturing === "document") {
    return (
      <CameraCapture
        target="document"
        title="Photograph your document"
        instruction="Fill the frame with the photo page. Avoid glare and shadows."
        onCaptured={(capture) => {
          setDocumentFront({ capture });
          setCapturing(null);
          setStep("selfie");
        }}
        onCancel={() => setCapturing(null)}
      />
    );
  }
  if (capturing === "selfie") {
    return (
      <CameraCapture
        target="selfie"
        title="Take a selfie"
        instruction="Look straight at the camera in even light. Remove glasses and hats."
        onCaptured={(capture) => {
          setSelfie({ capture });
          setCapturing(null);
          setStep("review");
        }}
        onCancel={() => setCapturing(null)}
      />
    );
  }

  const stepIndex = { details: 0, document: 1, selfie: 2, review: 3 }[step];

  return (
    <Screen
      footer={
        <StepFooter
          step={step}
          busy={submit.isPending}
          canContinue={
            step === "document"
              ? Boolean(documentFront)
              : step === "selfie"
                ? Boolean(selfie)
                : true
          }
          onBack={() => {
            setStep(
              step === "review"
                ? "selfie"
                : step === "selfie"
                  ? "document"
                  : "details",
            );
          }}
          onNext={() => {
            if (step === "details") {
              if (validateDetails()) setStep("document");
              return;
            }
            if (step === "document") {
              if (documentFront) setStep("selfie");
              else setCapturing("document");
              return;
            }
            if (step === "selfie") {
              if (selfie) setStep("review");
              else setCapturing("selfie");
              return;
            }
            submit.mutate();
          }}
        />
      }
    >
      <View style={styles.header}>
        <Eyebrow>Identity verification</Eyebrow>
        <Text variant="displaySm" tone={color.onDark}>
          {STEP_TITLE[step]}
        </Text>
        <Text variant="bodySm" tone={color.muted}>
          {STEP_BLURB[step]}
        </Text>
        <StepDots total={4} active={stepIndex} />
      </View>

      {submit.error ? <InlineError error={submit.error} /> : null}

      {step === "details" ? (
        <View style={styles.form}>
          <Card>
            <Label>Applicant type</Label>
            <View style={styles.segment}>
              {[ApplicantType.Individual, ApplicantType.Business].map((value) => (
                <SegmentOption
                  key={value}
                  label={value === ApplicantType.Individual ? "Individual" : "Business"}
                  selected={applicantType === value}
                  onPress={() => setApplicantType(value)}
                />
              ))}
            </View>
          </Card>

          <Input
            label="Full legal name"
            value={legalName}
            onChangeText={setLegalName}
            placeholder="As printed on your document"
            autoCapitalize="words"
            autoComplete="name"
            error={fieldErrors.legalName}
          />
          <Input
            label="Email"
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            error={fieldErrors.email}
          />
          <Input
            label="Country"
            value={country}
            onChangeText={(text) => setCountry(text.toUpperCase().slice(0, 2))}
            placeholder="GB"
            autoCapitalize="characters"
            maxLength={2}
            mono
            error={fieldErrors.country}
            hint="Two-letter country code"
          />

          {applicantType === ApplicantType.Individual ? (
            <Input
              label="Date of birth"
              value={dateOfBirth}
              onChangeText={setDateOfBirth}
              placeholder="1990-01-31"
              keyboardType="numbers-and-punctuation"
              mono
              error={fieldErrors.dateOfBirth}
              hint="YYYY-MM-DD"
            />
          ) : (
            <>
              <Input
                label="Registered business name"
                value={businessName}
                onChangeText={setBusinessName}
                autoCapitalize="words"
                error={fieldErrors.businessName}
              />
              <Input
                label="Registration number"
                value={registrationNumber}
                onChangeText={setRegistrationNumber}
                autoCapitalize="characters"
                mono
                error={fieldErrors.registrationNumber}
              />
            </>
          )}

          <Divider />

          <Label>Document type</Label>
          <View style={styles.segment}>
            {DOCUMENT_KINDS.map((kind) => (
              <SegmentOption
                key={kind.value}
                label={kind.label}
                selected={documentKind === kind.value}
                onPress={() => setDocumentKind(kind.value)}
              />
            ))}
          </View>

          <Input
            label="Document number"
            value={documentNumber}
            onChangeText={setDocumentNumber}
            autoCapitalize="characters"
            mono
            error={fieldErrors.documentNumber}
          />
          <Input
            label="Expiry date"
            value={expiryDate}
            onChangeText={setExpiryDate}
            placeholder="2030-06-30"
            keyboardType="numbers-and-punctuation"
            mono
            error={fieldErrors.expiryDate}
            hint="YYYY-MM-DD"
          />
        </View>
      ) : null}

      {step === "document" ? (
        <CapturePreview
          capture={documentFront?.capture ?? null}
          emptyTitle="Photograph your document"
          emptyBlurb="Lay it flat on a dark surface in even light. All four corners must be visible."
          actionLabel={documentFront ? "Retake photo" : "Open camera"}
          onAction={() => setCapturing("document")}
        />
      ) : null}

      {step === "selfie" ? (
        <CapturePreview
          capture={selfie?.capture ?? null}
          emptyTitle="Take a selfie"
          emptyBlurb="This is compared against the photo on your document to confirm it is you."
          actionLabel={selfie ? "Retake selfie" : "Open camera"}
          onAction={() => setCapturing("selfie")}
          rounded
        />
      ) : null}

      {step === "review" ? (
        <View style={styles.form}>
          <Card>
            <Label>What you are submitting</Label>
            <View style={styles.reviewRows}>
              <DataRow label="Name" value={legalName} mono={false} />
              <DataRow label="Country" value={country.toUpperCase()} />
              <DataRow
                label="Document"
                value={
                  DOCUMENT_KINDS.find((k) => k.value === documentKind)?.label
                }
                mono={false}
              />
              <DataRow label="Number" value={documentNumber} />
              <DataRow label="Expires" value={expiryDate} />
              {applicantType === ApplicantType.Individual ? (
                <DataRow label="Born" value={dateOfBirth} />
              ) : (
                <DataRow label="Business" value={businessName} mono={false} />
              )}
            </View>
          </Card>

          <View style={styles.thumbRow}>
            <CapturePreview
              capture={documentFront?.capture ?? null}
              compact
              emptyTitle="Document"
              emptyBlurb=""
              actionLabel="Retake"
              onAction={() => setCapturing("document")}
            />
            <CapturePreview
              capture={selfie?.capture ?? null}
              compact
              rounded
              emptyTitle="Selfie"
              emptyBlurb=""
              actionLabel="Retake"
              onAction={() => setCapturing("selfie")}
            />
          </View>

          <Card style={styles.notice}>
            <Text variant="bodySm" tone={color.mutedStrong}>
              Your photos are sent over an encrypted connection to the identity
              checks and are never shown publicly. Verification usually
              completes in a few minutes; some applications are reviewed by a
              person and take longer.
            </Text>
          </Card>
        </View>
      ) : null}
    </Screen>
  );
}

const STEP_TITLE: Record<Step, string> = {
  details: "Your details",
  document: "Your document",
  selfie: "Your face",
  review: "Check and submit",
};

const STEP_BLURB: Record<Step, string> = {
  details: "These must match your identity document exactly.",
  document: "A clear photograph of the page carrying your photo.",
  selfie: "A live photo, compared against your document.",
  review: "Confirm everything is right before it goes for checking.",
};

function StepFooter({
  step,
  busy,
  canContinue,
  onBack,
  onNext,
}: {
  step: Step;
  busy: boolean;
  canContinue: boolean;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <View style={styles.footer}>
      {step !== "details" ? (
        <Button
          label="Back"
          onPress={onBack}
          variant="ghost"
          fullWidth={false}
          disabled={busy}
        />
      ) : null}
      <Button
        label={step === "review" ? "Submit for verification" : "Continue"}
        onPress={onNext}
        busy={busy}
        disabled={!canContinue}
        haptic={step === "review"}
        style={styles.footerPrimary}
      />
    </View>
  );
}

function SegmentOption({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      label={label}
      onPress={onPress}
      variant={selected ? "primary" : "secondary"}
      size="sm"
      fullWidth={false}
      style={styles.segmentOption}
    />
  );
}

/** Terminal and in-flight states — nothing to fill in. */
function VerificationOutcome({
  status,
}: {
  status: { status: KycStatus; verification: unknown } | undefined;
}) {
  const value = status?.status ?? KycStatus.Pending;
  const copy = {
    [KycStatus.Verified]: {
      title: "You are verified",
      blurb:
        "Your identity has been confirmed. Every money feature is now available.",
    },
    [KycStatus.UnderReview]: {
      title: "Under review",
      blurb:
        "A reviewer is checking your application. This usually takes a few hours; you do not need to do anything.",
    },
    [KycStatus.Pending]: {
      title: "Checking your documents",
      blurb: "This page updates on its own as soon as there is a result.",
    },
    [KycStatus.Rejected]: {
      title: "Verification was not successful",
      blurb:
        "Your application could not be approved. Contact support to find out what to do next.",
    },
  }[value];

  return (
    <Screen>
      <View style={styles.outcome}>
        <StatusPill status={value} />
        <Text variant="displaySm" tone={color.onDark} center>
          {copy.title}
        </Text>
        <Text variant="bodyMd" tone={color.muted} center style={styles.blurb}>
          {copy.blurb}
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: space.xxs, paddingVertical: space.md },
  form: { gap: space.md },
  segment: { flexDirection: "row", flexWrap: "wrap", gap: space.xs, marginTop: space.xs },
  segmentOption: { flexGrow: 1, flexBasis: "30%" },
  reviewRows: { marginTop: space.xs },
  thumbRow: { flexDirection: "row", gap: space.sm },
  notice: { backgroundColor: color.surfaceElevatedDark },
  footer: { flexDirection: "row", alignItems: "center", gap: space.sm },
  footerPrimary: { flex: 1 },
  outcome: {
    alignItems: "center",
    gap: space.sm,
    paddingVertical: space.section,
  },
  blurb: { maxWidth: 320 },
});
