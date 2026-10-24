import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { adminDiscrepancies, resolveDiscrepancy } from "../lib/phase2";
import { fmtDateTime } from "../lib/format";
import { Button, Card, ErrorState, PageHeader, Skeleton } from "../components/ui";

export default function Discrepancies() {
  const qc = useQueryClient();
  const [status, setStatus] = useState("open");
  const q = useQuery({ queryKey: ["discrepancies", status], queryFn: () => adminDiscrepancies(status) });
  const resolve = useMutation({ mutationFn: (id: string) => resolveDiscrepancy(id, "reviewed"), onSuccess: () => qc.invalidateQueries({ queryKey: ["discrepancies"] }) });
  return (
    <>
      <PageHeader title="Discrepancies" sub="A mismatch is recorded and left open. It does not by itself finish a shipment or prove tampering."
        actions={<Button variant="secondary" onClick={() => setStatus(status === "open" ? "" : "open")}>{status === "open" ? "Show all" : "Open only"}</Button>} />
      {q.isLoading ? <Skeleton className="h-32" /> : q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : (q.data ?? []).length === 0 ? (
        <Card><p className="text-sm text-slate-500">No discrepancies.</p></Card>
      ) : q.data!.map((d) => (
        <Card key={d.id} className="mb-3 !p-3">
          <p className="font-medium">{d.kind.replace(/_/g, " ")} · {d.status}</p>
          <p className="text-sm text-slate-600">{[d.product_name, d.unit_label, d.location_name].filter(Boolean).join(" · ")}</p>
          <p className="text-xs text-slate-500">{fmtDateTime(d.created_at)}{d.note ? ` · ${d.note}` : ""}</p>
          {d.status === "open" && <Button className="mt-2" variant="secondary" disabled={resolve.isPending} onClick={() => resolve.mutate(d.id)}>Mark resolved</Button>}
        </Card>
      ))}
    </>
  );
}
