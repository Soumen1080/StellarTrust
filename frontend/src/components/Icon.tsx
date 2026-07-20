import type { SVGProps } from "react";

export type IconName =
  | "arrow-right"
  | "check"
  | "chevron-down"
  | "clock"
  | "document"
  | "globe"
  | "lock"
  | "menu"
  | "network"
  | "shield"
  | "sparkles"
  | "user-check"
  | "wallet"
  | "x";

const paths: Record<IconName, React.ReactNode> = {
  "arrow-right": <><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  "chevron-down": <path d="m6 9 6 6 6-6"/>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  document: <><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v5h5M10 12h5M10 16h5"/></>,
  globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.4 3 14.6 0 18M12 3c-3 3.4-3 14.6 0 18"/></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
  menu: <><path d="M4 7h16M4 12h16M4 17h16"/></>,
  network: <><circle cx="12" cy="5" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><path d="m11 7-5 9M13 7l5 9M7 18h10"/></>,
  shield: <><path d="M12 3 5 6v5c0 4.6 2.9 8.2 7 10 4.1-1.8 7-5.4 7-10V6z"/><path d="m9 12 2 2 4-4"/></>,
  sparkles: <><path d="m12 3 1.4 3.6L17 8l-3.6 1.4L12 13l-1.4-3.6L7 8l3.6-1.4z"/><path d="m18.5 14 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8zM5 14l.8 2.2L8 17l-2.2.8L5 20l-.8-2.2L2 17l2.2-.8z"/></>,
  "user-check": <><circle cx="9" cy="8" r="3"/><path d="M3 20c.5-4 2.5-6 6-6 1.4 0 2.6.3 3.5.9M15 18l2 2 4-5"/></>,
  wallet: <><path d="M4 6h14a2 2 0 0 1 2 2v10H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h12"/><path d="M15 11h5v4h-5a2 2 0 0 1 0-4z"/></>,
  x: <path d="m6 6 12 12M18 6 6 18"/>,
};

export function Icon({ name, className = "h-5 w-5", ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      {paths[name]}
    </svg>
  );
}
