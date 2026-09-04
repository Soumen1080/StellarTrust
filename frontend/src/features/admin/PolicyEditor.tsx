"use client";

/**
 * The verification routing control surface.
 *
 * This is the screen where an operator decides whether a verification passes
 * automatically, goes through the advisory risk engine, or waits for a person.
 * Until it existed those were environment variables, so changing them meant a
 * redeploy — and the moment you need a control tightened is the moment you
 * cannot wait for a build.
 *
 * Two things the UI has to be honest about:
 *
 * 1. **`auto` does not mean the model decides.** AI is advisory in every mode
 *    (Rules.md §6). `auto` means the deterministic policy may conclude without
 *    queueing a human. A label reading "let the AI approve" would describe a
 *    system this is not.
 *
 * 2. **The thresholds still bind in `auto`.** A hard provider failure, an
 *    amount above the ceiling, and conflicting evidence all still route to a
 *    person. The mode buttons say what changes, not what is abandoned.
 */
import { useState } from "react";
import type {
  UpdateVerificationPolicyInput,
  VerificationDomain,
  VerificationMode,
  VerificationPolicyDTO,
} from "@stellartrust/shared";
import { api } from "@/lib/api";
import { Panel } from "./AdminPrimitives";

const DOMAIN_LABEL: Record<VerificationDomain, string> = {
  kyc: "Customer onboarding (KYC)",
  rwa_asset: "Asset verification",
};

const DOMAIN_DESCRIPTION: Record<VerificationDomain, string> = {
  kyc: "Decides whether a new user is verified, refused, or sent to an officer. A user must be verified before they can invest.",
  rwa_asset:
    "Decides whether an asset may be tokenized. Only a verified asset reaches an investor, so this is the fraud gate.",
};

const MODE_COPY: Record<
  VerificationMode,
  { label: string; detail: string; tone: string }
> = {
  auto: {
    label: "Automatic",
    detail:
      "The deterministic policy concludes without queueing anyone, when the thresholds below are satisfied. Hard failures and large amounts still reach a person.",
    tone: "border-value-up/40 bg-value-up/10 text-value-up",
  },
  ai: {
    label: "AI-advised",
    detail:
      "Consults the advisory risk engine, then applies the thresholds. An engine that does not answer, or answers with low confidence, routes to a person.",
    tone: "border-info/40 bg-info/10 text-info",
  },
  human: {
    label: "Human review",
    detail:
      "Every submission waits for a person, whatever the engine says. This is the setting to reach for during an incident.",
    tone: "border-status-review/40 bg-status-review/10 text-status-review",
  },
};

export function PolicyEditor({
  policies,
  accessToken,
  onSaved,
}: {
  policies: VerificationPolicyDTO[];
  accessToken: string;
  onSaved: () => void;
}) {
  return (
    <div className="flex flex-col gap-lg">
      <div className="rounded-lg border border-info/30 bg-info/5 px-md py-sm">
        <p className="text-sm text-body">
          <strong className="font-semibold text-on-dark">
            AI is advisory in every mode.
          </strong>{" "}
          No setting here lets a model approve anything on its own. Automatic
          means the platform&rsquo;s own deterministic policy may conclude
          without queueing a person — a sanctions hit, a failed provider check,
          conflicting evidence, or an amount above the ceiling still reaches
          someone whatever the mode.
        </p>
      </div>

      {policies.map((policy) => (
        <PolicyCard
          key={policy.domain}
          policy={policy}
          accessToken={accessToken}
          onSaved={onSaved}
        />
      ))}
    </div>
  );
}

