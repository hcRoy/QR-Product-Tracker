import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { vendorProducts } from "../lib/phase2";
import { fmtDate } from "../lib/format";
import { Badge, ErrorState, Skeleton } from "../components/ui";

export default function VendorProducts() {
  const q = useQuery({ queryKey: ["vendor-products"], queryFn: vendorProducts });
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-brand">My products</h1>
        <p className="mt-1 text-sm text-slate-500">Units you or your organization have scanned. Price and QR tokens are not included.</p>
      </header>
      {q.isLoading ? (
        <div className="space-y-2"><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
      ) : q.isError ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : (q.data ?? []).length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center">
          <p className="font-medium text-slate-800">Nothing here yet</p>
          <p className="mt-1 text-sm text-slate-500">Products appear after a unit is scanned.</p>
          <Link to="/v/scan" className="mt-4 inline-flex min-h-11 items-center rounded-xl bg-brand px-4 text-sm font-semibold text-white">Scan a code</Link>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {q.data!.map((p) => (
            <li key={`${p.name}-${p.batch_number}`} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:p-5">
              <div className="flex items-start justify-between gap-2">
                <p className="font-semibold text-slate-900">{p.name}</p>
                {p.is_expired && <Badge tone="red">Expired</Badge>}
              </div>
              <p className="mt-1 text-sm text-slate-500">{[p.batch_number, p.sku, p.manufacturer].filter(Boolean).join(" · ") || "No batch"}</p>
              <p className="mt-2 text-xs text-slate-400">
                {p.units_seen} unit{p.units_seen === 1 ? "" : "s"} · last {fmtDate(p.last_scanned_at)}
                {p.expiry_date ? ` · expires ${fmtDate(p.expiry_date)}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
