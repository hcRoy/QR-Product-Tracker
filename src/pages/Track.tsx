import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase, SUPABASE_ANON_KEY, SUPABASE_URL } from "../lib/supabase";
import { TOKEN_RE } from "../lib/qr";
import { getLocation, makeKeyTracker, payloadSig, type GeoResult, type LocationStatus, type ScanPayload } from "../lib/geo";
import { fmtDate } from "../lib/format";
import { Badge, Button, Input, Skeleton } from "../components/ui";

interface PublicProduct {
  name: string; manufacturer: string | null; category: string | null; description: string | null; batch_number: string | null;
  manufacturing_date: string | null; expiry_date: string | null; is_expired: boolean; package_type: string | null;
  package_description: string | null; package_quantity: number | null; unit_of_measure: string | null; unit_label: string;
  sku?: string | null;
}
interface Provenance { location_type: string | null; city: string | null; occurred_on: string }
type Lookup = { kind: "loading" } | { kind: "ok"; product: PublicProduct; allowNoGps: boolean; scanCount?: number; firstScannedAt?: string | null; actions: string[]; provenance?: Provenance[]; viewerRole?: string; adminProductId?: string | null } | { kind: "bad"; title: string; msg: string };
type Phase = { kind: "idle" } | { kind: "locating" } | { kind: "submitting" }
  | { kind: "done"; located: boolean; accuracy?: number } | { kind: "locfail"; status: Exclude<LocationStatus, "granted"> } | { kind: "neterr"; msg: string } | { kind: "rejected"; msg: string };

