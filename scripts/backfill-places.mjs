// Fills area/city/state/country for scans that have coordinates but no place labels.
// Runs locally (Node 23.6+ loads the shared TypeScript helper directly).
//
//   node --env-file=.env.backfill scripts/backfill-places.mjs
//
// .env.backfill (git-ignored) needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
// Optional: LOCATIONIQ_API_KEY, GEOCODE_CONTACT_EMAIL. Without a LocationIQ key it uses public
// Nominatim, limited to 1 request per second by its usage policy.
import { createClient } from "@supabase/supabase-js";
import { reverseGeocode } from "../supabase/functions/_shared/geocode.ts";

const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see the header of this file).");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });
const opts = { locationIqKey: process.env.LOCATIONIQ_API_KEY, contactEmail: process.env.GEOCODE_CONTACT_EMAIL };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { data: rows, error } = await db.from("scan_events")
  .select("id,latitude,longitude")
  .not("latitude", "is", null)
  .is("location_area", null).is("location_city", null).is("location_state", null).is("location_country", null)
  .order("scanned_at", { ascending: false })
  .limit(1000);
if (error) { console.error(error.message); process.exit(1); }

console.log(`${rows.length} scan(s) need place labels`);
let filled = 0;
for (const [i, r] of rows.entries()) {
  const g = await reverseGeocode(Number(r.latitude), Number(r.longitude), opts);
  if (g.provider) {
    const { error: e } = await db.rpc("set_scan_place", {
      p_scan: r.id, p_area: g.place.area, p_city: g.place.city, p_state: g.place.state, p_country: g.place.country,
    });
    if (e) console.error(`  ${r.id}: ${e.message}`);
    else { filled++; console.log(`  ${i + 1}/${rows.length} ${[g.place.area, g.place.city, g.place.state, g.place.country].filter(Boolean).join(", ")}`); }
  } else {
    console.warn(`  ${i + 1}/${rows.length} failed: ${g.failures.join(", ")}`);
  }
  if (!opts.locationIqKey) await sleep(1100);
}
console.log(`Done: ${filled}/${rows.length} filled`);
