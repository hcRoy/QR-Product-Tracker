import { claimSchema, custodySchema, onboardingSchema, orgAdminSchema } from "./phase2_schema.ts";

function assert(c: unknown, msg = "assertion failed") { if (!c) throw new Error(msg); }
const token = "A".repeat(22);
const id = "00000000-0000-0000-0000-000000000001";

Deno.test("onboarding rejects unknown keys and short passwords", () => {
  assert(onboardingSchema.safeParse({ action: "register_vendor", email: "a@b.co", password: "longenough", name: "Shop" }).success);
  assert(!onboardingSchema.safeParse({ action: "register_vendor", email: "a@b.co", password: "short", name: "Shop" }).success);
  assert(!onboardingSchema.safeParse({ action: "preview_claim", code: "abcdefgh", role: "admin" }).success);
});

Deno.test("claim and custody bodies cannot name the actor", () => {
  assert(!claimSchema.safeParse({ code: "abcdefgh", userId: id }).success);
  assert(!custodySchema.safeParse({ action: "receive", token, locationId: id, idempotencyKey: id, locationStatus: "denied", actorId: id }).success);
  assert(custodySchema.safeParse({ action: "receive", token, locationId: id, idempotencyKey: id, locationStatus: "denied" }).success);
});

Deno.test("org admin bulk import is capped and strict", () => {
  assert(!orgAdminSchema.safeParse({ action: "bulk_import", orgId: id, dryRun: true, rows: [{ name: "A", price: 1 }] }).success);
  assert(!orgAdminSchema.safeParse({ action: "invite_staff", orgId: id, role: "owner" }).success);
});
