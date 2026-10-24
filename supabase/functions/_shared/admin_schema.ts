import { z } from "npm:zod@3.23.8";

const page = z.number().int().min(1).max(10_000);
const note = z.string().trim().max(500).optional();
const uuid = z.string().uuid();

/** Body for the admin-users Edge Function. Unknown keys and unknown actions are rejected. */
export const adminUsersSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("search_users"), page, q: z.string().max(80).optional(), role: z.enum(["admin", "vendor", "consumer"]).optional() }).strict(),
  z.object({ action: z.literal("set_role"), userId: uuid, role: z.enum(["admin", "vendor", "consumer"]) }).strict(),
  z.object({ action: z.literal("set_active"), userId: uuid, active: z.boolean() }).strict(),
  z.object({ action: z.literal("search_orgs"), page, q: z.string().max(80).optional(), status: z.enum(["pending", "active", "suspended", "rejected"]).optional() }).strict(),
  z.object({
    action: z.literal("create_org"),
    name: z.string().trim().min(1).max(200),
    type: z.enum(["manufacturer", "distributor", "retailer", "warehouse", "other"]),
    parentId: uuid.optional(),
    taxId: z.string().trim().max(32).optional(),
  }).strict(),
  z.object({ action: z.literal("set_org_status"), orgId: uuid, status: z.enum(["active", "suspended", "rejected"]), note }).strict(),
  z.object({
    action: z.literal("bulk_set_org_status"),
    orgIds: z.array(uuid).min(1).max(100),
    status: z.enum(["active", "suspended", "rejected"]),
    note,
  }).strict(),
]);

export type AdminUsersInput = z.infer<typeof adminUsersSchema>;
