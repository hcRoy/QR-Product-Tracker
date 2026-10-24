import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { adminLocations, saveLocation } from "../lib/phase2";
import { searchOrgs } from "../lib/api";
import { Button, Card, ErrorState, Field, Input, PageHeader, Select, Skeleton } from "../components/ui";

export default function Locations() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin-locations"], queryFn: adminLocations });
  const orgs = useQuery({ queryKey: ["orgs", "loc"], queryFn: () => searchOrgs(1, "", "active") });
  const [form, setForm] = useState({ orgId: "", name: "", type: "warehouse", code: "", city: "", lat: "", lon: "", radius: "200" });
  const save = useMutation({ mutationFn: () => saveLocation(form), onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-locations"] }); setForm({ ...form, name: "", code: "" }); } });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });
  return (
    <>
      <PageHeader title="Locations" sub="A location needs an organization. Coordinates are optional. The map only shows locations that have them." />
      {q.isLoading ? <Skeleton className="h-32" /> : q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="space-y-3">
            <Field label="Organization"><Select value={form.orgId} onChange={set("orgId")}><option value="">Select</option>{(orgs.data?.rows ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select></Field>
            <Field label="Name"><Input value={form.name} onChange={set("name")} /></Field>
            <Field label="Type"><Select value={form.type} onChange={set("type")}><option value="manufacturer">Manufacturer</option><option value="warehouse">Warehouse</option><option value="distributor">Distributor</option><option value="retailer">Retailer</option><option value="other">Other</option></Select></Field>
            <Field label="Code"><Input value={form.code} onChange={set("code")} /></Field>
            <Field label="City"><Input value={form.city} onChange={set("city")} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Latitude"><Input value={form.lat} onChange={set("lat")} /></Field>
              <Field label="Longitude"><Input value={form.lon} onChange={set("lon")} /></Field>
            </div>
            <Field label="Geofence radius (m)"><Input value={form.radius} onChange={set("radius")} /></Field>
            <Button disabled={!form.orgId || !form.name || save.isPending} onClick={() => save.mutate()}>Save location</Button>
            {save.isError && <p role="alert" className="text-sm text-red-700">{(save.error as Error).message}</p>}
          </Card>
          <div className="space-y-2">{(q.data ?? []).map((l) => (
            <Card key={l.id} className="!p-3">
              <p className="font-medium">{l.name} <span className="text-xs font-normal text-slate-500">{l.type} · {l.org_name}</span></p>
              <p className="text-sm text-slate-600">{l.city ?? "No city"} · radius {l.geofence_radius_m} m · {l.latitude == null ? "no coordinates" : `${l.latitude}, ${l.longitude}`}</p>
            </Card>
          ))}</div>
        </div>
      )}
    </>
  );
}
