import type { Metadata } from "next";
import { UserDashboard } from "@/features/dashboard/UserDashboard";

export const metadata: Metadata = {
  title: "Account dashboard",
  description: "View your verified StellarTrust account and settlement activity.",
};

export default function DashboardPage() {
  return (
    <main id="main-content" className="min-h-[calc(100vh-4rem)]">
      <div className="mx-auto max-w-[1440px] px-md py-xl sm:px-lg sm:py-xxl">
        <UserDashboard />
      </div>
    </main>
  );
}