async function call(fn: "track-lookup" | "track-scan", body: unknown) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  const headers: Record<string, string> = { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY };
  const { data } = await supabase.auth.getSession();
  if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`;
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, { method: "POST", signal: ctl.signal, headers, body: JSON.stringify(body) });
    let json: any = null; try { json = await r.json(); } catch { /* non-JSON error body */ }
    return { status: r.status, json };
  } finally { clearTimeout(t); }
}

const LOC_HELP: Record<string, string> = {
  denied: "Location permission was denied. You can allow it in your browser's site settings and try again.",
  unavailable: "Your device could not determine its location. Check that location services are turned on.",
  timeout: "Getting your location took too long. Move to an open area and try again.",
  unsupported: "This browser or connection cannot share location (it requires a secure HTTPS page).",
};
const REJECT_MSG: Record<string, string> = {
  invalid_token: "This QR code is not recognised.", revoked: "This QR code has been deactivated.", unavailable: "This product is no longer being tracked.",
  location_required: "Location is required to record this scan. Please allow location access.", invalid_input: "The scan could not be validated. Please try again.",
};

export default function Track() {
  const { token = "" } = useParams();
  const [lookup, setLookup] = useState<Lookup>({ kind: "loading" });
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [ref, setRef] = useState("");
  const keys = useRef(makeKeyTracker());
  const lastGeo = useRef<GeoResult | null>(null);

  useEffect(() => {
    if (!TOKEN_RE.test(token)) { setLookup({ kind: "bad", title: "Invalid QR code", msg: "This link is not a valid product QR code." }); return; }
    call("track-lookup", { token }).then(({ status, json }) => {
      if (status === 200 && json?.status === "ok") setLookup({
        kind: "ok", product: json.product, allowNoGps: !!json.tracking?.allow_scan_without_gps,
        scanCount: json.scan_count, firstScannedAt: json.first_scanned_at, actions: json.available_actions ?? [],
        provenance: json.provenance, viewerRole: json.viewer_role, adminProductId: json.admin_product_id,
      });
      else if (status === 429) setLookup({ kind: "bad", title: "Too many requests", msg: "Please wait a minute and scan again." });
      else if (status === 410) setLookup({ kind: "bad", title: json?.status === "revoked" ? "QR code deactivated" : "Product not tracked", msg: "This code can no longer record scans. Contact the product owner if you think this is a mistake." });
      else if (status === 404) setLookup({ kind: "bad", title: "QR code not recognised", msg: "We could not find a product for this code." });
      else setLookup({ kind: "bad", title: "Something went wrong", msg: "Please try again in a moment." });
    }).catch(() => setLookup({ kind: "bad", title: "No connection", msg: "Check your internet connection and reload this page." }));
  }, [token]);

  async function submit(geo: GeoResult) {
    lastGeo.current = geo;
    const base: Omit<ScanPayload, "idempotencyKey"> = {
      token, locationStatus: geo.status, vendorReference: ref.trim() || undefined,
      location: geo.status === "granted" ? geo.reading : undefined,
    };
    const body: ScanPayload = { ...base, idempotencyKey: keys.current.keyFor(payloadSig(base)) };
    setPhase({ kind: "submitting" });
    try {
      const { status, json } = await call("track-scan", body);
      if (status === 200 && json?.result === "accepted") { keys.current.reset(); setPhase({ kind: "done", located: !!json.locationRecorded, accuracy: geo.status === "granted" ? geo.reading.accuracyM : undefined }); }
      else if (status === 429) setPhase({ kind: "neterr", msg: "Too many attempts. Wait a minute and try again." });
      else if (status >= 500) setPhase({ kind: "neterr", msg: "The server had a problem. Your scan was not confirmed. Please try again." });
      else { keys.current.reset(); setPhase({ kind: "rejected", msg: REJECT_MSG[json?.reason] ?? "The scan could not be recorded." }); }
    } catch {
      // Same key is reused on retry, so a request that actually reached the server is not recorded twice.
      setPhase({ kind: "neterr", msg: "Could not reach the server. Your scan was not confirmed. Check your connection and try again." });
    }
  }
  async function shareLocation() {
    setPhase({ kind: "locating" });
    const geo = await getLocation();
    if (geo.status === "granted") await submit(geo); else setPhase({ kind: "locfail", status: geo.status });
  }

  return (
    <div className="mx-auto min-h-screen max-w-md bg-white pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-sm">
      <header className="bg-brand px-5 py-4 text-white"><p className="text-xs uppercase tracking-wide text-indigo-200">Product tracking</p><h1 className="text-lg font-semibold">Scan check-in</h1></header>
      <main className="space-y-5 p-5">
        {lookup.kind === "loading" && <div className="space-y-3" aria-busy="true"><Skeleton className="h-6 w-2/3" /><Skeleton className="h-24" /><Skeleton className="h-12" /></div>}
        {lookup.kind === "bad" && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-5"><h2 className="font-semibold text-red-800">{lookup.title}</h2><p className="mt-1 text-sm text-red-700">{lookup.msg}</p></div>}
        {lookup.kind === "ok" && (() => {
          const p = lookup.product;
          return <>
            <section className="rounded-xl border border-slate-200 p-4">
              <p className="font-mono text-xs text-slate-500">{p.unit_label}</p>
              <h2 className="mt-1 text-xl font-semibold text-slate-900">{p.name}</h2>
              {p.manufacturer && <p className="text-sm text-slate-600">{p.manufacturer}</p>}
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
                {p.batch_number && <div><dt className="text-slate-500">Batch</dt><dd className="font-medium">{p.batch_number}</dd></div>}
                {p.manufacturing_date && <div><dt className="text-slate-500">Manufactured</dt><dd className="font-medium">{fmtDate(p.manufacturing_date)}</dd></div>}
                {p.expiry_date && <div><dt className="text-slate-500">Expires</dt><dd className="font-medium">{fmtDate(p.expiry_date)} {p.is_expired && <Badge tone="red">Expired</Badge>}</dd></div>}
                {(p.package_type || p.package_quantity) && <div><dt className="text-slate-500">Package</dt><dd className="font-medium">{[p.package_type, p.package_quantity && `${p.package_quantity} ${p.unit_of_measure ?? ""}`].filter(Boolean).join(" · ")}</dd></div>}
              </dl>
              {p.package_description && <p className="mt-3 text-sm text-slate-600">{p.package_description}</p>}
              {p.sku && <p className="mt-2 text-sm text-slate-600">SKU {p.sku}</p>}
              <p className="mt-3 text-sm text-slate-600">Scanned {lookup.scanCount ?? 0} time{(lookup.scanCount ?? 0) === 1 ? "" : "s"}{lookup.firstScannedAt ? ` · first on ${fmtDate(lookup.firstScannedAt)}` : ""}.</p>
              <p className="mt-2 text-xs text-slate-500">A scan shows that this code was read. It does not prove the product is genuine.</p>
              {lookup.provenance && (
                <div className="mt-3">
                  <h3 className="text-sm font-semibold text-brand">Where it has been recorded</h3>
                  {lookup.provenance.length === 0 ? <p className="text-sm text-slate-500">No custody stops recorded.</p> : (
                    <ul className="mt-1 space-y-1 text-sm">{lookup.provenance.map((stop, i) => (
                      <li key={`${stop.occurred_on}-${i}`}>{fmtDate(stop.occurred_on)} · {stop.location_type ?? "stop"}{stop.city ? ` · ${stop.city}` : ""}</li>
                    ))}</ul>
                  )}
                  <p className="mt-1 text-xs text-slate-500">City and location type only. Exact coordinates are not shown here.</p>
                </div>
              )}
              {lookup.actions.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">{lookup.actions.map((action) => (
                  <Link key={action} to={`/v/scan?token=${encodeURIComponent(token)}&action=${action}`}><Button variant="secondary">{action.replace(/_/g, " ")}</Button></Link>
                ))}</div>
              )}
              {lookup.adminProductId && <p className="mt-3 text-sm"><Link className="text-brand hover:underline" to={`/products/${lookup.adminProductId}`}>Open in the admin catalogue</Link></p>}
            </section>

            {phase.kind === "done" ? (
              <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
                <h2 className="font-semibold text-emerald-900">Scan recorded</h2>
                <p className="mt-1 text-sm text-emerald-800">{phase.located ? `Your reported location${phase.accuracy ? ` (accuracy about ${Math.round(phase.accuracy)} m)` : ""} was saved with this scan.` : "Saved without a location."}</p>
                <p className="mt-2 text-xs text-emerald-700">This records that the code was scanned. It does not by itself prove the product is genuine.</p>
              </div>
            ) : (<>
              <section className="rounded-xl bg-accent p-4 text-sm text-slate-700">
                <h2 className="font-semibold text-brand">Why we ask for your location</h2>
                <p className="mt-1">The product owner records where this item was scanned so it can be tracked through distribution. Your browser will ask for permission; your location is only read once, when you tap the button, and is not tracked continuously.</p>
              </section>
              <label className="block space-y-1 text-sm"><span className="font-medium text-slate-700">Warehouse or business reference (optional)</span>
                <Input maxLength={100} value={ref} onChange={(e) => setRef(e.target.value)} placeholder="e.g. Warehouse 3" /></label>
              {phase.kind === "locfail" && <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{LOC_HELP[phase.status]}</div>}
              {phase.kind === "neterr" && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{phase.msg}</div>}
              {phase.kind === "rejected" && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{phase.msg}</div>}
              {!window.isSecureContext && <p className="text-xs text-amber-700">This page is not using HTTPS, so location sharing is unavailable.</p>}
              <div className="space-y-2">
                {phase.kind === "neterr" ? (
                  <Button className="w-full py-3 text-base" onClick={() => lastGeo.current ? submit(lastGeo.current) : shareLocation()}>Try again</Button>
                ) : (
                  <Button className="w-full py-3 text-base" disabled={phase.kind === "locating" || phase.kind === "submitting"} onClick={shareLocation}>
                    {phase.kind === "locating" ? "Getting your location…" : phase.kind === "submitting" ? "Recording scan…" : phase.kind === "locfail" ? "Try location again" : "Share location and record scan"}</Button>)}
                {lookup.allowNoGps && phase.kind !== "locating" && phase.kind !== "submitting" && phase.kind !== "neterr" &&
                  <Button variant="secondary" className="w-full" onClick={() => submit({ status: phase.kind === "locfail" ? phase.status : "denied" })}>Record scan without location</Button>}
              </div>
            </>)}
          </>;
        })()}
      </main>
    </div>
  );
}
