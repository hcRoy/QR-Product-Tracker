import { describe, expect, it } from "vitest";
import { emptyProductForm, productSchema, toProductPayload, loginSchema } from "./schemas";
import { TOKEN_RE, trackingUrl } from "./qr";
import { makeKeyTracker, mapGeoError, payloadSig } from "./geo";
import { csvCell, toCsv } from "./csv";
import { fmtPlace, safeSearch } from "./format";

const valid = { ...emptyProductForm, name: "Tea", batch_number: "B1", unit_count: "3" };
const bad = (over: object) => productSchema.safeParse({ ...valid, ...over });

describe("product form validation", () => {
  it("accepts a minimal valid product", () => expect(bad({}).success).toBe(true));
  it("requires a name", () => expect(bad({ name: "  " }).success).toBe(false));
  it("rejects expiry before manufacturing", () => {
    const r = bad({ manufacturing_date: "2026-05-01", expiry_date: "2026-01-01" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(["expiry_date"]);
  });
  it("accepts equal dates", () => expect(bad({ manufacturing_date: "2026-05-01", expiry_date: "2026-05-01" }).success).toBe(true));
  it.each(["-1", "abc", "1.234", "1e5"])("rejects price %s", (p) => expect(bad({ unit_price: p }).success).toBe(false));
  it.each(["0", "1.5", "-2"])("rejects quantity %s", (q) => expect(bad({ package_quantity: q }).success).toBe(false));
  it.each(["0", "1001", "x", ""])("rejects unit_count %s", (n) => expect(bad({ unit_count: n }).success).toBe(false));
  it("rejects over-long fields and bad currency", () => {
    expect(bad({ name: "x".repeat(201) }).success).toBe(false);
    expect(bad({ currency: "RUPEE" }).success).toBe(false);
  });
  it("payload converts blanks to null and numbers to numbers", () => {
    const p = toProductPayload(productSchema.parse({ ...valid, unit_price: "120.50", package_quantity: "10", currency: "inr" }));
    expect(p).toMatchObject({ name: "Tea", sku: null, unit_price: 120.5, package_quantity: 10, currency: "INR", expiry_date: null });
    expect(p).not.toHaveProperty("unit_count");
  });
});

describe("login validation", () => {
  it("needs a valid email and a password", () => {
    expect(loginSchema.safeParse({ email: "nope", password: "x" }).success).toBe(false);
    expect(loginSchema.safeParse({ email: "a@b.co", password: "" }).success).toBe(false);
    expect(loginSchema.safeParse({ email: "a@b.co", password: "x" }).success).toBe(true);
  });
});

describe("QR url and token format", () => {
  it("builds the URL from the configured base without double slashes", () => {
    const t = "A".repeat(22);
    expect(trackingUrl(t, "https://example.com/")).toBe(`https://example.com/track/${t}`);
  });
  it("token regex matches the database constraint", () => {
    expect(TOKEN_RE.test("A".repeat(22))).toBe(true);
    for (const b of ["short", "A".repeat(23), "../" + "A".repeat(19), "A".repeat(21) + "+"]) expect(TOKEN_RE.test(b)).toBe(false);
  });
});

describe("geolocation mapping and idempotency", () => {
  it("maps browser error codes", () => {
    expect(mapGeoError(1)).toBe("denied"); expect(mapGeoError(2)).toBe("unavailable"); expect(mapGeoError(3)).toBe("timeout");
  });
  it("reuses the key for an identical retry but not for a changed payload", () => {
    let n = 0; const k = makeKeyTracker(() => `key-${++n}`);
    const a = payloadSig({ token: "t", locationStatus: "denied" });
    const b = payloadSig({ token: "t", locationStatus: "granted", location: { latitude: 1, longitude: 2, accuracyM: 5, capturedAt: "x" } });
    expect(k.keyFor(a)).toBe("key-1"); expect(k.keyFor(a)).toBe("key-1");
    expect(k.keyFor(b)).toBe("key-2");
    k.reset(); expect(k.keyFor(b)).toBe("key-3");
  });
});

describe("csv export safety", () => {
  it("quotes commas, quotes and newlines", () => expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"'));
  it("neutralises spreadsheet formulas", () => { for (const f of ["=1+1", "+1", "-1", "@SUM(A1)"]) expect(csvCell(f).startsWith("'")).toBe(true); });
  it("renders null as empty and joins rows", () => expect(toCsv([[1, null, "x"]])).toBe("1,,x"));
});

describe("search sanitising", () => {
  it("strips characters that alter PostgREST filter syntax", () => expect(safeSearch("a,b)(c%d")).toBe("a b  c d"));
});

describe("place formatting", () => {
  it("joins non-empty parts and returns null when empty", () => {
    expect(fmtPlace({ location_area: "Adajan", location_city: "Surat", location_state: "Gujarat", location_country: "India" }))
      .toBe("Adajan, Surat, Gujarat, India");
    expect(fmtPlace({ location_city: "Surat", location_country: "India" })).toBe("Surat, India");
    expect(fmtPlace({})).toBeNull();
  });
});
