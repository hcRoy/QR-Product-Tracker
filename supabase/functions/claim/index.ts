// POST /functions/v1/claim  { code, captchaToken? }
// The signed-in user is taken from the JWT. The body cannot choose who redeems the code.
import { createClient } from "npm:@supabase/supabase-js@2";
import { handle, json, rateLimited } from "../_shared/http.ts";
import { captchaFromEnv, verifyCaptcha } from "../_shared/captcha.ts";
import { claimSchema } from "../_shared/phase2_schema.ts";

Deno.serve(handle("claim", async (req, body) => {
  const parsed = claimSchema.safeParse(body);
  if (!parsed.success) return json(req, 400, { error: "invalid_request" });
  const header = req.headers.get("Authorization") ?? "";
  const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: header } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) return json(req, 401, { error: "unauthorized" });
  if (await rateLimited(`claim-user:${userData.user.id}`, 10)) return json(req, 429, { error: "rate_limited" }, { "Retry-After": "60" });

  const captcha = await verifyCaptcha(parsed.data.captchaToken, captchaFromEnv());
  if (captcha === "not_configured") return json(req, 503, { error: "captcha_not_configured" });
  if (captcha === "bad") return json(req, 400, { error: "captcha_failed" });

  const { data, error } = await userClient.rpc("redeem_claim", { p_code: parsed.data.code });
  if (error) return json(req, 400, { error: "request_failed" });
  return json(req, 200, data);
}));
