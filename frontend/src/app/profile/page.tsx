import type { Metadata } from "next";
import { ProfilePanel } from "@/features/profile/ProfilePanel";

export const metadata: Metadata = {
  title: "Your profile",
  description: "Your StellarTrust username, profile picture, and account details.",
};

export default function ProfilePage() {
  return (
    <main id="main-content" className="min-h-[calc(100dvh-4rem)]">
      <div className="mx-auto max-w-[1440px] px-md py-xl sm:px-lg sm:py-xxl">
        <ProfilePanel />
      </div>
    </main>
  );
}
