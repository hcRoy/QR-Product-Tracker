import { z } from "npm:zod@3.23.8";
import { LOCATION_STATUSES, TOKEN_RE } from "./schemas.ts";

const uuid = z.string().uuid();
const captchaToken = z.string().max(2048).optional();

export const onboardingSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("register_vendor"),
    email: z.string().trim().email().max(200),
    password: z.string().min(8).max(72),
    name: z.string().trim().min(1).max(200),
    taxId: z.string().trim().max(32).optional(),
    phone: z.string().trim().max(32).optional(),
    captchaToken,
  }).strict(),
  z.object({ action: z.literal("preview_claim"), code: z.string().trim().min(8).max(80) }).strict(),
]);

export const claimSchema = z.object({
  code: z.string().trim().min(8).max(80),
  captchaToken,
}).strict();

const orgType = z.enum(["manufacturer", "distributor", "retailer", "warehouse", "other"]);
const importRow = z.object({
  name: z.string().max(200),
  email: z.string().max(200).optional(),
  phone: z.string().max(32).optional(),
  city: z.string().max(120).optional(),
  address: z.string().max(300).optional(),
  tax_id: z.string().max(32).optional(),
  type: orgType.optional(),
}).strict();

export const orgAdminSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create_downstream"), parentId: uuid, name: z.string().trim().min(1).max(200), type: orgType, email: z.string().max(200).optional(), phone: z.string().max(32).optional(), city: z.string().max(120).optional() }).strict(),
  z.object({ action: z.literal("invite_staff"), orgId: uuid, role: z.enum(["manager", "staff"]) }).strict(),
  z.object({ action: z.literal("create_join_code"), orgId: uuid, maxUses: z.number().int().min(1).max(500) }).strict(),
  z.object({ action: z.literal("revoke_claim"), claimId: uuid }).strict(),
  z.object({ action: z.literal("set_member_status"), orgId: uuid, userId: uuid, status: z.enum(["active", "suspended", "removed"]) }).strict(),
  z.object({ action: z.literal("assign_location"), locationId: uuid, userId: uuid, assign: z.boolean() }).strict(),
  z.object({ action: z.literal("bulk_import"), orgId: uuid, dryRun: z.boolean(), rows: z.array(importRow).min(1).max(5000) }).strict(),
]);

const locationReading = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  accuracyM: z.number().finite().min(0).max(100_000),
}).strict();

export const custodySchema = z.object({
  action: z.enum(["receive", "sell", "report_lost"]),
  token: z.string().regex(TOKEN_RE),
  locationId: uuid,
  shipmentId: uuid.optional(),
  idempotencyKey: uuid,
  locationStatus: z.enum(LOCATION_STATUSES),
  location: locationReading.optional(),
  note: z.string().trim().max(500).optional(),
}).strict();

export type OnboardingInput = z.infer<typeof onboardingSchema>;
export type OrgAdminInput = z.infer<typeof orgAdminSchema>;
export type CustodyInput = z.infer<typeof custodySchema>;
