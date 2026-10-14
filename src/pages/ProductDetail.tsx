import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { addUnits, getProduct, listProducts, listScans, listUnits, revokeUnit, rotateToken, setProductStatus, type UnitRow } from "../lib/api";
import { downloadDataUrl, downloadText, printLabels, qrPngDataUrl, qrSvg, trackingUrl } from "../lib/qr";
import { fmtCoords, fmtDate, fmtDateTime, fmtMoney } from "../lib/format";
import { Badge, Button, Card, ErrorState, Input, PageHeader, Pager, Skeleton, TableSkeleton } from "../components/ui";
import { ConfirmDialog, Dialog } from "../components/Dialog";
import { FlagBadges, ScanTable } from "../components/ScanTable";

const Row = ({ k, v }: { k: string; v: React.ReactNode }) => <div className="flex justify-between gap-4 border-b border-slate-100 py-2 text-sm"><dt className="text-slate-500">{k}</dt><dd className="text-right font-medium">{v ?? "—"}</dd></div>;

function QrDialog({ unit, product, onClose }: { unit: UnitRow | null; product: { name: string; batch_number: string | null }; onClose: () => void }) {
  const [png, setPng] = useState("");
  const label = unit ? `${(product.batch_number ?? "NB").toUpperCase()}-${String(unit.serial).padStart(5, "0")}` : "";
  useEffect(() => { setPng(""); if (unit) qrPngDataUrl(trackingUrl(unit.token)).then(setPng); }, [unit]);
  return (
    <Dialog open={!!unit} onClose={onClose} title={`QR code · ${label}`}>
      {unit && <>
        <div className="grid place-items-center rounded-lg bg-slate-50 p-3">{png ? <img src={png} alt={`QR code for unit ${label}`} className="h-56 w-56" /> : <Skeleton className="h-56 w-56" />}</div>
        <p className="break-all rounded bg-slate-50 p-2 font-mono text-xs text-slate-600">{trackingUrl(unit.token)}</p>
        {unit.status === "revoked" && <p className="text-sm text-red-700">This token is revoked: scans are rejected until you rotate it.</p>}
        <div className="flex flex-wrap gap-2">
          <Button disabled={!png} onClick={() => downloadDataUrl(png, `${label}.png`)}>Download PNG</Button>
          <Button variant="secondary" onClick={async () => downloadText(await qrSvg(trackingUrl(unit.token)), `${label}.svg`, "image/svg+xml")}>Download SVG</Button>
          <Button variant="secondary" onClick={() => printLabels([{ token: unit.token, label, productName: product.name, batch: product.batch_number }]).catch((e) => alert(e.message))}>Print label</Button>
        </div>
      </>}
    </Dialog>
  );
}

