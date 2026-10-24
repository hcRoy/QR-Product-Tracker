// POST /functions/v1/custody-action
// The actor is the verified user. The body cannot set scanner id, role, or timestamp.
import { createClient } from "npm:@supabase/supabase-js@2";
import { fingerprint, handle, json, rateLimited } from "../_shared/http.ts";
import { custodySchema } from "../_shared/phase2_schema.ts";

Deno.serve(handle("custody-action", async (req, body) => {
  const parsed = custodySchema.safeParse(body);
  if (!parsed.success) return json(req, 400, { error: "invalid_request" });
  const header = req.headers.get("Authorization") ?? "";
  const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: header } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) return json(req, 401, { error: "unauthorized" });
  const v = parsed.data;
  if (await rateLimited(`custody:${userData.user.id}`, 30) || await rateLimited(`custody-tok:${await fingerprint(v.token)}`, 20)) {
    return json(req, 429, { error: "rate_limited" }, { "Retry-After": "60" });
  }
  const { data, error } = await userClient.rpc("record_custody_action", {
    p_action: v.action,
    p_token: v.token,
    p_location: v.locationId,
    p_shipment: v.shipmentId ?? null,
    p_idem: v.idempotencyKey,
    p_lat: v.location?.latitude ?? null,
    p_lon: v.location?.longitude ?? null,
    p_accuracy: v.location?.accuracyM ?? null,
    p_loc_status: v.locationStatus,
    p_note: v.note ?? null,
  });
  if (error) {
    const denied = /forbidden|42501/i.test(error.message);
    return json(req, denied ? 403 : 400, { error: denied ? "forbidden" : "request_failed" });
  }
  const row = data as { result?: string; reason?: string };
  if (row?.result === "rejected") return json(req, 422, data);
  return json(req, 200, data);
}));
