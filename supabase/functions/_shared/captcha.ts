export type CaptchaResult = "ok" | "bad" | "not_configured";

/** Server-side Turnstile or hCaptcha check. A missing secret does not silently pass. */
export async function verifyCaptcha(
  token: string | undefined,
  opts: { secret?: string; provider?: string; bypass?: boolean; fetchImpl?: typeof fetch },
): Promise<CaptchaResult> {
  if (opts.bypass) return "ok";
  if (!opts.secret) return "not_configured";
  if (!token) return "bad";
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = opts.provider === "hcaptcha"
    ? "https://hcaptcha.com/siteverify"
    : "https://challenges.cloudflare.com/turnstile/v0/siteverify";
  const res = await fetchImpl(url, { method: "POST", body: new URLSearchParams({ secret: opts.secret, response: token }) });
  if (!res.ok) return "bad";
  const json = await res.json() as { success?: boolean };
  return json.success ? "ok" : "bad";
}

export function captchaFromEnv(): { secret?: string; provider?: string; bypass: boolean } {
  return {
    secret: Deno.env.get("CAPTCHA_SECRET") || Deno.env.get("TURNSTILE_SECRET") || undefined,
    provider: Deno.env.get("CAPTCHA_PROVIDER") || "turnstile",
    bypass: Deno.env.get("CAPTCHA_DEV_BYPASS") === "on",
  };
}
