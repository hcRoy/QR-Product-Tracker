/**
 * Reverse-geocode helpers shared by track-scan and scripts/backfill-places.ts.
 * Providers: LocationIQ (when a key is configured) then public Nominatim. Both return the
 * Nominatim address format. Never throws: callers get empty fields plus failure reasons.
 * Runtime-neutral (Deno and Node): no Deno.* or node:* APIs in this file.
 */

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
  quarter?: string;
  residential?: string;
  hamlet?: string;
  city_district?: string;
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  state_district?: string;
  county?: string;
  state?: string;
  region?: string;
  country?: string;
};

const pick = (...vals: (string | undefined)[]) => {
  for (const v of vals) {
    const t = v?.trim();
    if (t) return t.slice(0, 120);
  }
  return null;
};

/**
 * Map Nominatim address parts into stored place fields.
 * Indian cities often appear only as state_district (e.g. Surat), so it is a city fallback
 * ahead of county (which is usually a taluka/tehsil there).
 */
export function mapNominatimAddress(addr: NominatimAddress | null | undefined): PlaceFields {
  if (!addr) return { ...EMPTY_PLACE };
  return {
    area: pick(addr.neighbourhood, addr.suburb, addr.quarter, addr.city_district, addr.residential, addr.hamlet),
    city: pick(addr.city, addr.town, addr.village, addr.municipality, addr.state_district, addr.county),
    state: pick(addr.state, addr.region),
    country: pick(addr.country),
  };
}

export const hasPlace = (p: PlaceFields) => !!(p.area || p.city || p.state || p.country);

export interface GeocodeOptions {
  /** LocationIQ access token (free tier available). Tried first when set. */
  locationIqKey?: string | null;
  /** Contact email sent to Nominatim, as its usage policy requires. */
  contactEmail?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface GeocodeResult {
  place: PlaceFields;
  provider: "locationiq" | "nominatim" | null;
  /** e.g. ["locationiq:http_429", "nominatim:timeout"]. Contains no coordinates. */
  failures: string[];
}

async function callProvider(
  name: "locationiq" | "nominatim",
  url: URL,
  headers: Record<string, string>,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<{ place: PlaceFields } | { failure: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url.toString(), { headers: { Accept: "application/json", ...headers }, signal: ctrl.signal });
    if (!res.ok) return { failure: `${name}:http_${res.status}` };
    const body = await res.json() as { address?: NominatimAddress; error?: string };
    if (body.error) return { failure: `${name}:no_result` };
    const place = mapNominatimAddress(body.address);
    return hasPlace(place) ? { place } : { failure: `${name}:empty_address` };
  } catch (e) {
    return { failure: `${name}:${e instanceof Error && e.name === "AbortError" ? "timeout" : "network"}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function reverseGeocode(lat: number, lon: number, opts: GeocodeOptions = {}): Promise<GeocodeResult> {
  const timeoutMs = opts.timeoutMs ?? 6000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const failures: string[] = [];
  const common = (u: URL) => {
    u.searchParams.set("lat", String(lat));
    u.searchParams.set("lon", String(lon));
    u.searchParams.set("format", "json");
    u.searchParams.set("zoom", "18");
    u.searchParams.set("addressdetails", "1");
    u.searchParams.set("accept-language", "en");
    return u;
  };

  if (opts.locationIqKey) {
    const u = common(new URL("https://us1.locationiq.com/v1/reverse"));
    u.searchParams.set("key", opts.locationIqKey);
    const r = await callProvider("locationiq", u, {}, timeoutMs, fetchImpl);
    if ("place" in r) return { place: r.place, provider: "locationiq", failures };
    failures.push(r.failure);
  }

  const u = common(new URL("https://nominatim.openstreetmap.org/reverse"));
  if (opts.contactEmail) u.searchParams.set("email", opts.contactEmail);
  const ua = `QR-Product-Tracker/1.0${opts.contactEmail ? ` (${opts.contactEmail})` : ""}`;
  const r = await callProvider("nominatim", u, { "User-Agent": ua }, timeoutMs, fetchImpl);
  if ("place" in r) return { place: r.place, provider: "nominatim", failures };
  failures.push(r.failure);

  return { place: { ...EMPTY_PLACE }, provider: null, failures };
}
