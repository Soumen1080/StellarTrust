import type { Metadata } from "next";
import { Icon } from "@/components/Icon";
import { AdminConsole } from "@/features/admin/AdminConsole";

export const metadata: Metadata = { title: "Operations console" };

export default function AdminPage() {
  return (
    <main id="main-content" className="min-h-[calc(100dvh-4rem)]">
      <div className="mx-auto max-w-[1440px] px-md py-xl sm:px-lg sm:py-xxl">
        <header className="mb-lg flex flex-col justify-between gap-md border-b border-hairline-dark pb-lg sm:mb-xl sm:gap-lg sm:pb-xl lg:flex-row lg:items-end">
          <div>
            <p className="eyebrow">Operations</p>
            <h1 className="mt-sm text-3xl font-bold tracking-tight text-on-dark sm:text-4xl">
              Console
            </h1>
            <p className="mt-sm max-w-2xl leading-7 text-muted-strong">
              What the book is doing, what is waiting on a decision, and the
              policy that decides what waits. Read-only with respect to money:
              nothing here posts a ledger entry or moves units.
            </p>
          </div>
          <span className="inline-flex w-fit items-center gap-xs rounded-pill border border-hairline-dark px-md py-sm text-xs font-medium text-muted-strong">
            <Icon name="shield" className="h-4 w-4 text-status-review" />
            Compliance role required
          </span>
        </header>
        <AdminConsole />
      </div>
    </main>
  );
}
