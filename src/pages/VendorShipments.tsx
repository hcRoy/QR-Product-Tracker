import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dispatchShipment, vendorShipmentDetail, vendorShipments } from "../lib/phase2";
import { Badge, Button, ErrorState, Skeleton } from "../components/ui";

const statusTone = {
  draft: "slate",
  in_transit: "blue",
  partially_received: "amber",
  received: "green",
  cancelled: "red",
} as const;

export default function VendorShipments() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["vendor-shipments"], queryFn: vendorShipments });
  const [open, setOpen] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ["vendor-shipment", open], queryFn: () => vendorShipmentDetail(open!), enabled: !!open });
  const send = useMutation({
    mutationFn: (id: string) => dispatchShipment(id, crypto.randomUUID()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vendor-shipments"] }),
  });

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-brand">Shipments</h1>
        <p className="mt-1 text-sm text-slate-500">Dispatch from a location assigned to you. Receive by scanning at the destination.</p>
      </header>
      {q.isLoading ? (
        <div className="space-y-2"><Skeleton className="h-28" /><Skeleton className="h-28" /></div>
      ) : q.isError ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : (q.data ?? []).length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center">
          <p className="font-medium text-slate-800">No open shipments</p>
          <p className="mt-1 text-sm text-slate-500">Nothing is waiting at your locations right now.</p>
        </div>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {q.data!.map((s) => (
            <li key={s.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:p-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-slate-900">{s.reference}</p>
                  <p className="mt-1 text-sm text-slate-600">{s.origin_name} → {s.destination_name}</p>
                </div>
                <Badge tone={statusTone[s.status as keyof typeof statusTone] ?? "slate"}>{s.status.replace(/_/g, " ")}</Badge>
              </div>
              <p className="mt-2 text-xs font-medium uppercase tracking-wide text-slate-400">{s.units} units</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {s.can_dispatch && (
                  <Button className="min-h-11 flex-1 sm:flex-none" disabled={send.isPending} onClick={() => send.mutate(s.id)}>
                    Dispatch
                  </Button>
                )}
                <Button variant="secondary" className="min-h-11 flex-1 sm:flex-none" onClick={() => setOpen(open === s.id ? null : s.id)}>
                  {open === s.id ? "Hide units" : "View units"}
                </Button>
              </div>
              {open === s.id && (
                <div className="mt-3 rounded-xl bg-slate-50 p-3">
                  {detail.isLoading ? (
                    <Skeleton className="h-12" />
                  ) : detail.isError ? (
                    <ErrorState error={detail.error} retry={() => detail.refetch()} />
                  ) : (detail.data?.units ?? []).length === 0 ? (
                    <p className="text-sm text-slate-500">No units you are allowed to see. Staff see units they have scanned. Owners and managers see the shipment.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {detail.data!.units.map((u) => (
                        <li key={u.unit_label} className="text-sm text-slate-700">
                          <span className="font-medium">{u.unit_label}</span>
                          <span className="text-slate-500"> · {u.product_name} · {u.line_status}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {send.isError && <p role="alert" className="text-sm text-red-700">{(send.error as Error).message}</p>}
    </div>
  );
}
