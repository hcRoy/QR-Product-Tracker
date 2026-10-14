import { Link } from "react-router-dom";
import type { ScanRow } from "../lib/api";
import { FLAG_LABELS, SUSPICIOUS_FLAGS, fmtCoords, fmtDateTime } from "../lib/format";
import { Badge } from "./ui";

export function FlagBadges({ flags }: { flags: string[] }) {
  if (!flags.length) return <span className="text-slate-400">—</span>;
  return <div className="flex flex-wrap gap-1">{flags.map((f) => <Badge key={f} tone={SUSPICIOUS_FLAGS.includes(f) ? "red" : "amber"}>{FLAG_LABELS[f] ?? f}</Badge>)}</div>;
}

export function LocationCell({ r }: { r: Pick<ScanRow, "latitude" | "longitude" | "accuracy_m" | "location_status"> }) {
  if (r.latitude == null) return <Badge tone="slate">{r.location_status === "granted" ? "Coordinates purged" : `No GPS (${r.location_status})`}</Badge>;
  return <span>{fmtCoords(r.latitude, r.longitude)}<span className="block text-xs text-slate-500">±{Math.round(r.accuracy_m ?? 0)} m</span></span>;
}

export function ScanTable({ rows, showProduct = true }: { rows: ScanRow[]; showProduct?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500">
          <tr><th className="px-4 py-3">Scanned (server time)</th>{showProduct && <th className="px-4 py-3">Product</th>}<th className="px-4 py-3">Unit</th><th className="px-4 py-3">Reported location</th><th className="px-4 py-3">Vendor ref.</th><th className="px-4 py-3">Indicators</th></tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.id} className="hover:bg-slate-50">
              <td className="whitespace-nowrap px-4 py-3">{fmtDateTime(r.scanned_at)}</td>
              {showProduct && <td className="px-4 py-3"><Link className="font-medium text-brand hover:underline" to={`/products/${r.product_units.product_id}`}>{r.product_units.products.name}</Link>
                {r.product_units.products.batch_number && <span className="block text-xs text-slate-500">Batch {r.product_units.products.batch_number}</span>}</td>}
              <td className="px-4 py-3 font-mono text-xs">#{r.product_units.serial}</td>
              <td className="px-4 py-3"><LocationCell r={r} /></td>
              <td className="px-4 py-3">{r.vendor_reference ?? "—"}</td>
              <td className="px-4 py-3"><FlagBadges flags={r.flags} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
