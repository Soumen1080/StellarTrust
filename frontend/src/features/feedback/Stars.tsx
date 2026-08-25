import { FEEDBACK_RATING_MAX } from "@stellartrust/shared";
import { Icon } from "@/components/Icon";

/**
 * Read-only star display.
 *
 * Shared by the wall, the CTA band and the "you left feedback" card, so a
 * rating looks the same everywhere it appears. The whole row carries one
 * `aria-label` — five separate star icons announced individually would be
 * noise, not information.
 */
export function Stars({
  value,
  className = "h-4 w-4",
}: {
  value: number;
  className?: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-[2px]"
      aria-label={`${value} out of ${FEEDBACK_RATING_MAX} stars`}
    >
      {Array.from({ length: FEEDBACK_RATING_MAX }, (_, index) => index + 1).map(
        (star) => (
          <Icon
            key={star}
            name="star"
            className={`${className} ${
              star <= value ? "text-status-review" : "text-muted/40"
            }`}
            fill={star <= value ? "currentColor" : "none"}
          />
        ),
      )}
    </span>
  );
}
