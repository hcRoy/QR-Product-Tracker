import { createClient } from "npm:@supabase/supabase-js@2";

const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": allowedOrigins.includes(origin) ? origin : (allowedOrigins[0] ?? "null"),
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function json(req: Request, status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}

// service_role client: server-side only. Never import this module from frontend code.
export const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Keyed hash of the client IP: lets us rate-limit and investigate without storing raw IPs. */
export async function hashIp(req: Request): Promise<string> {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const key = await crypto.subtle.importKey("raw", enc.encode(Deno.env.get("IP_HASH_SECRET") ?? "dev-only"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(ip))).slice(0, 32);
}

/** First 12 hex chars of SHA-256(token): same value as SQL token_fingerprint(). Safe to log. */
export async function fingerprint(token: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(token))).slice(0, 12);
}

export async function rateLimited(key: string, limit: number, windowSeconds = 60): Promise<boolean> {
  const { data, error } = await admin.rpc("check_rate_limit", {
    p_key: key, p_limit: limit, p_window_seconds: windowSeconds,
  });
  if (error) throw error;
  return data === false;
}

/** Verified user from an optional bearer token. A missing or invalid token is anonymous, not an error. */
export async function optionalActor(req: Request): Promise<{ id: string; role: string } | null> {
  try {
    const header = req.headers.get("Authorization") ?? "";
    if (!/^Bearer\s+\S+/i.test(header)) return null;
    const token = header.replace(/^Bearer\s+/i, "").trim();
    if (!token || token === Deno.env.get("SUPABASE_ANON_KEY")) return null;
    const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: header } },
      auth: { persistSession: false },
    });
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) return null;
    const { data: profile } = await admin.from("profiles").select("role,is_active").eq("id", data.user.id).maybeSingle();
    if (!profile?.is_active) return null;
    return { id: data.user.id, role: String(profile.role) };
  } catch {
    return null;
  }
}

/** Shared envelope: method/size checks, JSON parsing, uniform errors, no token/body logging. */
export function handle(name: string, run: (req: Request, body: unknown) => Promise<Response>, maxBytes = 4096) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
    if (req.method !== "POST") return json(req, 405, { error: "method_not_allowed" });
    try {
      const raw = await req.text();
      if (raw.length > maxBytes) return json(req, 413, { error: "payload_too_large" });
      let body: unknown;
      try { body = JSON.parse(raw); } catch { return json(req, 400, { error: "invalid_json" }); }
      return await run(req, body);
    } catch (e) {
      // Log the error class only: bodies and tokens must never reach logs.
      console.error(JSON.stringify({ fn: name, event: "unhandled", error: e instanceof Error ? e.name : "unknown" }));
      return json(req, 500, { error: "internal_error" });
    }
  };
}
