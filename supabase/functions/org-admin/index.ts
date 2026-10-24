// POST /functions/v1/org-admin
// Organization managers and platform admins. The JWT is the actor; SQL checks the organization role again.
import { createClient } from "npm:@supabase/supabase-js@2";
import { handle, json, rateLimited } from "../_shared/http.ts";
import { orgAdminSchema, type OrgAdminInput } from "../_shared/phase2_schema.ts";

function call(v: OrgAdminInput): { fn: string; params: Record<string, unknown> } {
  switch (v.action) {
    case "create_downstream":
      return { fn: "org_create_downstream", params: { p_parent: v.parentId, p_name: v.name, p_type: v.type, p_email: v.email ?? null, p_phone: v.phone ?? null, p_city: v.city ?? null } };
    case "invite_staff":
      return { fn: "org_invite_staff", params: { p_org: v.orgId, p_role: v.role } };
    case "create_join_code":
      return { fn: "org_create_join_code", params: { p_org: v.orgId, p_max_uses: v.maxUses } };
    case "revoke_claim":
      return { fn: "org_revoke_claim", params: { p_claim: v.claimId } };
    case "set_member_status":
      return { fn: "org_set_member_status", params: { p_org: v.orgId, p_user: v.userId, p_status: v.status } };
    case "assign_location":
      return { fn: "org_assign_location", params: { p_location: v.locationId, p_user: v.userId, p_assign: v.assign } };
    case "bulk_import":
      return { fn: "org_bulk_import", params: { p_org: v.orgId, p_rows: v.rows, p_dry_run: v.dryRun } };
  }
}

Deno.serve(handle("org-admin", async (req, body) => {
  const parsed = orgAdminSchema.safeParse(body);
  if (!parsed.success) return json(req, 400, { error: "invalid_request" });
  const header = req.headers.get("Authorization") ?? "";
  const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: header } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) return json(req, 401, { error: "unauthorized" });
  if (await rateLimited(`org-admin:${userData.user.id}`, 30)) return json(req, 429, { error: "rate_limited" }, { "Retry-After": "60" });
  const c = call(parsed.data);
  const { data, error } = await userClient.rpc(c.fn, c.params);
  if (error) {
    const denied = /forbidden|42501/i.test(error.message);
    return json(req, denied ? 403 : 400, { error: denied ? "forbidden" : "request_failed" });
  }
  return json(req, 200, { result: data ?? null });
}, 1_500_000));
