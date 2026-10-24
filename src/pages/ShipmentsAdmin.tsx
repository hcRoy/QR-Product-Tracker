import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addShipmentUnits, adminLocations, adminShipments, cancelShipment, closeShipment, createShipment, custodyExport,
  dispatchShipment, listActiveProductsBrief, listPlaceableUnits, listShippableUnits, placeUnits, shipmentUnits,
  type SelectableUnit,
} from "../lib/phase2";
import { toCsv } from "../lib/csv";
import { downloadText } from "../lib/qr";
import { Button, Card, ErrorState, Field, PageHeader, Select, Skeleton } from "../components/ui";

function UnitPicker({
  units, selected, onChange, loading, empty,
}: {
  units: SelectableUnit[]; selected: Set<string>; onChange: (next: Set<string>) => void; loading?: boolean; empty: string;
}) {
  const allIds = useMemo(() => units.map((u) => u.id), [units]);
  const allSelected = units.length > 0 && units.every((u) => selected.has(u.id));
  if (loading) return <Skeleton className="h-36" />;
  if (units.length === 0) return <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-sm text-slate-500">{empty}</p>;
  return (
    <div className="rounded-xl border border-slate-200">
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <input
            type="checkbox"
            className="size-4 accent-[var(--color-brand)]"
            checked={allSelected}
            onChange={(e) => onChange(e.target.checked ? new Set(allIds) : new Set())}
          />
          Select all ({units.length})
        </label>
        <span className="text-xs text-slate-500">{selected.size} selected</span>
      </div>
      <ul className="max-h-56 overflow-y-auto divide-y divide-slate-100">
        {units.map((u) => (
          <li key={u.id}>
            <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm hover:bg-slate-50">
              <input
                type="checkbox"
                className="size-4 accent-[var(--color-brand)]"
                checked={selected.has(u.id)}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(u.id); else next.delete(u.id);
                  onChange(next);
                }}
              />
              <span className="font-mono text-xs text-slate-500">{u.label}</span>
              <span className="min-w-0 truncate text-slate-800">{u.product_name}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function ShipmentsAdmin() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin-shipments"], queryFn: () => adminShipments("") });
  const locs = useQuery({ queryKey: ["admin-locations"], queryFn: adminLocations });
  const products = useQuery({ queryKey: ["active-products-brief"], queryFn: listActiveProductsBrief });
  const [origin, setOrigin] = useState("");
  const [dest, setDest] = useState("");
  const [placeAt, setPlaceAt] = useState("");
  const [placeProduct, setPlaceProduct] = useState("");
  const [placeSelected, setPlaceSelected] = useState<Set<string>>(new Set());
  const [addProduct, setAddProduct] = useState("");
  const [addSelected, setAddSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const idem = useRef(crypto.randomUUID());
  const lines = useQuery({ queryKey: ["shipment-units", open], queryFn: () => shipmentUnits(open!), enabled: !!open });
  const placeable = useQuery({
    queryKey: ["placeable-units", placeProduct],
    queryFn: () => listPlaceableUnits(placeProduct),
    enabled: !!placeProduct,
  });
  const openShipment = (q.data ?? []).find((s) => s.id === open);
  const shippable = useQuery({
    queryKey: ["shippable-units", addProduct, openShipment?.origin_id ?? ""],
    queryFn: () => listShippableUnits(addProduct, openShipment!.origin_id),
    enabled: !!addProduct && !!openShipment?.origin_id && openShipment.status === "draft",
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["admin-shipments"] });
    qc.invalidateQueries({ queryKey: ["placeable-units"] });
    qc.invalidateQueries({ queryKey: ["shippable-units"] });
    qc.invalidateQueries({ queryKey: ["shipment-units"] });
  };

  const place = useMutation({
    mutationFn: () => placeUnits(placeAt, [...placeSelected]),
    onSuccess: (r) => {
      if (r.result === "accepted") { setPlaceSelected(new Set()); refresh(); }
    },
  });
  const create = useMutation({
    mutationFn: () => createShipment(origin, dest, idem.current),
    onSuccess: (r) => {
      idem.current = crypto.randomUUID();
      setOpen(r.shipment_id);
      setAddSelected(new Set());
      refresh();
    },
  });
  const add = useMutation({
    mutationFn: (id: string) => addShipmentUnits(id, [...addSelected]),
    onSuccess: (r) => {
      if (r.result === "accepted") { setAddSelected(new Set()); refresh(); }
    },
  });
  const act = useMutation({
    mutationFn: (p: { id: string; kind: "dispatch" | "close" | "cancel" }) =>
      p.kind === "dispatch" ? dispatchShipment(p.id, crypto.randomUUID())
        : p.kind === "close" ? closeShipment(p.id, "closed by admin")
          : cancelShipment(p.id),
    onSuccess: refresh,
  });

  return (
    <>
      <PageHeader
        title="Shipments"
        sub="Choose a product and units from the list. Place them into stock, then create a shipment and dispatch."
        actions={<Button variant="secondary" onClick={async () => {
          const rows = await custodyExport();
          downloadText(toCsv([["occurred_at", "event", "unit", "product", "location", "city", "geofence", "note"], ...rows.map((r) => [r.occurred_at, r.event_type, r.unit_label, r.product_name, r.location_name, r.city, r.geofence_status, r.note])]), "custody.csv", "text/csv");
        }}>Export custody CSV</Button>}
      />

      <Card className="mb-4 space-y-4">
        <h2 className="font-semibold text-brand">1. Place units into stock</h2>
        <p className="text-sm text-slate-500">New units start as registered. Place them at a location before they can ship.</p>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Product">
            <Select
              value={placeProduct}
              onChange={(e) => { setPlaceProduct(e.target.value); setPlaceSelected(new Set()); }}
              disabled={products.isLoading}
            >
              <option value="">Select a product</option>
              {(products.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.name}{p.batch_number ? ` · ${p.batch_number}` : ""}</option>
              ))}
            </Select>
          </Field>
          <Field label="Place into">
            <Select value={placeAt} onChange={(e) => setPlaceAt(e.target.value)}>
              <option value="">Location</option>
              {(locs.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.org_name ? `${l.name} · ${l.org_name}` : l.name}</option>)}
            </Select>
          </Field>
        </div>
        {placeProduct ? (
          <UnitPicker
            units={placeable.data ?? []}
            selected={placeSelected}
            onChange={setPlaceSelected}
            loading={placeable.isLoading}
            empty="No registered units left for this product. Create more units on the product page, or they are already in stock."
          />
        ) : (
          <p className="text-sm text-slate-500">Select a product to see units you can place.</p>
        )}
        <Button disabled={!placeAt || placeSelected.size === 0 || place.isPending} onClick={() => place.mutate()}>
          {place.isPending ? "Placing…" : `Place ${placeSelected.size || ""} unit${placeSelected.size === 1 ? "" : "s"}`.trim()}
        </Button>
        {place.isError && <p role="alert" className="text-sm text-red-700">{(place.error as Error).message}</p>}
        {place.data && (
          <p className="text-sm text-emerald-800">
            {place.data.result === "accepted" ? `Placed ${place.data.count} unit(s).` : place.data.reason}
          </p>
        )}
      </Card>

      <Card className="mb-4 space-y-4">
        <h2 className="font-semibold text-brand">2. Create a shipment</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Origin">
            <Select value={origin} onChange={(e) => setOrigin(e.target.value)}>
              <option value="">Location</option>
              {(locs.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.org_name ? `${l.name} · ${l.org_name}` : l.name}</option>)}
            </Select>
          </Field>
          <Field label="Destination">
            <Select value={dest} onChange={(e) => setDest(e.target.value)}>
              <option value="">Location</option>
              {(locs.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.org_name ? `${l.name} · ${l.org_name}` : l.name}</option>)}
            </Select>
          </Field>
        </div>
        <Button disabled={!origin || !dest || origin === dest || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "Creating…" : "Create shipment"}
        </Button>
        {create.isError && <p role="alert" className="text-sm text-red-700">{(create.error as Error).message}</p>}
      </Card>

      <h2 className="mb-3 text-lg font-semibold text-brand">Open shipments</h2>
      {q.isLoading ? <Skeleton className="h-32" /> : q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : (q.data ?? []).length === 0 ? (
        <p className="text-sm text-slate-500">No shipments yet.</p>
      ) : q.data!.map((s) => (
        <Card key={s.id} className="mb-3 space-y-3 !p-4">
          <div>
            <p className="font-medium">{s.reference} {s.overdue && <span className="text-xs text-red-700">overdue</span>}</p>
            <p className="text-sm text-slate-600">{s.origin_name} → {s.destination_name} · {s.status.replace(/_/g, " ")} · {s.received} received / {s.expected} still expected</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => { setOpen(open === s.id ? null : s.id); setAddSelected(new Set()); setAddProduct(""); }}>
              {open === s.id ? "Hide units" : "Manage units"}
            </Button>
            {s.status === "draft" && <Button disabled={act.isPending} onClick={() => act.mutate({ id: s.id, kind: "dispatch" })}>Dispatch</Button>}
            {s.status === "draft" && <Button variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ id: s.id, kind: "cancel" })}>Cancel</Button>}
            {(s.status === "in_transit" || s.status === "partially_received") && (
              <Button variant="danger" disabled={act.isPending} onClick={() => act.mutate({ id: s.id, kind: "close" })}>Close missing</Button>
            )}
          </div>

          {open === s.id && (
            <div className="space-y-3 rounded-xl bg-slate-50 p-3">
              {lines.isLoading ? <Skeleton className="h-16" /> : (lines.data ?? []).length === 0 ? (
                <p className="text-sm text-slate-500">No units on this shipment yet.</p>
              ) : (
                <ul className="space-y-1">
                  {lines.data!.map((u) => (
                    <li key={u.unit_id} className="text-sm text-slate-700">
                      <span className="font-mono text-xs text-slate-500">{u.unit_label}</span>
                      <span> · {u.product_name} · {u.unit_state} · {u.line_status}</span>
                    </li>
                  ))}
                </ul>
              )}

              {s.status === "draft" && (
                <div className="space-y-3 border-t border-slate-200 pt-3">
                  <p className="text-sm font-medium text-slate-800">Add units from stock at {s.origin_name}</p>
                  <Field label="Product">
                    <Select value={addProduct} onChange={(e) => { setAddProduct(e.target.value); setAddSelected(new Set()); }}>
                      <option value="">Select a product</option>
                      {(products.data ?? []).map((p) => (
                        <option key={p.id} value={p.id}>{p.name}{p.batch_number ? ` · ${p.batch_number}` : ""}</option>
                      ))}
                    </Select>
                  </Field>
                  {addProduct && (
                    <UnitPicker
                      units={shippable.data ?? []}
                      selected={addSelected}
                      onChange={setAddSelected}
                      loading={shippable.isLoading}
                      empty="No in-stock units for this product at the origin. Place units into that location first."
                    />
                  )}
                  <Button disabled={addSelected.size === 0 || add.isPending} onClick={() => add.mutate(s.id)}>
                    {add.isPending ? "Adding…" : `Add ${addSelected.size || ""} unit${addSelected.size === 1 ? "" : "s"}`.trim()}
                  </Button>
                  {add.isError && <p role="alert" className="text-sm text-red-700">{(add.error as Error).message}</p>}
                  {add.data && add.data.result !== "accepted" && <p role="alert" className="text-sm text-red-700">{add.data.reason}</p>}
                </div>
              )}
            </div>
          )}
        </Card>
      ))}
      {act.isError && <p role="alert" className="mt-2 text-sm text-red-700">{(act.error as Error).message}</p>}
    </>
  );
}
