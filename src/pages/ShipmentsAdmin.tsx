import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { addShipmentUnits, adminLocations, adminShipments, cancelShipment, closeShipment, createShipment, custodyExport, dispatchShipment, placeUnits, shipmentUnits } from "../lib/phase2";
import { toCsv } from "../lib/csv";
import { downloadText } from "../lib/qr";
import { Button, Card, ErrorState, Field, Input, PageHeader, Select, Skeleton } from "../components/ui";

export default function ShipmentsAdmin() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin-shipments"], queryFn: () => adminShipments("") });
  const locs = useQuery({ queryKey: ["admin-locations"], queryFn: adminLocations });
  const [origin, setOrigin] = useState("");
  const [dest, setDest] = useState("");
  const [units, setUnits] = useState("");
  const [placeAt, setPlaceAt] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const idem = useRef(crypto.randomUUID());
  const lines = useQuery({ queryKey: ["shipment-units", open], queryFn: () => shipmentUnits(open!), enabled: !!open });
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin-shipments"] });
  const place = useMutation({ mutationFn: () => placeUnits(placeAt, units.split(/[\s,]+/).filter(Boolean)), onSuccess: refresh });
  const create = useMutation({
    mutationFn: () => createShipment(origin, dest, idem.current),
    onSuccess: () => { idem.current = crypto.randomUUID(); refresh(); },
  });
  const add = useMutation({ mutationFn: (id: string) => addShipmentUnits(id, units.split(/[\s,]+/).filter(Boolean)), onSuccess: refresh });
  const act = useMutation({ mutationFn: (p: { id: string; kind: "dispatch" | "close" | "cancel" }) => p.kind === "dispatch" ? dispatchShipment(p.id, crypto.randomUUID()) : p.kind === "close" ? closeShipment(p.id, "closed by admin") : cancelShipment(p.id), onSuccess: refresh });

  const ids = units.split(/[\s,]+/).filter(Boolean);
  return (
    <>
      <PageHeader title="Shipments" sub="Place units, then create a shipment between two locations. One unit can be in only one open shipment."
        actions={<Button variant="secondary" onClick={async () => {
          const rows = await custodyExport();
          downloadText(toCsv([["occurred_at", "event", "unit", "product", "location", "city", "geofence", "note"], ...rows.map((r) => [r.occurred_at, r.event_type, r.unit_label, r.product_name, r.location_name, r.city, r.geofence_status, r.note])]), "custody.csv", "text/csv");
        }}>Export custody CSV</Button>} />
      <Card className="mb-4 space-y-3">
        <Field label="Unit ids" hint="Paste unit ids from a product, separated by spaces or commas."><Input value={units} onChange={(e) => setUnits(e.target.value)} /></Field>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Place into"><Select value={placeAt} onChange={(e) => setPlaceAt(e.target.value)}><option value="">Location</option>{(locs.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
          <div className="flex items-end"><Button disabled={!placeAt || ids.length === 0 || place.isPending} onClick={() => place.mutate()}>Place units</Button></div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Origin"><Select value={origin} onChange={(e) => setOrigin(e.target.value)}><option value="">Location</option>{(locs.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
          <Field label="Destination"><Select value={dest} onChange={(e) => setDest(e.target.value)}><option value="">Location</option>{(locs.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
        </div>
        <Button disabled={!origin || !dest || origin === dest || create.isPending} onClick={() => create.mutate()}>Create shipment</Button>
        {(place.isError || create.isError || add.isError || act.isError) && <p role="alert" className="text-sm text-red-700">{((place.error || create.error || add.error || act.error) as Error).message}</p>}
        {place.data && <p className="text-sm text-emerald-800">{place.data.result === "accepted" ? `Placed ${place.data.count}` : place.data.reason}</p>}
      </Card>
      {q.isLoading ? <Skeleton className="h-32" /> : q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : (q.data ?? []).length === 0 ? <p className="text-sm text-slate-500">No shipments yet.</p> : q.data!.map((s) => (
        <Card key={s.id} className="mb-3 !p-3">
          <p className="font-medium">{s.reference} {s.overdue && <span className="text-xs text-red-700">overdue</span>}</p>
          <p className="text-sm text-slate-600">{s.origin_name} → {s.destination_name} · {s.status} · {s.received} received / {s.expected} still expected</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setOpen(s.id)}>Units</Button>
            {s.status === "draft" && <Button variant="secondary" disabled={ids.length === 0} onClick={() => add.mutate(s.id)}>Add pasted units</Button>}
            {s.status === "draft" && <Button onClick={() => act.mutate({ id: s.id, kind: "dispatch" })}>Dispatch</Button>}
            {s.status === "draft" && <Button variant="secondary" onClick={() => act.mutate({ id: s.id, kind: "cancel" })}>Cancel</Button>}
            {(s.status === "in_transit" || s.status === "partially_received") && <Button variant="danger" onClick={() => act.mutate({ id: s.id, kind: "close" })}>Close missing</Button>}
          </div>
        </Card>
      ))}
      {open && lines.data && <Card className="mt-2">{lines.data.map((u) => <p key={u.unit_id} className="text-sm">{u.unit_label} · {u.product_name} · {u.unit_state} · {u.line_status}</p>)}</Card>}
    </>
  );
}