function PolicyCard({
  policy,
  accessToken,
  onSaved,
}: {
  policy: VerificationPolicyDTO;
  accessToken: string;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<VerificationPolicyDTO>(policy);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Compared against the *prop*, not a snapshot, so the button settles back to
  // disabled once a save round-trips and the parent hands down the new values.
  const dirty =
    draft.mode !== policy.mode ||
    draft.approveMaxRiskBps !== policy.approveMaxRiskBps ||
    draft.rejectMinRiskBps !== policy.rejectMinRiskBps ||
    draft.minConfidenceBps !== policy.minConfidenceBps ||
    draft.humanReviewAboveAmount !== policy.humanReviewAboveAmount;

  // The same rule the server and the database both enforce, checked here so an
  // operator sees the problem while they are still typing rather than after a
  // round trip.
  const bandsOverlap = draft.approveMaxRiskBps >= draft.rejectMinRiskBps;

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const input: UpdateVerificationPolicyInput = {
        mode: draft.mode,
        approveMaxRiskBps: draft.approveMaxRiskBps,
        rejectMinRiskBps: draft.rejectMinRiskBps,
        minConfidenceBps: draft.minConfidenceBps,
        humanReviewAboveAmount: draft.humanReviewAboveAmount,
      };
      await api.adminUpdatePolicy(
        accessToken,
        crypto.randomUUID(),
        draft.domain,
        input,
      );
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the policy");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel
      title={DOMAIN_LABEL[draft.domain]}
      description={DOMAIN_DESCRIPTION[draft.domain]}
      action={
        policy.updatedAt > "1970-01-02" ? (
          <span className="font-mono text-[11px] text-muted">
            last changed{" "}
            {new Date(policy.updatedAt).toLocaleDateString(undefined, {
              dateStyle: "medium",
            })}
          </span>
        ) : (
          <span className="font-mono text-[11px] text-muted">never changed</span>
        )
      }
    >
      <div className="flex flex-col gap-lg">
        <fieldset>
          <legend className="mb-sm text-xs font-medium uppercase tracking-wider text-muted-strong">
            How this domain decides
          </legend>
          <div className="grid gap-sm sm:grid-cols-3">
            {(Object.keys(MODE_COPY) as VerificationMode[]).map((mode) => {
              const selected = draft.mode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, mode }))}
                  aria-pressed={selected}
                  className={`rounded-lg border p-sm text-left transition-colors ${
                    selected
                      ? MODE_COPY[mode].tone
                      : "border-hairline-dark text-muted-strong hover:border-border-strong/40"
                  }`}
                >
                  <span className="block text-sm font-semibold">
                    {MODE_COPY[mode].label}
                  </span>
                  <span className="mt-xxs block text-xs leading-5 opacity-80">
                    {MODE_COPY[mode].detail}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <fieldset
          className={draft.mode === "human" ? "opacity-50" : undefined}
          disabled={draft.mode === "human"}
        >
          <legend className="mb-sm text-xs font-medium uppercase tracking-wider text-muted-strong">
            Thresholds
            {draft.mode === "human" ? (
              <span className="ml-xs font-normal normal-case tracking-normal text-muted">
                — not consulted while every case goes to a person
              </span>
            ) : null}
          </legend>
          <div className="grid gap-md sm:grid-cols-2">
            <BpsField
              label="Approve at or below"
              help="Risk this low may be approved without a person."
              value={draft.approveMaxRiskBps}
              onChange={(approveMaxRiskBps) =>
                setDraft((d) => ({ ...d, approveMaxRiskBps }))
              }
              invalid={bandsOverlap}
            />
            <BpsField
              label="Reject at or above"
              help="Risk this high may be refused without a person."
              value={draft.rejectMinRiskBps}
              onChange={(rejectMinRiskBps) =>
                setDraft((d) => ({ ...d, rejectMinRiskBps }))
              }
              invalid={bandsOverlap}
            />
            <BpsField
              label="Minimum confidence"
              help="Below this, the advisory is not trusted and a person decides."
              value={draft.minConfidenceBps}
              onChange={(minConfidenceBps) =>
                setDraft((d) => ({ ...d, minConfidenceBps }))
              }
            />
            <div>
              <label
                htmlFor={`${draft.domain}-amount`}
                className="block text-sm font-medium text-body"
              >
                Always review above
              </label>
              <input
                id={`${draft.domain}-amount`}
                type="text"
                inputMode="numeric"
                value={draft.humanReviewAboveAmount}
                onChange={(event) =>
                  setDraft((d) => ({
                    ...d,
                    humanReviewAboveAmount: event.target.value.replace(
                      /[^\d]/g,
                      "",
                    ),
                  }))
                }
                className="mt-xs w-full rounded-md border border-hairline-dark bg-canvas-dark px-sm py-xs font-mono text-sm text-body"
              />
              <p className="mt-xxs text-xs text-muted">
                Minor units. Above this a person decides however clean the case
                — zero disables the gate.
              </p>
            </div>
          </div>
        </fieldset>

        {bandsOverlap ? (
          <p
            role="alert"
            className="rounded-md border border-status-rejected/30 bg-status-rejected/5 px-sm py-xs text-sm text-status-rejected"
          >
            The approval band overlaps the rejection band. A case cannot be both
            automatically approved and automatically refused — set the approval
            threshold below the rejection threshold.
          </p>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="rounded-md border border-status-rejected/30 bg-status-rejected/5 px-sm py-xs text-sm text-status-rejected"
          >
            {error}
          </p>
        ) : null}

        <div className="flex items-center gap-md">
          <button
            type="button"
            disabled={!dirty || bandsOverlap || saving}
            onClick={() => void save()}
            className="btn-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save policy"}
          </button>
          {dirty ? (
            <button
              type="button"
              onClick={() => {
                setDraft(policy);
                setError(null);
              }}
              className="text-sm text-muted-strong transition-colors hover:text-on-dark"
            >
              Discard changes
            </button>
          ) : null}
          {saved && !dirty ? (
            <span className="text-sm text-value-up">
              Saved. It applies to the next submission.
            </span>
          ) : null}
        </div>

        <p className="text-xs text-muted">
          Every change is written to the audit trail with the values it was
          changed from, and applies to the next submission — not the next
          deploy.
        </p>
      </div>
    </Panel>
  );
}

/**
 * A basis-point threshold, entered as a percentage.
 *
 * Operators think in percentages; the wire format is basis points because a
 * threshold held as a float compares differently depending on how it was
 * written down. The conversion belongs here, at the one place a human types.
 */
function BpsField({
  label,
  help,
  value,
  onChange,
  invalid,
}: {
  label: string;
  help: string;
  value: number;
  onChange: (bps: number) => void;
  invalid?: boolean;
}) {
  const id = label.replace(/\s+/g, "-").toLowerCase();
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-body">
        {label}
      </label>
      <div className="mt-xs flex items-center gap-xs">
        <input
          id={id}
          type="number"
          min={0}
          max={100}
          step={0.01}
          value={(value / 100).toString()}
          onChange={(event) => {
            const percent = Number(event.target.value);
            if (!Number.isFinite(percent)) return;
            // Rounded, because basis points are integers on the wire and the
            // server refuses a fractional one.
            onChange(Math.round(Math.min(Math.max(percent, 0), 100) * 100));
          }}
          aria-invalid={invalid || undefined}
          className={`w-full rounded-md border bg-canvas-dark px-sm py-xs font-mono text-sm text-body ${
            invalid ? "border-status-rejected" : "border-hairline-dark"
          }`}
        />
        <span className="text-sm text-muted-strong">%</span>
      </div>
      <p className="mt-xxs text-xs text-muted">{help}</p>
    </div>
  );
}
