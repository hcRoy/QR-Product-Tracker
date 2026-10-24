import { setWorkerUrl } from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { maplibreGL } from "@maplibre/maplibre-gl-leaflet";

// MapLibre looks for its worker next to the library file. Vite moves that file, so the URL is set explicitly.
setWorkerUrl(maplibreWorkerUrl);

export { maplibreGL };

export function mapStyle(): string {
  return import.meta.env.VITE_MAP_STYLE_URL || "https://tiles.openfreemap.org/styles/positron";
}
