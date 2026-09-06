"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { useIdentity } from "@/components/IdentityProvider";

const MENU_LINKS = [
  { href: "/profile", label: "Your profile", icon: "user" },
  { href: "/dashboard", label: "Dashboard", icon: "network" },
  { href: "/wallet", label: "Balance", icon: "wallet" },
] as const;

/**
 * The signed-in user's avatar, opening a menu onto their own pages.
 *
 * Renders nothing when signed out — the header shows its verification CTA
 * instead, which is the only route to KYC at `lg` and up.
 */
export function ProfileMenu({ light }: { light: boolean }) {
  const { profile } = useIdentity();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();

  // Close on navigation, mirroring the mobile drawer in AppShell.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    // Dismiss on any click outside. `pointerdown` rather than `click` so the
    // menu is gone before the click lands on whatever is underneath it.
    const handlePointerDown = (event: PointerEvent) => {
      if (containerRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", handleKeydown);
    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [open]);

  if (!profile) return null;
  const { username, avatarUrl } = profile.user;

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Account menu for ${username}`}
        className={`flex min-h-11 items-center gap-xs rounded-pill border p-xxs transition-colors ${
          light
            ? "border-hairline-light hover:bg-surface-strong-light"
            : "border-hairline-dark hover:bg-surface-card-dark"
        }`}
      >
        <Avatar username={username} avatarUrl={avatarUrl} />
        <Icon
          name="chevron-down"
          className={`mr-xxs h-4 w-4 transition ${open ? "rotate-180" : ""} ${
            light ? "text-muted" : "text-muted-strong"
          }`}
        />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Account"
          className={`absolute right-0 top-[calc(100%+0.5rem)] z-50 w-56 overflow-hidden rounded-lg border shadow-lg ${
            light
              ? "border-hairline-light bg-white"
              : "border-hairline-dark bg-surface-card-dark"
          }`}
        >
          <div
            className={`border-b px-md py-sm ${light ? "border-hairline-light" : "border-hairline-dark"}`}
          >
            <p className="data-label">Signed in as</p>
            <p
              className={`truncate font-mono text-sm font-semibold ${light ? "text-ink" : "text-on-dark"}`}
              title={`@${username}`}
            >
              @{username}
            </p>
          </div>
          <div className="p-xxs">
            {MENU_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                role="menuitem"
                className={`flex min-h-11 items-center gap-sm rounded-md px-sm text-sm font-medium transition-colors ${
                  light
                    ? "text-ink hover:bg-surface-strong-light"
                    : "text-body hover:bg-canvas-dark hover:text-on-dark"
                }`}
              >
                <Icon name={link.icon} className="h-4 w-4" />
                {link.label}
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
