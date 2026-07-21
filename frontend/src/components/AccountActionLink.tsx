"use client";

import Link from "next/link";
import { Icon } from "@/components/Icon";
import { useIdentity } from "@/components/IdentityProvider";

export function AccountActionLink({
  className = "btn-primary",
  verificationLabel = "Get verified",
  dashboardLabel = "Open dashboard",
}: {
  className?: string;
  verificationLabel?: string;
  dashboardLabel?: string;
}) {
  const { isVerified } = useIdentity();
  return (
    <Link href={isVerified ? "/dashboard" : "/kyc"} className={className}>
      {isVerified ? dashboardLabel : verificationLabel}
      <Icon name="arrow-right" className="h-4 w-4" />
    </Link>
  );
}
