import { verifyCaptcha } from "./captcha.ts";

function assertEquals<T>(a: T, b: T) {
  if (a !== b) throw new Error(`expected ${String(b)}, got ${String(a)}`);
}

Deno.test("captcha is not configured when no secret and no bypass", async () => {
  const r = await verifyCaptcha("token", { fetchImpl: (() => { throw new Error("network"); }) as typeof fetch });
  assertEquals(r, "not_configured");
});

Deno.test("dev bypass accepts without calling the provider", async () => {
  const r = await verifyCaptcha(undefined, { bypass: true, fetchImpl: (() => { throw new Error("network"); }) as typeof fetch });
  assertEquals(r, "ok");
});

Deno.test("a configured provider must return success", async () => {
  const ok = await verifyCaptcha("token", {
    secret: "s",
    fetchImpl: (async () => new Response(JSON.stringify({ success: true }), { status: 200 })) as typeof fetch,
  });
  const bad = await verifyCaptcha(undefined, { secret: "s" });
  assertEquals(ok, "ok");
  assertEquals(bad, "bad");
});
