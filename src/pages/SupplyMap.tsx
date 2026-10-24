import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import L from "leaflet";
import { maplibreGL, mapStyle } from "../lib/mapSetup";
import { laneVolumes, unitsByLocation } from "../lib/phase2";
import { Card, ErrorState, PageHeader, Skeleton } from "../components/ui";

export default function SupplyMap() {
  const units = useQuery({ queryKey: ["units-by-location"], queryFn: unitsByLocation });
  const lanes = useQuery({ queryKey: ["lanes"], queryFn: laneVolumes });
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const [ready, setReady] = useState(false);
  const points = (units.data ?? []).filter((l) => l.latitude != null && l.longitude != null);

  useEffect(() => {
    if (points.length === 0 || !el.current || map.current) return;
    map.current = L.map(el.current).setView([22.5, 78], 4);
    maplibreGL({ style: mapStyle() }).addTo(map.current);
    map.current.attributionControl.addAttribution('<a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> &copy; OpenStreetMap');
    layer.current = L.layerGroup().addTo(map.current);
    setReady(true);
    return () => { map.current?.remove(); map.current = null; layer.current = null; setReady(false); };
  }, [points.length]);

  useEffect(() => {
    const m = map.current, g = layer.current;
    if (!ready || !m || !g || !units.data) return;
    g.clearLayers();
    const drawn: L.Layer[] = [];
    for (const p of units.data) {
      if (p.latitude == null || p.longitude == null) continue;
      const marker = L.circleMarker([p.latitude, p.longitude], { radius: 8, color: "#203562" })
        .bindPopup(`${p.name}${p.city ? `, ${p.city}` : ""}<br>${p.in_stock} in stock`);
      marker.addTo(g);
      drawn.push(marker);
    }
    for (const lane of lanes.data ?? []) {
      if (lane.origin_lat == null || lane.origin_lon == null || lane.destination_lat == null || lane.destination_lon == null) continue;
      const line = L.polyline([[lane.origin_lat, lane.origin_lon], [lane.destination_lat, lane.destination_lon]], { color: "#203562", weight: 2 })
        .bindPopup(`${lane.origin_name} → ${lane.destination_name}: ${lane.shipments}`);
      line.addTo(g);
      drawn.push(line);
    }
    if (drawn.length) m.fitBounds(L.featureGroup(drawn).getBounds().pad(0.3));
  }, [ready, units.data, lanes.data]);

  return (
    <>
      <PageHeader title="Supply map" sub="Only locations that have coordinates are drawn. Missing coordinates are left off the map." />
      {units.isLoading ? <Skeleton className="h-80" /> : units.isError ? <ErrorState error={units.error} retry={() => units.refetch()} /> : points.length === 0 ? (
        <Card><p className="text-sm text-slate-500">No locations with coordinates yet. Add latitude and longitude on the Locations page.</p></Card>
      ) : <div ref={el} className="h-[32rem] overflow-hidden rounded-xl border border-slate-200" />}
    </>
  );
}
