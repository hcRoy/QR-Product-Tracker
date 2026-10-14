import { useState } from "react";
import { exportProducts, listScans } from "../lib/api";
import { toCsv } from "../lib/csv";
import { downloadText } from "../lib/qr";
import { Button, Card, Input, PageHeader } from "../components/ui";

export default function Reports() {
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const [busy, setBusy] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);

  const run = (name: string, fn: () => Promise<void>) => async () => {
    setBusy(name); setErr(null);
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  const products = run("products", async () => {
    const rows = await exportProducts();
    downloadText(toCsv([["Name", "SKU", "Batch", "Category", "Mfg date", "Expiry date", "Price", "Currency", "Status", "Units", "Units scanned", "Last scan", "Last area", "Last city", "Last state", "Last country", "Last lat", "Last lon"],
      ...rows.map((r) => [r.name, r.sku, r.batch_number, r.category, r.manufacturing_date, r.expiry_date, r.unit_price, r.currency, r.status, r.unit_count, r.scanned_units, r.last_scan_at, r.last_scan_area, r.last_scan_city, r.last_scan_state, r.last_scan_country, r.last_scan_lat, r.last_scan_lon])]),
      "products.csv", "text/csv");
  });
  const scans = run("scans", async () => {
    const out: unknown[][] = [["Scanned at (UTC)", "Product", "Batch", "Unit #", "Area", "City", "State", "Country", "Latitude", "Longitude", "Accuracy m", "Location status", "Vendor ref", "Flags"]];
    for (let page = 1; page <= 5; page++) { // 5 x 1000 = 5000 rows max per export
      const { rows, total } = await listScans({ page, pageSize: 1000, from, to });
      rows.forEach((r) => out.push([r.scanned_at, r.product_units.products.name, r.product_units.products.batch_number, r.product_units.serial, r.location_area, r.location_city, r.location_state, r.location_country, r.latitude, r.longitude, r.accuracy_m, r.location_status, r.vendor_reference, r.flags.join(" ")]));
      if (page * 1000 >= total) break;
    }
    downloadText(toCsv(out), "scans.csv", "text/csv");
  });
  return (
    <>
      <PageHeader title="Reports" sub="CSV exports. Access is limited to administrators by database policy." />
      <div className="grid gap-4 md:grid-cols-2">
        <Card><h2 className="font-semibold">Products</h2><p className="my-2 text-sm text-slate-500">All products with unit and last-scan summary (up to 5,000 rows).</p>
          <Button disabled={!!busy} onClick={products}>{busy === "products" ? "Preparing…" : "Export products CSV"}</Button></Card>
        <Card><h2 className="font-semibold">Scan events</h2><p className="my-2 text-sm text-slate-500">Optionally limit by date (up to 5,000 rows). Contains precise locations; handle accordingly.</p>
          <div className="mb-3 grid grid-cols-2 gap-2"><Input type="date" aria-label="From date" value={from} onChange={(e) => setFrom(e.target.value)} /><Input type="date" aria-label="To date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <Button disabled={!!busy} onClick={scans}>{busy === "scans" ? "Preparing…" : "Export scans CSV"}</Button></Card>
      </div>
      {err && <p role="alert" className="mt-3 text-sm text-red-600">{err}</p>}
    </>
  );
}
