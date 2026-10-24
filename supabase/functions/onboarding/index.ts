// POST /functions/v1/onboarding
// Public vendor registration and claim preview. verify_jwt is off; captcha and rate limits apply.
// The service role is used only after the captcha check, and never returned to the browser.
import { admin, handle, hashIp, json, rateLimited } from "../_shared/http.ts";
import { captchaFromEnv, verifyCaptcha } from "../_shared/captcha.ts";
import { onboardingSchema } from "../_shared/phase2_schema.ts";

async function gate(req: Request, token: string | undefined) {
  const result = await verifyCaptcha(token, captchaFromEnv());
  if (result === "not_configured") return json(req, 503, { error: "captcha_not_configured" });
  if (result === "bad") return json(req, 400, { error: "captcha_failed" });
  return null;
}

Deno.serve(handle("onboarding", async (req, body) => {
  const parsed = onboardingSchema.safeParse(body);
  if (!parsed.success) return json(req, 400, { error: "invalid_request" });
  const ipHash = await hashIp(req);
  if (await rateLimited(`onboard:${ipHash}`, 10)) return json(req, 429, { error: "rate_limited" }, { "Retry-After": "60" });

  if (parsed.data.action === "preview_claim") {
    const { data, error } = await admin.rpc("preview_claim", { p_code: parsed.data.code, p_ip_hash: ipHash });
    if (error) return json(req, 400, { error: "request_failed" });
    return json(req, 200, data);
  }

  const blocked = await gate(req, parsed.data.captchaToken);
  if (blocked) return blocked;
  const created = await admin.auth.admin.createUser({
    email: parsed.data.email,
    password: parsed.data.password,
    email_confirm: Deno.env.get("AUTO_CONFIRM_VENDOR_EMAIL") === "on",
    user_metadata: { full_name: parsed.data.name },
  });
  if (created.error || !created.data.user) return json(req, 400, { error: "unavailable" });
  const { data, error } = await admin.rpc("start_vendor_application", {
    p_user: created.data.user.id, p_name: parsed.data.name, p_tax: parsed.data.taxId ?? null, p_phone: parsed.data.phone ?? null,
  });
  if (error || (data as { ok?: boolean })?.ok === false) {
    await admin.auth.admin.deleteUser(created.data.user.id);
    return json(req, 400, { error: (data as { error?: string })?.error ?? "unavailable" });
  }
  return json(req, 200, { ok: true, status: (data as { status?: string }).status ?? "pending" });
}));
