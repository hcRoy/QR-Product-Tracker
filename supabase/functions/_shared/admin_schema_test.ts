import { adminUsersSchema } from "./admin_schema.ts";

function assert(c: unknown, msg = "assertion failed") { if (!c) throw new Error(msg); }
const id = "00000000-0000-0000-0000-0000000000a1";
const ok = (v: unknown) => adminUsersSchema.safeParse(v).success;

Deno.test("admin-users: accepts each action and rejects unknown keys", () => {
  assert(ok({ action: "search_users", page: 1, q: "ada", role: "vendor" }));
  assert(ok({ action: "set_role", userId: id, role: "consumer" }));
  assert(ok({ action: "set_active", userId: id, active: false }));
  assert(ok({ action: "search_orgs", page: 2, status: "pending" }));
  assert(ok({ action: "create_org", name: "Alpha", type: "distributor" }));
  assert(ok({ action: "set_org_status", orgId: id, status: "suspended", note: "unpaid" }));
  assert(ok({ action: "bulk_set_org_status", orgIds: [id], status: "active" }));
  assert(!ok({ action: "search_users", page: 1, role: "viewer" }));
  assert(!ok({ action: "set_role", userId: id, role: "admin", actorId: id }), "client cannot supply an actor");
  assert(!ok({ action: "promote", userId: id }));
  assert(!ok({ action: "bulk_set_org_status", orgIds: [], status: "active" }));
  assert(!ok({ action: "bulk_set_org_status", orgIds: Array.from({ length: 101 }, () => id), status: "active" }));
  assert(!ok({ action: "create_org", name: " ", type: "distributor" }));
});
