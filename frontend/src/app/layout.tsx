import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "StellarTrust",
  description:
    "AI-powered cross-border escrow, liquidity settlement, and RWA tokenization on Stellar.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
