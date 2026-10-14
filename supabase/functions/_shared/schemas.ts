import { z } from "npm:zod@3.23.8";

// Must match the CHECK on product_units.token (22 chars, base64url, 128-bit).
export const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const token = z.string().regex(TOKEN_RE, "invalid token format");

export const lookupSchema = z.object({ token }).strict();

export const LOCATION_STATUSES = ["granted", "denied", "unavailable", "timeout", "unsupported"] as const;

export const scanSchema = z
  .object({
    token,
    // Client-generated UUID, reused on retries so a retried submit never creates a second event.
    idempotencyKey: z.string().uuid(),
    locationStatus: z.enum(LOCATION_STATUSES),
    location: z
      .object({
        latitude: z.number().finite().min(-90).max(90),
        longitude: z.number().finite().min(-180).max(180),
        accuracyM: z.number().finite().min(0).max(100_000),
        capturedAt: z.string().datetime().optional(),
      })
      .strict()
      .optional(),
    vendorReference: z.string().trim().max(100).optional(),
  })
  .strict() // unknown keys (e.g. productId, role, scannedAt) are rejected, never trusted
  .superRefine((v, ctx) => {
    if (v.locationStatus === "granted" && !v.location) {
      ctx.addIssue({ code: "custom", path: ["location"], message: "location required when status is granted" });
    }
    if (v.locationStatus !== "granted" && v.location) {
      ctx.addIssue({ code: "custom", path: ["location"], message: "location not allowed unless status is granted" });
    }
  });

export type ScanInput = z.infer<typeof scanSchema>;
