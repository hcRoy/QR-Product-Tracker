import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { listRejected, listScans } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import { Badge, Card, EmptyState, ErrorState, Input, PageHeader, Pager, TableSkeleton } from "../components/ui";
import { ScanTable } from "../components/ScanTable";

type Tab = "all" | "suspicious" | "rejected";
const PAGE = 20;

export default function ScanHistory() {
  const [sp] = useSearchParams();
  const productId = sp.get("product") ?? undefined;
  const [tab, setTab] = useState<Tab>("all");
  const [page, setPage] = useState(1);
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const switchTab = (t: Tab) => { setTab(t); setPage(1); };

  const scans = useQuery({ queryKey: ["scans", tab, page, from, to, productId], enabled: tab !== "rejected", placeholderData: keepPreviousData,
    queryFn: () => listScans({ page, pageSize: PAGE, productId, flaggedOnly: tab === "suspicious", from, to }) });
  const rejected = useQuery({ queryKey: ["rejected", page], enabled: tab === "rejected", queryFn: () => listRejected(page) });
  const q = tab === "rejected" ? rejected : scans;

  return (
    <>
      <PageHeader title="Scan history" sub={productId ? "Filtered to one product" : "All recorded scan events and suspicious activity"} />
      <div role="tablist" className="mb-4 flex gap-2">
        {([["all", "All scans"], ["suspicious", "Suspicious activity"], ["rejected", "Rejected attempts"]] as const).map(([t, l]) =>
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => switchTab(t)} className={`rounded-lg px-3 py-2 text-sm font-medium ${tab === t ? "bg-brand text-white" : "bg-white text-brand ring-1 ring-slate-300 hover:bg-accent"}`}>{l}</button>)}
      </div>
      {tab !== "rejected" && <Card className="mb-4 grid max-w-md grid-cols-2 gap-3">
        <Input type="date" aria-label="From date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} />
        <Input type="date" aria-label="To date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} /></Card>}
      {tab === "suspicious" && <p className="mb-3 text-sm text-slate-500">Indicators are leads for investigation. They are not proof of counterfeiting.</p>}
      <Card className="!p-0 overflow-hidden">
        {q.isLoading ? <TableSkeleton /> : q.isError ? <div className="p-4"><ErrorState error={q.error} retry={() => q.refetch()} /></div> :
          q.data!.rows.length === 0 ? <div className="p-6"><EmptyState title="Nothing to show" /></div> :
          tab === "rejected" ? (
            <table className="w-full text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">When</th><th className="px-4 py-3">Reason</th><th className="px-4 py-3">Token fingerprint</th><th className="px-4 py-3">Linked unit</th></tr></thead>
              <tbody className="divide-y divide-slate-100">{rejected.data!.rows.map((r) => <tr key={r.id}><td className="px-4 py-3">{fmtDateTime(r.created_at)}</td>
                <td className="px-4 py-3"><Badge tone="red">{r.reason.replace(/_/g, " ")}</Badge></td><td className="px-4 py-3 font-mono text-xs">{r.token_fingerprint}</td><td className="px-4 py-3 text-xs">{r.unit_id ? "Known unit (revoked/replaced token)" : "Unknown token"}</td></tr>)}</tbody></table>
          ) : <ScanTable rows={scans.data!.rows} />}
        {q.data && <Pager page={page} pageSize={tab === "rejected" ? 25 : PAGE} total={q.data.total} onPage={setPage} />}
      </Card>
    </>
  );
}
