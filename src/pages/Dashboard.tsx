import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getActivity, getMetrics, listScans } from "../lib/api";
import { supplyMetrics } from "../lib/phase2";
import { fmtDate } from "../lib/format";
import { Card, EmptyState, ErrorState, PageHeader, Skeleton, Button } from "../components/ui";
import { ScanTable } from "../components/ScanTable";

function Stat({ label, value, hint, to }: { label: string; value: number | undefined; hint?: string; to?: string }) {
  const body = (
    <Card className="h-full transition hover:shadow-md">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-3xl font-semibold text-brand">{value ?? <Skeleton className="h-8 w-16" />}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </Card>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

function ActivityChart({ data }: { data: { day: string; scans: number; flagged: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.scans));
  const w = 600, h = 140, bw = w / data.length;
  return (
    <svg viewBox={`0 0 ${w} ${h + 18}`} role="img" aria-label="Scans per day, last 30 days" className="w-full">
      {data.map((d, i) => {
        const bh = (d.scans / max) * h, fh = (d.flagged / max) * h;
        return (
          <g key={d.day}>
            <title>{`${fmtDate(d.day)}: ${d.scans} scans, ${d.flagged} flagged`}</title>
            <rect x={i * bw + 2} y={h - bh} width={bw - 4} height={bh} rx={2} fill="#203562" />
            {fh > 0 && <rect x={i * bw + 2} y={h - fh} width={bw - 4} height={fh} rx={2} fill="#dc2626" />}
          </g>
        );
      })}
      <text x="0" y={h + 14} fontSize="10" fill="#64748b">{fmtDate(data[0]?.day)}</text>
      <text x={w} y={h + 14} fontSize="10" fill="#64748b" textAnchor="end">{fmtDate(data.at(-1)?.day)}</text>
    </svg>
  );
}

export default function Dashboard() {
  const m = useQuery({ queryKey: ["metrics"], queryFn: getMetrics });
  const act = useQuery({ queryKey: ["activity"], queryFn: () => getActivity(30) });
  const recent = useQuery({ queryKey: ["scans", "recent"], queryFn: () => listScans({ page: 1, pageSize: 6 }) });
  const susp = useQuery({ queryKey: ["scans", "suspicious-recent"], queryFn: () => listScans({ page: 1, pageSize: 5, flaggedOnly: true }) });
  const chain = useQuery({ queryKey: ["supply-metrics"], queryFn: supplyMetrics });

  if (m.isError) return <ErrorState error={m.error} retry={() => m.refetch()} />;
  const d = m.data;
  if (d && d.products_total === 0) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <EmptyState title="Welcome — no products yet">
          <p>Register your first product to generate unique QR codes for each physical unit.</p>
          <Link to="/products/new"><Button className="mt-4">Add your first product</Button></Link>
        </EmptyState>
      </>
    );
  }
  return (
    <>
      <PageHeader title="Dashboard" sub={d ? `Counts use the ${d.timezone} time zone. A scan is a reported device location, not proof of physical presence.` : undefined}
        actions={<Link to="/products/new"><Button>Add product</Button></Link>} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Total products" value={d?.products_total} to="/products" />
        <Stat label="Active products" value={d?.products_active} />
        <Stat label="Products scanned" value={d?.products_scanned} hint="At least one unit scanned" />
        <Stat label="Never scanned" value={d?.products_never_scanned} hint="No unit scanned yet" to="/products" />
        <Stat label="Total scans" value={d?.scans_total} to="/scans" />
        <Stat label="Scans today" value={d?.scans_today} />
        <Stat label="Expired" value={d?.expired_products} hint="Active products past expiry" />
        <Stat label="Expiring soon" value={d?.expiring_soon} hint="Within the configured window" />
        {chain.data && <>
          <Stat label="In transit" value={chain.data.units_in_transit} to="/shipments" />
          <Stat label="Open discrepancies" value={chain.data.open_discrepancies} to="/discrepancies" />
          <Stat label="Overdue shipments" value={chain.data.overdue_shipments} hint="Past the configured number of days" to="/shipments" />
          <Stat label="Active locations" value={chain.data.locations} to="/locations" />
        </>}
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <h2 className="mb-3 font-semibold text-slate-800">Scan activity, last 30 days <span className="ml-2 text-xs font-normal text-slate-500">red = flagged</span></h2>
          {act.isLoading ? <Skeleton className="h-40" /> : act.isError ? <ErrorState error={act.error} retry={() => act.refetch()} /> : <ActivityChart data={act.data ?? []} />}
        </Card>
        <Card>
          <h2 className="mb-3 font-semibold text-slate-800">Unit scan status</h2>
          {d ? (
            <div className="space-y-3 text-sm">
              <Bar label="Scanned" value={d.units_scanned} total={d.units_total} color="bg-brand" />
              <Bar label="Never scanned" value={d.units_never_scanned} total={d.units_total} color="bg-slate-300" />
              <p className="pt-2 text-xs text-slate-500">{d.units_suspicious_30d} unit(s) with suspicious activity in the last 30 days.</p>
            </div>
          ) : <Skeleton className="h-24" />}
        </Card>
      </div>
      <Card className="mt-6 !p-0">
        <h2 className="p-5 pb-3 font-semibold text-slate-800">Recent suspicious activity</h2>
        {susp.isError ? <ErrorState error={susp.error} retry={() => susp.refetch()} /> : susp.data?.rows.length === 0 ? <p className="px-5 pb-5 text-sm text-slate-500">Nothing flagged. Indicators are for investigation, not proof of counterfeiting.</p> : <ScanTable rows={susp.data?.rows ?? []} />}
      </Card>
      <Card className="mt-6 !p-0">
        <h2 className="p-5 pb-3 font-semibold text-slate-800">Recent scans</h2>
        {recent.isError ? <ErrorState error={recent.error} retry={() => recent.refetch()} /> : recent.data?.rows.length === 0 ? <p className="px-5 pb-5 text-sm text-slate-500">No scans recorded yet. Scan a printed QR code with a phone to see events here.</p> : <ScanTable rows={recent.data?.rows ?? []} />}
      </Card>
    </>
  );
}

function Bar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <div><div className="mb-1 flex justify-between"><span>{label}</span><span className="text-slate-500">{value} ({pct}%)</span></div>
      <div className="h-2 rounded bg-slate-100"><div className={`h-2 rounded ${color}`} style={{ width: `${pct}%` }} /></div></div>
  );
}
