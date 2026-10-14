import { mapNominatimAddress, EMPTY_PLACE } from "./geocode.ts";

function assertEquals<T>(a: T, b: T, msg = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

Deno.test("mapNominatimAddress: empty / missing address", () => {
  assertEquals(mapNominatimAddress(undefined), EMPTY_PLACE);
  assertEquals(mapNominatimAddress(null), EMPTY_PLACE);
  assertEquals(mapNominatimAddress({}), EMPTY_PLACE);
});

Deno.test("mapNominatimAddress: prefers neighbourhood/suburb for area, city/town for city", () => {
  assertEquals(mapNominatimAddress({
    neighbourhood: "Adajan",
    suburb: "Other",
    city: "Surat",
    town: "Town",
    state: "Gujarat",
    country: "India",
  }), { area: "Adajan", city: "Surat", state: "Gujarat", country: "India" });

  assertEquals(mapNominatimAddress({
    suburb: "Navsari Road",
    village: "Smallville",
    region: "Gujarat",
    country: "India",
  }), { area: "Navsari Road", city: "Smallville", state: "Gujarat", country: "India" });
});

Deno.test("mapNominatimAddress: trims and truncates to 120 chars", () => {
  const long = "x".repeat(200);
  const r = mapNominatimAddress({ city: `  ${long}  `, country: "  India  " });
  assertEquals(r.city?.length, 120);
  assertEquals(r.country, "India");
});
