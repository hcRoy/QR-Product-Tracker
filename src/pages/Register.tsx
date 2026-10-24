import { useState } from "react";
import { Link } from "react-router-dom";
import { callFunction } from "../lib/phase2";
import { Button, Card, Field, Input, PageHeader } from "../components/ui";

export default function Register() {
  const [form, setForm] = useState({ email: "", password: "", name: "", taxId: "", phone: "", captchaToken: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null); setMsg(null);
    try {
      const res = await callFunction("onboarding", { action: "register_vendor", ...form, taxId: form.taxId || undefined, phone: form.phone || undefined, captchaToken: form.captchaToken || undefined });
      setMsg(res.status === "active"
        ? "Your organization is active. Sign in to continue."
        : "Application received. It stays pending until an administrator approves it. Check your email, then sign in to see the status.");
    } catch (ex) {
      const code = ex instanceof Error ? ex.message : "request_failed";
      setErr(code === "captcha_not_configured"
        ? "Registration needs a CAPTCHA secret on the server (CAPTCHA_SECRET), or CAPTCHA_DEV_BYPASS=on for a private demo."
        : code === "registration_closed" ? "Vendor registration is turned off."
        : code === "unavailable" ? "This application could not be created."
        : "Registration could not be completed.");
    } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto min-h-screen max-w-md p-4">
      <PageHeader title="Register a vendor" sub="A new organization is reviewed before it can receive or dispatch goods." />
      <Card>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Organization name" required><Input value={form.name} onChange={set("name")} required maxLength={200} /></Field>
          <Field label="Email" required><Input type="email" value={form.email} onChange={set("email")} required /></Field>
          <Field label="Password" required hint="At least 8 characters"><Input type="password" value={form.password} onChange={set("password")} required minLength={8} /></Field>
          <Field label="Tax id" hint="Optional. Letters and digits only, 5 to 20 characters."><Input value={form.taxId} onChange={set("taxId")} /></Field>
          <Field label="Phone" hint="Stored for your administrator. Text-message verification is not sent yet."><Input value={form.phone} onChange={set("phone")} /></Field>
          <Field label="CAPTCHA token" hint="From the Turnstile or hCaptcha widget. Required once the server secret is set."><Input value={form.captchaToken} onChange={set("captchaToken")} /></Field>
          {err && <p role="alert" className="text-sm text-red-700">{err}</p>}
          {msg && <p role="status" className="text-sm text-emerald-800">{msg}</p>}
          <Button type="submit" className="w-full" disabled={busy}>{busy ? "Submitting…" : "Submit application"}</Button>
        </form>
        <p className="mt-4 text-sm text-slate-500">Already registered? <Link className="text-brand hover:underline" to="/login">Sign in</Link></p>
      </Card>
    </div>
  );
}
