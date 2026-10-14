/** Reverse-geocode helpers for track-scan. Nominatim (OSM) — no API key. Soft-fail on errors. */

export interface PlaceFields {
  area: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
}

export const EMPTY_PLACE: PlaceFields = { area: null, city: null, state: null, country: null };

type NominatimAddress = {
  neighbourhood?: string;
  suburb?: string;
  city_district?: string;
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  county?: string;
  state?: string;
  region?: string;
  country?: string;
};

/** Map Nominatim address parts into our stored place fields. Exported for unit tests. */
export function mapNominatimAddress(addr: NominatimAddress | null | undefined): PlaceFields {
  if (!addr) return { ...EMPTY_PLACE };
  const pick = (...vals: (string | undefined)[]) => {
    for (const v of vals) {
      const t = v?.trim();
      if (t) return t.slice(0, 120);
    }
    return null;
  };
  return {
    area: pick(addr.neighbourhood, addr.suburb, addr.city_district),
    city: pick(addr.city, addr.town, addr.village, addr.municipality),
    state: pick(addr.state, addr.region),
    country: pick(addr.country),
  };
}

const USER_AGENT = "QR-Tracker/1.0 (product scan reverse-geocode; contact: ops@localhost)";

/**
 * Reverse-geocode lat/lon via Nominatim. Returns EMPTY_PLACE on timeout/error
 * so the scan can still be recorded with coordinates alone.
 */
export async function reverseGeocode(
  lat: number,
  lon: number,
  timeoutMs = 2500,
  fetchImpl: typeof fetch = fetch,
): Promise<PlaceFields> {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("format", "json");
  url.searchParams.set("zoom", "18");
  url.searchParams.set("addressdetails", "1");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url.toString(), {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: ctrl.signal,
    });
    if (!res.ok) return { ...EMPTY_PLACE };
    const body = await res.json() as { address?: NominatimAddress };
    return mapNominatimAddress(body.address);
  } catch {
    return { ...EMPTY_PLACE };
  } finally {
    clearTimeout(timer);
  }
}
