// POST /functions/v1/admin-users
// Platform-admin user and organization management. Identity comes from the verified JWT;
// the body is never trusted for who the caller is. The SQL functions check is_admin() again.
import { createClient } from "npm:@supabase/supabase-js@2";
import { handle, json, rateLimited } from "../_shared/http.ts";
import { adminUsersSchema, type AdminUsersInput } from "../_shared/admin_schema.ts";

function asUser(req: Request) {
  const header = req.headers.get("Authorization") ?? "";
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: header } },
    auth: { persistSession: false },
  });
}

function args(v: AdminUsersInput): { fn: string; params: Record<string, unknown> } {
  switch (v.action) {
    case "search_users": return { fn: "admin_search_users", params: { p_page: v.page, p_q: v.q ?? null, p_role: v.role ?? null } };
    case "set_role": return { fn: "admin_set_role", params: { p_user: v.userId, p_role: v.role } };
    case "set_active": return { fn: "admin_set_active", params: { p_user: v.userId, p_active: v.active } };
    case "search_orgs": return { fn: "admin_search_orgs", params: { p_page: v.page, p_q: v.q ?? null, p_status: v.status ?? null } };
    case "create_org": return { fn: "admin_create_org", params: { p_name: v.name, p_type: v.type, p_parent: v.parentId ?? null, p_tax_id: v.taxId ?? null } };
    case "set_org_status": return { fn: "admin_set_org_status", params: { p_org: v.orgId, p_status: v.status, p_note: v.note ?? null } };
    case "bulk_set_org_status": return { fn: "admin_bulk_set_org_status", params: { p_orgs: v.orgIds, p_status: v.status, p_note: v.note ?? null } };
  }
}

Deno.serve(handle("admin-users", async (req, body) => {
  const parsed = adminUsersSchema.safeParse(body);
  if (!parsed.success) return json(req, 400, { error: "invalid_request" });

  const userClient = asUser(req);
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) return json(req, 401, { error: "unauthorized" });

  if (await rateLimited(`admin:${userData.user.id}`, 60)) {
    return json(req, 429, { error: "rate_limited" }, { "Retry-After": "60" });
  }

  const call = args(parsed.data);
  const { data, error } = await userClient.rpc(call.fn, call.params);
  if (error) {
    const denied = /forbidden|42501/i.test(error.message);
    return json(req, denied ? 403 : 400, { error: denied ? "forbidden" : "request_failed" });
  }
  return json(req, 200, { result: data ?? null });
}));
