import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import L from "leaflet";
import { maplibreGL, mapStyle } from "../lib/mapSetup";
import { getMapPoints, listProducts, type MapPoint } from "../lib/api";
import { FLAG_LABELS, SUSPICIOUS_FLAGS, fmtCoords, fmtDateTime, fmtPlace } from "../lib/format";
import { Badge, Card, ErrorState, Input, PageHeader, Select } from "../components/ui";

export default function MapPage() {
  const [sp] = useSearchParams();
  const [f, setF] = useState({ productId: sp.get("product") ?? "", batch: "", from: "", to: "", flagged: false });
  const [sel, setSel] = useState<MapPoint | null>(null);
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);

  const pts = useQuery({ queryKey: ["map", f], queryFn: () => getMapPoints(f) });
  const prods = useQuery({ queryKey: ["products", "map-options"], queryFn: () => listProducts({ page: 1, pageSize: 100, search: "", status: "", category: "", expiry: "", scanState: "scanned" }) });

  useEffect(() => {
    if (!el.current || map.current) return;
    map.current = L.map(el.current).setView([21.17, 72.83], 5);
    // OpenFreeMap: free, no API key. tile.openstreetmap.org blocks this app (no Referer is sent) and CARTO needs a key.
    maplibreGL({ style: mapStyle() }).addTo(map.current);
    map.current.attributionControl.addAttribution(
      '<a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
    );
    layer.current = L.layerGroup().addTo(map.current);
    return () => { map.current?.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    const m = map.current, g = layer.current; if (!m || !g) return;
    g.clearLayers(); setSel(null);
    const data = (pts.data ?? []).filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude)); // never plot invalid coordinates
    data.forEach((p) => {
      const bad = p.flags.some((x) => SUSPICIOUS_FLAGS.includes(x));
      L.circleMarker([p.latitude, p.longitude], { radius: 7, color: "#fff", weight: 2, fillColor: bad ? "#dc2626" : "#203562", fillOpacity: 0.9 })
        .on("click", () => setSel(p)).addTo(g);
      if (p.accuracy_m) L.circle([p.latitude, p.longitude], { radius: p.accuracy_m, color: bad ? "#dc2626" : "#203562", weight: 1, fillOpacity: 0.05, interactive: false }).addTo(g);
    });
    if (data.length) m.fitBounds(L.latLngBounds(data.map((p) => [p.latitude, p.longitude] as [number, number])), { padding: [40, 40], maxZoom: 15 });
  }, [pts.data]);

  return (
    <>
      <PageHeader title="Location map" sub="Last reported device locations at scan time. Circles show reported GPS accuracy. Red = suspicious indicator." />
      <Card className="mb-4 grid gap-3 md:grid-cols-5">
        <Select aria-label="Product" value={f.productId} onChange={(e) => setF({ ...f, productId: e.target.value })}>
          <option value="">All scanned products</option>{prods.data?.rows.map((p) => <option key={p.id} value={p.id}>{p.name}{p.batch_number ? ` (${p.batch_number})` : ""}</option>)}</Select>
        <Input aria-label="Batch" placeholder="Batch number" value={f.batch} onChange={(e) => setF({ ...f, batch: e.target.value })} />
        <Input type="date" aria-label="From date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <Input type="date" aria-label="To date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.flagged} onChange={(e) => setF({ ...f, flagged: e.target.checked })} /> Suspicious only</label>
      </Card>
      {pts.isError && <ErrorState error={pts.error} retry={() => pts.refetch()} />}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="relative lg:col-span-2">
          <div ref={el} className="h-[28rem] rounded-xl border border-slate-200 shadow-sm lg:h-[34rem]" aria-label="Map of scan locations" />
          {pts.data?.length === 0 && <div className="pointer-events-none absolute inset-0 z-[500] grid place-items-center"><p className="rounded-lg bg-white/95 px-4 py-2 text-sm text-slate-600 shadow">No scans with GPS coordinates match these filters.</p></div>}
        </div>
        <Card className="h-fit">
          {sel ? (
            <div className="space-y-2 text-sm">
              <h2 className="font-semibold text-slate-800">{sel.product_name}</h2>
              <p className="font-mono text-xs">{sel.unit_label}</p>
              {sel.batch_number && <p>Batch {sel.batch_number}</p>}
              <p>{fmtDateTime(sel.scanned_at)}</p>
              {fmtPlace(sel) ? <p>{fmtPlace(sel)}</p> : null}
              <p className="font-mono text-xs">{fmtCoords(sel.latitude, sel.longitude)} · ±{Math.round(sel.accuracy_m ?? 0)} m</p>
              <div className="flex flex-wrap gap-1">{sel.flags.map((x) => <Badge key={x} tone={SUSPICIOUS_FLAGS.includes(x) ? "red" : "amber"}>{FLAG_LABELS[x] ?? x}</Badge>)}</div>
              <Link className="inline-block pt-2 text-brand underline" to={`/products/${sel.product_id}`}>Open product</Link>
            </div>) : <p className="text-sm text-slate-500">{pts.isLoading ? "Loading scan locations…" : `${pts.data?.length ?? 0} point(s) shown (max 2000, newest first). Select a marker for details.`}</p>}
        </Card>
      </div>
    </>
  );
}
