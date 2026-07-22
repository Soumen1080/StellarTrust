"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { useIdentity } from "@/components/IdentityProvider";

const baseLinks = [
  { href: "/", label: "Overview" },
  { href: "/escrow", label: "Escrow" },
  { href: "/settlement", label: "Settlement" },
  { href: "/disputes", label: "Disputes" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { isVerified } = useIdentity();
  const accountLink = isVerified
    ? { href: "/dashboard", label: "Dashboard" }
    : { href: "/kyc", label: "Verification" };
  const links = [...baseLinks, accountLink];
  const [open, setOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileNavRef = useRef<HTMLElement>(null);
  const firstMobileLinkRef = useRef<HTMLAnchorElement>(null);
  const light = pathname === "/kyc";

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    firstMobileLinkRef.current?.focus();
    const handleMenuKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        menuButtonRef.current?.focus();
        return;
      }
      if (event.key !== "Tab" || !mobileNavRef.current) return;
      const focusable = Array.from(mobileNavRef.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", handleMenuKeydown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleMenuKeydown);
    };
  }, [open]);

  return (
    <div className={light ? "min-h-screen bg-surface-soft-light text-ink" : "min-h-screen bg-canvas-dark text-body"}>
      <a href="#main-content" className="skip-link">Skip to content</a>
      <header className={`sticky top-0 z-50 border-b backdrop-blur-xl ${light ? "border-hairline-light bg-white/95" : "border-hairline-dark bg-canvas-dark/95"}`}>
        <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between px-md sm:px-lg">
          <Link href="/" className={`flex items-center gap-sm text-lg font-bold tracking-tight ${light ? "text-ink" : "text-on-dark"}`} aria-label="StellarTrust home">
            <span className="grid h-8 w-8 place-items-center rounded-md bg-primary text-ink"><Icon name="shield" className="h-5 w-5" /></span>
            <span>Stellar<span className="text-primary-active">Trust</span></span>
          </Link>

          <nav className="hidden items-center gap-xxs md:flex" aria-label="Primary navigation">
            {links.map((link) => {
              const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
              return <Link key={link.href} href={link.href} aria-current={active ? "page" : undefined} className={`rounded-md px-md py-sm text-sm font-medium transition-colors ${active ? light ? "bg-surface-strong-light text-ink" : "bg-surface-card-dark text-on-dark" : light ? "text-muted hover:text-ink" : "text-muted-strong hover:text-on-dark"}`}>{link.label}</Link>;
            })}
          </nav>

          <div className="hidden items-center gap-sm md:flex">
            <span className={`rounded-pill border px-sm py-xs font-mono text-[11px] uppercase tracking-wider ${light ? "border-hairline-light text-muted" : "border-hairline-dark text-muted-strong"}`}><span className="mr-xs inline-block h-1.5 w-1.5 rounded-full bg-status-verified" />Testnet</span>
            <Link href={accountLink.href} className="btn-primary">{isVerified ? "Open dashboard" : "Start verification"} <Icon name="arrow-right" className="h-4 w-4" /></Link>
          </div>

          <button ref={menuButtonRef} type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-controls="mobile-navigation" aria-label={open ? "Close navigation" : "Open navigation"} className={`grid h-10 w-10 place-items-center rounded-md border md:hidden ${light ? "border-hairline-light" : "border-hairline-dark"}`}>
            <Icon name={open ? "x" : "menu"} />
          </button>
        </div>
        {open ? (
          <nav ref={mobileNavRef} id="mobile-navigation" className={`fixed inset-x-0 bottom-0 top-16 z-50 flex flex-col border-t px-md py-lg md:hidden ${light ? "border-hairline-light bg-white" : "border-hairline-dark bg-canvas-dark"}`} aria-label="Mobile navigation">
            <div className="grid gap-xs">
              {links.map((link, index) => <Link ref={index === 0 ? firstMobileLinkRef : undefined} key={link.href} href={link.href} aria-current={pathname === link.href ? "page" : undefined} className={`rounded-md px-md py-md text-lg font-semibold ${pathname === link.href ? "bg-primary text-ink" : light ? "text-ink" : "text-body"}`}>{link.label}</Link>)}
            </div>
            <div className={`mt-auto border-t pt-lg ${light ? "border-hairline-light" : "border-hairline-dark"}`}>
              <p className={`mb-md text-sm ${light ? "text-muted" : "text-muted-strong"}`}>Secure escrow and identity verification on Stellar testnet.</p>
              <Link href={accountLink.href} className="btn-primary w-full justify-center">{isVerified ? "Open dashboard" : "Start verification"} <Icon name="arrow-right" className="h-4 w-4" /></Link>
            </div>
          </nav>
        ) : null}
      </header>
      {children}
      <footer className="border-t border-hairline-light bg-surface-soft-light text-ink">
        <div className="mx-auto grid max-w-[1280px] gap-xl px-md py-xxl sm:px-lg lg:grid-cols-[1.2fr_2fr]">
          <div>
            <Link href="/" className="flex items-center gap-sm font-bold"><span className="grid h-8 w-8 place-items-center rounded-md bg-primary"><Icon name="shield" className="h-5 w-5" /></span>StellarTrust</Link>
            <p className="mt-md max-w-sm text-sm leading-6 text-muted">Programmable, auditable commerce infrastructure for secure cross-border payments on Stellar.</p>
            <p className="mt-lg font-mono text-xs text-muted">Stellar testnet · Sandbox environment</p>
          </div>
          <div className="grid grid-cols-2 gap-lg sm:grid-cols-4">
            {[
              ["Product", ["Escrow", "Verification"]],
              ["Operations", ["Role-gated compliance", "System status"]],
              ["Security", ["SEP-10 auth", "Double-entry ledger"]],
              ["Resources", ["Architecture", "Developer API"]],
            ].map(([title, items]) => <div key={title as string}><p className="text-sm font-semibold">{title}</p><ul className="mt-sm space-y-xs text-sm text-muted">{(items as string[]).map((item) => <li key={item}>{item}</li>)}</ul></div>)}
          </div>
        </div>
        <div className="border-t border-hairline-light px-md py-md text-center text-xs text-muted">© 2026 StellarTrust. Built for transparent settlement.</div>
      </footer>
    </div>
  );
}
