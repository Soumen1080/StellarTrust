/**
 * A user's picture, or their initials when they have not set one.
 *
 * Initials come from the username rather than the display name: every account
 * has a username (migration 0023) while `displayName` is usually null, so this
 * always renders something deliberate instead of an empty circle.
 */
import { Icon } from "@/components/Icon";

/**
 * Up to two initials from a handle.
 *
 * Handles are `[a-z0-9_]`, so underscores are the only word boundary available:
 * "ada_lovelace" gives "AL", "soumen" gives "SO". A purely numeric handle has
 * no useful letters, so the caller falls back to the person glyph.
 */
function initialsOf(username: string): string {
  const words = username.split("_").filter(Boolean);
  const letters = words
    .map((word) => word[0])
    .filter((char): char is string => Boolean(char) && /[a-z]/i.test(char));

  if (letters.length >= 2) return (letters[0]! + letters[1]!).toUpperCase();
  const firstWord = words[0] ?? "";
  const alpha = firstWord.replace(/[^a-z]/gi, "");
  return alpha.slice(0, 2).toUpperCase();
}

export function Avatar({
  username,
  avatarUrl,
  size = "md",
  className = "",
}: {
  username: string;
  avatarUrl?: string;
  /** `md` suits the header; `lg` the profile page. */
  size?: "md" | "lg";
  className?: string;
}) {
  const dimensions = size === "lg" ? "h-20 w-20 text-xl" : "h-9 w-9 text-xs";
  const shared = `${dimensions} shrink-0 overflow-hidden rounded-full ${className}`;

  if (avatarUrl) {
    return (
      // Plain <img>: the URL is an arbitrary Supabase Storage host, and
      // next/image would need each one declared in next.config.mjs.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarUrl}
        alt=""
        className={`${shared} border border-hairline-dark object-cover`}
      />
    );
  }

  const initials = initialsOf(username);
  return (
    <span
      aria-hidden="true"
      className={`${shared} grid place-items-center bg-primary font-semibold text-on-primary`}
    >
      {initials || <Icon name="user" className="h-4 w-4" />}
    </span>
  );
}
