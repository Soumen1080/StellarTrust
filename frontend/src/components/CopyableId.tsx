"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";

type CopyState = "idle" | "copied" | "failed";

/**
 * An identifier the user needs to hand to someone else.
 *
 * User IDs are UUIDs, which nobody retypes correctly. The value is rendered
 * `select-all` so it stays copyable by hand even when the Clipboard API is
 * unavailable — it needs a secure context, so it silently does not exist over
 * plain HTTP, which is exactly how a deployed demo tends to be reached.
 */
export function CopyableId({
  value,
  label,
  hint,
}: {
  value: string;
  label: string;
  hint?: string;
}) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | undefined>(undefined);

  // A pending "Copied" reset must not fire into an unmounted component, and a
  // second click should restart the window rather than inherit the first one's.
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    window.clearTimeout(timer.current);
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
    timer.current = window.setTimeout(() => setState("idle"), 2000);
  }

  return (
    <div className="rounded-lg bg-surface-strong-light p-md">
      <div className="flex items-center justify-between gap-sm">
        <span className="text-xs font-medium text-muted">{label}</span>
        <button
          type="button"
          onClick={() => void copy()}
          className="flex items-center gap-xs rounded-md px-xs py-0.5 text-xs font-medium text-primary-active hover:bg-primary/10"
          // The visible label already changes; announce it for screen readers
          // too, since the icon swap alone conveys nothing.
          aria-live="polite"
        >
          <Icon
            name={state === "copied" ? "check" : "copy"}
            className="h-3.5 w-3.5"
          />
          {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
        </button>
      </div>
      <code className="mt-xs block select-all break-all font-mono text-xs text-ink">
        {value}
      </code>
      {hint ? <p className="mt-xs text-xs leading-5 text-muted">{hint}</p> : null}
    </div>
  );
}
