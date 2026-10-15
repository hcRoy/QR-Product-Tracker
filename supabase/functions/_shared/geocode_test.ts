import { EMPTY_PLACE, mapNominatimAddress, reverseGeocode } from "./geocode.ts";

function assertEquals<T>(a: T, b: T, msg = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const fakeFetch = (responses: Record<string, () => Response | Promise<Response>>): typeof fetch =>
  ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const key = Object.keys(responses).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected fetch ${url}`);
    return Promise.resolve(responses[key]());
  }) as typeof fetch;

const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });

Deno.test("mapNominatimAddress: empty / missing address", () => {
  assertEquals(mapNominatimAddress(undefined), EMPTY_PLACE);
  assertEquals(mapNominatimAddress(null), EMPTY_PLACE);
  assertEquals(mapNominatimAddress({}), EMPTY_PLACE);
});

Deno.test("mapNominatimAddress: prefers neighbourhood/suburb for area, city/town for city", () => {
  assertEquals(mapNominatimAddress({
    neighbourhood: "Adajan", suburb: "Other", city: "Surat", town: "Town", state: "Gujarat", country: "India",
  }), { area: "Adajan", city: "Surat", state: "Gujarat", country: "India" });
  assertEquals(mapNominatimAddress({ suburb: "Navsari Road", village: "Smallville", region: "Gujarat", country: "India" }),
    { area: "Navsari Road", city: "Smallville", state: "Gujarat", country: "India" });
});

Deno.test("mapNominatimAddress: Indian city only in state_district wins over taluka county", () => {
  // Real Nominatim shape for a point in Udhana, Surat.
  assertEquals(mapNominatimAddress({
    suburb: "Udhana", county: "Udhna Taluka", state_district: "Surat", state: "Gujarat", country: "India",
  }), { area: "Udhana", city: "Surat", state: "Gujarat", country: "India" });
});

Deno.test("mapNominatimAddress: trims and truncates to 120 chars", () => {
  const r = mapNominatimAddress({ city: `  ${"x".repeat(200)}  `, country: "  India  " });
  assertEquals(r.city?.length, 120);
  assertEquals(r.country, "India");
});

Deno.test("reverseGeocode: uses LocationIQ when keyed", async () => {
  const g = await reverseGeocode(21.17, 72.83, {
    locationIqKey: "k",
    fetchImpl: fakeFetch({ "locationiq.com": ok({ address: { suburb: "Udhana", state_district: "Surat", state: "Gujarat", country: "India" } }) }),
  });
  assertEquals(g.provider, "locationiq");
  assertEquals(g.place.city, "Surat");
});

Deno.test("reverseGeocode: falls back to Nominatim and records why", async () => {
  const g = await reverseGeocode(21.17, 72.83, {
    locationIqKey: "k",
    fetchImpl: fakeFetch({
      "locationiq.com": () => new Response("{}", { status: 429 }),
      "nominatim.openstreetmap.org": ok({ address: { city: "Surat", country: "India" } }),
    }),
  });
  assertEquals(g.provider, "nominatim");
  assertEquals(g.failures, ["locationiq:http_429"]);
});

Deno.test("reverseGeocode: all providers failing returns empty place, never throws", async () => {
  const g = await reverseGeocode(21.17, 72.83, {
    fetchImpl: fakeFetch({ "nominatim.openstreetmap.org": () => new Response("blocked", { status: 403 }) }),
  });
  assertEquals(g.provider, null);
  assertEquals(g.place, EMPTY_PLACE);
  assertEquals(g.failures, ["nominatim:http_403"]);
});
