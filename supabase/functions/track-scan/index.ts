// POST /functions/v1/track-scan  (see _shared/schemas.ts for the body)
// The server sets the timestamp; product/unit identity is derived from the token only.
import { admin, fingerprint, handle, hashIp, json, rateLimited } from "../_shared/http.ts";
import { scanSchema } from "../_shared/schemas.ts";
import { EMPTY_PLACE, reverseGeocode } from "../_shared/geocode.ts";

const REASON_STATUS: Record<string, number> = {
  invalid_input: 400, invalid_token: 404, revoked: 410, unavailable: 410, location_required: 422,
};

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

  // Reverse-geocode before insert (scan_events is append-only). Soft-fail keeps the scan.
  const place = v.locationStatus === "granted" && v.location
    ? await reverseGeocode(v.location.latitude, v.location.longitude)
    : EMPTY_PLACE;

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
    p_area: place.area,
    p_city: place.city,
    p_state: place.state,
    p_country: place.country,
  });
  if (error) throw error;

  const r = data as { result: string; reason?: string; scan_id?: string; recorded_at?: string; location_recorded?: boolean };
  if (r.result === "accepted") {
    // Deliberately omit flags/ids: vendors learn only that the event was recorded.
    return json(req, 200, { result: "accepted", recordedAt: r.recorded_at ?? null, locationRecorded: !!r.location_recorded });
  }
  return json(req, REASON_STATUS[r.reason ?? ""] ?? 400, { result: "rejected", reason: r.reason });
}));
