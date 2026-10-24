// POST /functions/v1/track-lookup  { "token": "<22 chars>" }
// Token travels in the body (not the URL) so it stays out of access logs.
import { admin, fingerprint, handle, hashIp, json, optionalActor, rateLimited } from "../_shared/http.ts";
import { lookupSchema } from "../_shared/schemas.ts";

const STATUS: Record<string, number> = { ok: 200, invalid: 404, revoked: 410, unavailable: 410 };

Deno.serve(handle("track-lookup", async (req, body) => {
  const parsed = lookupSchema.safeParse(body);
  if (!parsed.success) return json(req, 400, { error: "invalid_request" });
  const { token } = parsed.data;
  const ipHash = await hashIp(req);

  if (await rateLimited(`lookup:ip:${ipHash}`, 30) || await rateLimited(`lookup:tok:${await fingerprint(token)}`, 60)) {
    return json(req, 429, { error: "rate_limited" }, { "Retry-After": "60" });
  }
  const actor = await optionalActor(req);
  const { data, error } = await admin.rpc("public_lookup", { p_token: token, p_ip_hash: ipHash, p_actor: actor?.id ?? null });
  if (error) throw error;
  return json(req, STATUS[(data as { status: string }).status] ?? 500, data);
}));
