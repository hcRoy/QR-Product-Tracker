import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { vendorScans, type VendorScan } from "../lib/phase2";
import { fmtDateTime, fmtPlace } from "../lib/format";
import { Badge, Button, ErrorState, Skeleton } from "../components/ui";

const LOC_LABEL: Record<string, string> = {
  granted: "Location shared",
  denied: "No GPS (permission not shared)",
  unavailable: "No GPS (device unavailable)",
  timeout: "No GPS (timed out)",
  unsupported: "No GPS (not supported here)",
};

export default function VendorScans() {
  const [before, setBefore] = useState<{ at?: string; id?: string }>({});
  const [earlier, setEarlier] = useState<VendorScan[]>([]);
  const q = useQuery({
    queryKey: ["vendor-scans", before.at ?? "", before.id ?? ""],
    queryFn: () => vendorScans(before.at, before.id),
  });
  const page = q.data?.rows ?? [];
  const shown = [...earlier, ...page];

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-brand">My scans</h1>
        <p className="mt-1 text-sm text-slate-500">Your own scans. Owners and managers also see scans made by their staff.</p>
      </header>
      {q.isLoading && shown.length === 0 ? (
        <div className="space-y-2"><Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div>
      ) : q.isError ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : shown.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center">
          <p className="font-medium text-slate-800">No scans yet</p>
          <p className="mt-1 text-sm text-slate-500">Scan a product code to record one.</p>
          <Link to="/v/scan" className="mt-4 inline-flex min-h-11 items-center rounded-xl bg-brand px-4 text-sm font-semibold text-white">Open scanner</Link>
        </div>
      ) : (
        <>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {shown.map((s) => {
              const place = fmtPlace(s);
              return (
                <li key={s.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:p-5">
                  <p className="font-semibold text-slate-900">{s.product_name}</p>
                  <p className="mt-0.5 font-mono text-xs text-slate-500">{s.unit_label}</p>
                  {place ? (
                    <p className="mt-2 text-sm text-slate-600">{place}</p>
                  ) : (
                    <p className="mt-2"><Badge tone="slate">{LOC_LABEL[s.location_status] ?? `No GPS (${s.location_status})`}</Badge></p>
                  )}
                  <p className="mt-1 text-xs text-slate-400">{fmtDateTime(s.scanned_at)}</p>
                </li>
              );
            })}
          </ul>
          {page.length === 25 && (
            <Button
              variant="secondary"
              className="mt-2 min-h-11 w-full md:w-auto"
              disabled={q.isFetching}
              onClick={() => {
                const last = page[page.length - 1];
                setEarlier(shown);
                setBefore({ at: last.scanned_at, id: last.id });
              }}
            >
              {q.isFetching ? "Loading…" : "Load more"}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
