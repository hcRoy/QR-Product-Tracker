import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../lib/auth";
import { vendorSummary } from "../lib/phase2";
import { IconBox, IconInbox, IconOutbox, IconScan } from "../components/VendorIcons";
import { ErrorState, Skeleton } from "../components/ui";

export default function VendorHome() {
  const { name } = useAuth();
  const q = useQuery({ queryKey: ["vendor-summary"], queryFn: vendorSummary });
  const first = (name ?? "there").split(/\s+/)[0];

  return (
    <div className="space-y-6 md:space-y-8">
      <section className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="max-w-2xl">
          <p className="text-sm font-medium text-slate-500">Welcome back</p>
          <h1 className="mt-0.5 text-2xl font-semibold tracking-tight text-brand sm:text-3xl md:text-4xl">{first}</h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-600 md:text-base">
            You see scans from your organization. Custody actions only work at locations a manager assigned to you.
          </p>
        </div>
        <Link
          to="/v/scan"
          className="inline-flex min-h-12 shrink-0 items-center justify-center gap-2 rounded-2xl bg-brand px-6 py-3.5 text-base font-semibold text-white shadow-sm shadow-brand/20 transition hover:bg-brand-600 md:min-h-14 md:px-8"
        >
          <IconScan className="text-indigo-100" />
          Scan a product
        </Link>
      </section>

      {q.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Skeleton className="h-32" /><Skeleton className="h-32" /><Skeleton className="h-32" /><Skeleton className="h-32" />
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Link
            to="/v/shipments"
            className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-brand/30 hover:shadow-md"
          >
            <span className="inline-flex rounded-lg bg-accent p-2.5 text-brand"><IconInbox /></span>
            <p className="mt-4 text-3xl font-semibold tabular-nums text-brand md:text-4xl">{q.data?.inbound ?? 0}</p>
            <p className="mt-1 text-xs font-medium uppercase tracking-wide text-slate-500">Inbound</p>
            <p className="mt-2 text-sm text-slate-500">Shipments waiting at your locations</p>
          </Link>
          <Link
            to="/v/shipments"
            className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-brand/30 hover:shadow-md"
          >
            <span className="inline-flex rounded-lg bg-accent p-2.5 text-brand"><IconOutbox /></span>
            <p className="mt-4 text-3xl font-semibold tabular-nums text-brand md:text-4xl">{q.data?.to_dispatch ?? 0}</p>
            <p className="mt-1 text-xs font-medium uppercase tracking-wide text-slate-500">To dispatch</p>
            <p className="mt-2 text-sm text-slate-500">Draft shipments ready to send</p>
          </Link>
          <Link
            to="/v/products"
            className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-brand/30 hover:shadow-md"
          >
            <span className="inline-flex rounded-lg bg-accent p-2.5 text-brand"><IconBox /></span>
            <p className="mt-4 text-lg font-semibold text-brand md:text-xl">My products</p>
            <p className="mt-2 text-sm text-slate-500">Units your organization has scanned</p>
          </Link>
          <Link
            to="/v/scans"
            className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-brand/30 hover:shadow-md"
          >
            <span className="inline-flex rounded-lg bg-accent p-2.5 text-brand"><IconScan /></span>
            <p className="mt-4 text-lg font-semibold text-brand md:text-xl">Recent scans</p>
            <p className="mt-2 text-sm text-slate-500">Your scan history and staff activity</p>
          </Link>
        </div>
      )}

      <p className="max-w-3xl rounded-xl bg-slate-100/80 px-4 py-3 text-xs leading-relaxed text-slate-500 md:text-sm">
        A scan is a device report. It does not by itself prove the product is genuine.
      </p>
    </div>
  );
}
