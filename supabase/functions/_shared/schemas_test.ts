function assert(c: unknown, msg = "assertion failed") { if (!c) throw new Error(msg); }
function assertEquals<T>(a: T, b: T) { if (a !== b) throw new Error(`expected ${b}, got ${a}`); }
import { lookupSchema, scanSchema } from "./schemas.ts";

const token = "A".repeat(22);
const idem = crypto.randomUUID();
const loc = { latitude: 21.17, longitude: 72.83, accuracyM: 20 };
const ok = (v: unknown) => scanSchema.safeParse(v).success;

Deno.test("lookup: accepts valid token, rejects malformed and extra keys", () => {
  assert(lookupSchema.safeParse({ token }).success);
  assert(!lookupSchema.safeParse({ token: "short" }).success);
  assert(!lookupSchema.safeParse({ token, productId: "x" }).success);
});
Deno.test("scan: granted with location is valid", () => {
  assert(ok({ token, idempotencyKey: idem, locationStatus: "granted", location: loc }));
});
Deno.test("scan: denied without location is valid (GPS-less scan)", () => {
  assert(ok({ token, idempotencyKey: idem, locationStatus: "denied" }));
});
Deno.test("scan: granted without location is rejected", () => {
  assert(!ok({ token, idempotencyKey: idem, locationStatus: "granted" }));
});
Deno.test("scan: coordinates with non-granted status are rejected", () => {
  assert(!ok({ token, idempotencyKey: idem, locationStatus: "denied", location: loc }));
});
Deno.test("scan: out-of-range coordinates and accuracy are rejected", () => {
  for (const bad of [{ ...loc, latitude: 91 }, { ...loc, longitude: -181 }, { ...loc, accuracyM: -1 }, { ...loc, latitude: NaN }]) {
    assert(!ok({ token, idempotencyKey: idem, locationStatus: "granted", location: bad }));
  }
});
Deno.test("scan: client-supplied identity/time/product fields are rejected", () => {
  for (const extra of [{ productId: "p" }, { scannedAt: new Date().toISOString() }, { role: "admin" }, { scannerId: "u" }]) {
    assert(!ok({ token, idempotencyKey: idem, locationStatus: "denied", ...extra }));
  }
});
Deno.test("scan: bad token, bad idempotency key, oversize vendor reference rejected", () => {
  assert(!ok({ token: "../etc/passwd", idempotencyKey: idem, locationStatus: "denied" }));
  assert(!ok({ token, idempotencyKey: "not-a-uuid", locationStatus: "denied" }));
  assert(!ok({ token, idempotencyKey: idem, locationStatus: "denied", vendorReference: "x".repeat(101) }));
});
Deno.test("scan: vendor reference is trimmed", () => {
  const r = scanSchema.parse({ token, idempotencyKey: idem, locationStatus: "denied", vendorReference: "  WH-1 " });
  assertEquals(r.vendorReference, "WH-1");
});