export default function ProductDetail() {
  const { id = "" } = useParams();
  const [sp] = useSearchParams();
  const qc = useQueryClient();
  const [unitPage, setUnitPage] = useState(1);
  const [scanPage, setScanPage] = useState(1);
  const [qrUnit, setQrUnit] = useState<UnitRow | null>(null);
  const [action, setAction] = useState<{ kind: "rotate" | "revoke"; unit: UnitRow } | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [extra, setExtra] = useState("10");

  const p = useQuery({ queryKey: ["product", id], queryFn: () => getProduct(id) });
  const units = useQuery({ queryKey: ["units", id, unitPage], queryFn: () => listUnits(id, unitPage) });
  const scans = useQuery({ queryKey: ["scans", "product", id, scanPage], queryFn: () => listScans({ page: scanPage, pageSize: 10, productId: id }) });
  const batchmates = useQuery({ queryKey: ["batch", p.data?.batch_number, id], enabled: !!p.data?.batch_number,
    queryFn: () => listProducts({ page: 1, pageSize: 6, search: p.data!.batch_number!, status: "", category: "", expiry: "", scanState: "" }) });

  const refresh = () => { qc.invalidateQueries({ queryKey: ["units", id] }); qc.invalidateQueries({ queryKey: ["product", id] }); qc.invalidateQueries({ queryKey: ["products"] }); qc.invalidateQueries({ queryKey: ["metrics"] }); };
  const unitAction = useMutation({
    mutationFn: ({ kind, unit, reason }: { kind: "rotate" | "revoke"; unit: UnitRow; reason: string }) => kind === "rotate" ? rotateToken(unit.id, reason) : revokeUnit(unit.id, reason),
    onSuccess: () => { setAction(null); refresh(); },
  });
  const add = useMutation({ mutationFn: (n: number) => addUnits(id, n), onSuccess: refresh });
  const status = useMutation({ mutationFn: (s: "active" | "archived") => setProductStatus(id, s), onSuccess: () => { setArchiveOpen(false); refresh(); } });

  if (p.isLoading) return <Skeleton className="h-96" />;
  if (p.isError) return <ErrorState error={p.error} retry={() => p.refetch()} />;
  const d = p.data!;
  const firstUnit = units.data?.rows[0];
  const n = Number(extra);

  return (
    <>
      <PageHeader title={d.name} sub={[d.sku, d.batch_number && `Batch ${d.batch_number}`].filter(Boolean).join(" · ") || undefined}
        actions={<>
          <Link to={`/products/${id}/edit`}><Button variant="secondary">Edit</Button></Link>
          <Link to={`/map?product=${id}`}><Button variant="secondary">View on map</Button></Link>
          {d.status === "active" ? <Button variant="danger" onClick={() => setArchiveOpen(true)}>Archive</Button> : <Button variant="secondary" onClick={() => status.mutate("active")}>Restore</Button>}
        </>} />

      {sp.get("new") && firstUnit && (
        <Card className="mb-5 border-emerald-200 bg-emerald-50">
          <h2 className="font-semibold text-emerald-900">Product created with {d.unit_count} QR code(s)</h2>
          <p className="mt-1 text-sm text-emerald-800">First unit ID: <span className="font-mono">{d.batch_number?.toUpperCase() ?? "NB"}-00001</span></p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={() => setQrUnit(firstUnit)}>Preview / download QR</Button>
            <Button variant="secondary" onClick={() => units.data && printLabels(units.data.rows.map((u) => ({ token: u.token, label: `${(d.batch_number ?? "NB").toUpperCase()}-${String(u.serial).padStart(5, "0")}`, productName: d.name, batch: d.batch_number }))).catch((e) => alert(e.message))}>Print labels</Button>
          </div>
        </Card>)}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <h2 className="mb-2 font-semibold text-slate-800">Product and package</h2>
          <dl className="grid gap-x-8 md:grid-cols-2">
            <Row k="Status" v={<Badge tone={d.status === "active" ? "green" : "slate"}>{d.status}</Badge>} />
            <Row k="Manufacturer" v={d.manufacturer} /><Row k="Category" v={d.category} />
            <Row k="Manufactured" v={fmtDate(d.manufacturing_date)} />
            <Row k="Expires" v={<>{fmtDate(d.expiry_date)} {d.is_expired && <Badge tone="red">Expired</Badge>}</>} />
            <Row k="Unit price" v={fmtMoney(d.unit_price, d.currency)} />
            <Row k="Package" v={[d.package_type, d.package_quantity && `${d.package_quantity} ${d.unit_of_measure ?? ""}`].filter(Boolean).join(" · ") || "—"} />
          </dl>
          {d.package_description && <p className="mt-3 text-sm text-slate-600">{d.package_description}</p>}
          {d.description && <p className="mt-2 text-sm text-slate-600">{d.description}</p>}
        </Card>
        <Card>
          <h2 className="mb-2 font-semibold text-slate-800">Last reported scan location</h2>
          {d.last_scan_at ? (
            <div className="space-y-1 text-sm">
              <p>{fmtDateTime(d.last_scan_at)}</p>
              <p className="font-mono">{fmtCoords(d.last_scan_lat, d.last_scan_lon)}</p>
              {d.last_scan_accuracy_m != null && <p className="text-slate-500">Accuracy ±{Math.round(d.last_scan_accuracy_m)} m</p>}
            </div>) : <p className="text-sm text-slate-500">Never scanned.</p>}
          <p className="mt-3 text-xs text-slate-500">Reported by a device at scan time. It is not a verified handover or a confirmed inventory location.</p>
          <p className="mt-3 text-sm">{d.scanned_units} of {d.unit_count} units scanned</p>
        </Card>
      </div>

      <Card id="units" className="mt-5 !p-0 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 p-5 pb-3">
          <h2 className="font-semibold text-slate-800">Units and QR codes</h2>
          <div className="flex items-center gap-2">
            <Button variant="secondary" disabled={!units.data} onClick={() => printLabels(units.data!.rows.map((u) => ({ token: u.token, label: `${(d.batch_number ?? "NB").toUpperCase()}-${String(u.serial).padStart(5, "0")}`, productName: d.name, batch: d.batch_number }))).catch((e) => alert(e.message))}>Print labels (this page)</Button>
            {d.status === "active" && <><Input aria-label="Units to add" className="w-20" inputMode="numeric" value={extra} onChange={(e) => setExtra(e.target.value)} />
              <Button disabled={add.isPending || !(n >= 1 && n <= 1000)} onClick={() => add.mutate(n)}>Add units</Button></>}
          </div>
        </div>
        {add.isError && <p role="alert" className="px-5 pb-2 text-sm text-red-600">{(add.error as Error).message}</p>}
        {units.isLoading ? <TableSkeleton rows={4} /> : units.isError ? <div className="p-4"><ErrorState error={units.error} retry={() => units.refetch()} /></div> : (
          <div className="overflow-x-auto"><table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Unit</th><th className="px-4 py-3">Token</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Scans</th><th className="px-4 py-3">Last scan</th><th className="px-4 py-3" /></tr></thead>
            <tbody className="divide-y divide-slate-100">{units.data!.rows.map((u) => (
              <tr key={u.id}>
                <td className="px-4 py-3 font-mono text-xs">{(d.batch_number ?? "NB").toUpperCase()}-{String(u.serial).padStart(5, "0")}</td>
                <td className="px-4 py-3 font-mono text-xs text-slate-500">{u.token.slice(0, 6)}…</td>
                <td className="px-4 py-3"><Badge tone={u.status === "active" ? "green" : "red"}>{u.status}</Badge></td>
                <td className="px-4 py-3">{u.scan_count}</td>
                <td className="px-4 py-3">{fmtDateTime(u.last_scan_at)}</td>
                <td className="space-x-3 whitespace-nowrap px-4 py-3 text-right text-xs">
                  <button className="text-brand hover:underline" onClick={() => setQrUnit(u)}>QR</button>
                  <button className="text-brand hover:underline" onClick={() => setAction({ kind: "rotate", unit: u })}>Replace token</button>
                  {u.status === "active" && <button className="text-red-700 hover:underline" onClick={() => setAction({ kind: "revoke", unit: u })}>Revoke</button>}
                </td></tr>))}</tbody></table></div>)}
        {units.data && <Pager page={unitPage} pageSize={50} total={units.data.total} onPage={setUnitPage} />}
      </Card>

      <Card className="mt-5 !p-0 overflow-hidden">
        <h2 className="p-5 pb-3 font-semibold text-slate-800">Scan history</h2>
        {scans.isLoading ? <TableSkeleton rows={3} /> : scans.isError ? <div className="p-4"><ErrorState error={scans.error} retry={() => scans.refetch()} /></div> :
          scans.data!.rows.length === 0 ? <p className="px-5 pb-5 text-sm text-slate-500">No scans recorded for this product yet.</p> : <ScanTable rows={scans.data!.rows} showProduct={false} />}
        {scans.data && <Pager page={scanPage} pageSize={10} total={scans.data.total} onPage={setScanPage} />}
        <p className="px-5 pb-4 text-xs text-slate-500">Indicators such as <FlagBadges flags={["rapid_repeat"]} /> are leads for investigation, not proof of counterfeiting. GPS can be inaccurate or spoofed, and a QR code can be copied.</p>
      </Card>

      {!!batchmates.data?.rows.filter((r) => r.id !== id).length && (
        <Card className="mt-5"><h2 className="mb-2 font-semibold text-slate-800">Other products in this batch</h2>
          <ul className="text-sm">{batchmates.data.rows.filter((r) => r.id !== id && r.batch_number === d.batch_number).map((r) => <li key={r.id}><Link className="text-brand hover:underline" to={`/products/${r.id}`}>{r.name}</Link></li>)}</ul></Card>)}

      <QrDialog unit={qrUnit} product={d} onClose={() => setQrUnit(null)} />
      <ConfirmDialog open={!!action} onClose={() => setAction(null)} withReason danger={action?.kind === "revoke"} busy={unitAction.isPending}
        title={action?.kind === "rotate" ? "Replace this QR token?" : "Revoke this QR token?"}
        confirmLabel={action?.kind === "rotate" ? "Replace token" : "Revoke"}
        body={action?.kind === "rotate" ? "A new token is issued for the same unit. The old printed label stops working and any further scans of it are logged as invalid attempts. You must reprint the label."
          : "Scans of this unit's QR code will be rejected and logged. You can re-enable it later by replacing the token."}
        onConfirm={(reason) => action && unitAction.mutate({ ...action, reason })} />
      <ConfirmDialog open={archiveOpen} onClose={() => setArchiveOpen(false)} danger title="Archive product?" confirmLabel="Archive" busy={status.isPending}
        body="All QR codes for this product stop recording new scans. History is kept and you can restore it." onConfirm={() => status.mutate("archived")} />
    </>
  );
}
