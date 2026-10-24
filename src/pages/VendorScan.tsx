import { useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { QrCamera } from "../components/QrCamera";
import { Button, Field, Select, Textarea } from "../components/ui";
import { extractToken } from "../lib/scanToken";
import { upsertBulk, summarizeBulk, type BulkItem } from "../lib/bulk";
import { recordCustody, vendorLocations } from "../lib/phase2";
import { getLocation } from "../lib/geo";

const ACTIONS = [
  { id: "receive", label: "Receive" },
  { id: "sell", label: "Sell" },
  { id: "report_lost", label: "Report lost" },
];

export default function VendorScan() {
  const [sp] = useSearchParams();
  const locs = useQuery({ queryKey: ["vendor-locations"], queryFn: vendorLocations });
  const [raw, setRaw] = useState(sp.get("token") ?? "");
  const [action, setAction] = useState(sp.get("action") ?? "receive");
  const [locationId, setLocationId] = useState("");
  const [note, setNote] = useState("");
  const [withGps, setWithGps] = useState(false);
  const [items, setItems] = useState<BulkItem[]>([]);
  const [busy, setBusy] = useState(false);
  const keys = useRef(new Map<string, string>());

  const tokens = useMemo(() => raw.split(/\s+/).map(extractToken).filter((t): t is string => !!t), [raw]);
  const chosen = locationId || locs.data?.[0]?.id || "";

  function keyFor(token: string) {
    const existing = keys.current.get(`${action}:${token}`);
    if (existing) return existing;
    const next = crypto.randomUUID();
    keys.current.set(`${action}:${token}`, next);
    return next;
  }

  async function run() {
    if (!chosen || tokens.length === 0) return;
    setBusy(true);
    let lat: number | undefined; let lon: number | undefined; let accuracy: number | undefined;
    if (withGps) {
      const geo = await getLocation();
      if (geo.status === "granted") { lat = geo.reading.latitude; lon = geo.reading.longitude; accuracy = geo.reading.accuracyM; }
    }
    let next = tokens.reduce((acc, token) => upsertBulk(acc, token, "pending"), [] as BulkItem[]);
    setItems(next);
    for (const token of tokens) {
      try {
        const res = await recordCustody({ action, token, locationId: chosen, idem: keyFor(token), note, lat, lon, accuracy });
        const ok = res.result === "accepted";
        next = upsertBulk(next, token, ok ? "ok" : "error", ok ? (res.replayed ? "Already recorded" : res.geofence) : res.reason);
      } catch (e) {
        next = upsertBulk(next, token, "error", e instanceof Error ? e.message : "failed");
      }
      setItems(next);
    }
    setBusy(false);
  }

  const sum = summarizeBulk(items);
  return (
    <div className="space-y-5 md:space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-brand md:text-3xl">Scan</h1>
        <p className="mt-1 text-sm text-slate-500 md:text-base">Point the camera at a QR code, or paste codes below.</p>
      </header>

      <div className="grid gap-5 lg:grid-cols-2 lg:items-start lg:gap-8">
        <QrCamera onCode={(value) => setRaw((prev) => prev ? `${prev}\n${value}` : value)} />

        <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 md:p-6">
          <Field label="Codes or links" hint="One per line. Links and raw tokens are accepted.">
            <Textarea value={raw} onChange={(e) => setRaw(e.target.value)} className="min-h-24 md:min-h-32" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Action">
              <Select value={action} onChange={(e) => setAction(e.target.value)}>{ACTIONS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</Select>
            </Field>
            <Field label="Location" hint="Only locations assigned to you.">
              <Select value={chosen} onChange={(e) => setLocationId(e.target.value)}>
                {(locs.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}{l.city ? ` · ${l.city}` : ""}</option>)}
              </Select>
            </Field>
          </div>
          {action === "report_lost" && (
            <Field label="Note" hint="Required when reporting a loss.">
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          )}
          <label className="flex min-h-11 items-center gap-3 rounded-xl bg-slate-50 px-3 text-sm text-slate-700">
            <input type="checkbox" className="size-4 accent-[var(--color-brand)]" checked={withGps} onChange={(e) => setWithGps(e.target.checked)} />
            Include this device&apos;s location
          </label>
          <p className="text-xs text-slate-500">
            {tokens.length} code{tokens.length === 1 ? "" : "s"} ready. Retries keep the same key so a unit is not recorded twice.
          </p>
          <Button className="min-h-12 w-full text-base md:w-auto md:min-w-48" disabled={busy || !chosen || tokens.length === 0} onClick={run}>
            {busy ? "Recording…" : "Record"}
          </Button>
          {locs.data && locs.data.length === 0 && (
            <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">No location is assigned to you yet. Ask a manager before receiving or selling.</p>
          )}
        </section>
      </div>

      {items.length > 0 && (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
          <p className="text-sm font-medium text-slate-800">{sum.ok} recorded · {sum.error} failed · {sum.pending} waiting</p>
          <ul className="mt-3 grid gap-x-8 divide-y divide-slate-100 md:grid-cols-2 md:divide-y-0 lg:grid-cols-3">
            {items.map((i) => (
              <li key={i.token} className="flex items-start justify-between gap-3 border-b border-slate-100 py-2 text-sm md:border-b-0 md:border-t md:pt-3">
                <span className="font-mono text-xs text-slate-500">{i.token.slice(0, 8)}…</span>
                <span className={i.state === "ok" ? "font-medium text-emerald-700" : i.state === "error" ? "font-medium text-red-700" : "text-slate-500"}>
                  {i.state}{i.message ? ` · ${i.message}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
