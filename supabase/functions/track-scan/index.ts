// POST /functions/v1/track-scan  (see _shared/schemas.ts for the body)
// The server sets the timestamp; product/unit identity is derived from the token only.
import { admin, fingerprint, handle, hashIp, json, optionalActor, rateLimited } from "../_shared/http.ts";
import { scanSchema } from "../_shared/schemas.ts";
import { reverseGeocode } from "../_shared/geocode.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const REASON_STATUS: Record<string, number> = {
  invalid_input: 400, invalid_token: 404, revoked: 410, unavailable: 410, location_required: 422,
};

/** Fills place labels for an already-recorded scan. Logs outcome only, never coordinates. */
async function fillPlace(scanId: string, lat: number, lon: number) {
  try {
    const g = await reverseGeocode(lat, lon, {
      locationIqKey: Deno.env.get("LOCATIONIQ_API_KEY"),
      contactEmail: Deno.env.get("GEOCODE_CONTACT_EMAIL"),
    });
    if (!g.provider) {
      console.warn(JSON.stringify({ fn: "track-scan", event: "geocode_failed", failures: g.failures }));
      return;
    }
    const { error } = await admin.rpc("set_scan_place", {
      p_scan: scanId, p_area: g.place.area, p_city: g.place.city, p_state: g.place.state, p_country: g.place.country,
    });
    if (error) console.error(JSON.stringify({ fn: "track-scan", event: "set_place_failed", code: error.code }));
  } catch (e) {
    console.error(JSON.stringify({ fn: "track-scan", event: "geocode_error", error: e instanceof Error ? e.name : "unknown" }));
  }
}

Deno.serve(handle("track-scan", async (req, body) => {
  const parsed = scanSchema.safeParse(body);
  if (!parsed.success) {
    return json(req, 400, { error: "invalid_request", fields: parsed.error.issues.map((i) => i.path.join(".")) });
  }
  const v = parsed.data;
  const ipHash = await hashIp(req);

  if (await rateLimited(`scan:ip:${ipHash}`, 20) || await rateLimited(`scan:tok:${await fingerprint(v.token)}`, 15)) {
    return json(req, 429, { error: "rate_limited" }, { "Retry-After": "60" });
  }

  const actor = await optionalActor(req);
  const source = actor && (actor.role === "admin" || actor.role === "vendor" || actor.role === "consumer") ? actor.role : "public";
  const { data, error } = await admin.rpc("record_scan", {
    p_token: v.token,
    p_idem: v.idempotencyKey,
    p_lat: v.location?.latitude ?? null,
    p_lon: v.location?.longitude ?? null,
    p_accuracy: v.location?.accuracyM ?? null,
    p_loc_status: v.locationStatus,
    p_loc_captured_at: v.location?.capturedAt ?? null,
    p_vendor_ref: v.vendorReference ?? null,
    p_ip_hash: ipHash,
    p_ua: req.headers.get("user-agent"),
    p_scanner: actor?.id ?? null,
    p_source: source,
  });
  if (error) throw error;

  const r = data as { result: string; reason?: string; scan_id?: string; recorded_at?: string; location_recorded?: boolean };
  if (r.result === "accepted") {
    // Geocode after the scan is saved so a slow or blocked geocoder never delays or loses it.
    if (r.location_recorded && r.scan_id && v.location) {
      const task = fillPlace(r.scan_id, v.location.latitude, v.location.longitude);
      if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(task);
      else await task;
    }
    // Deliberately omit flags/ids: vendors learn only that the event was recorded.
    return json(req, 200, { result: "accepted", recordedAt: r.recorded_at ?? null, locationRecorded: !!r.location_recorded });
  }
  return json(req, REASON_STATUS[r.reason ?? ""] ?? 400, { result: "rejected", reason: r.reason });
}));
