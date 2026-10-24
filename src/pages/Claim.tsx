import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { callFunction } from "../lib/phase2";
import { useAuth } from "../lib/auth";
import { Button, Card, Field, Input, PageHeader } from "../components/ui";

export default function Claim() {
  const { code = "" } = useParams();
  const { session } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [captcha, setCaptcha] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signUp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const { error } = await supabase.auth.signUp({ email, password });
    setBusy(false);
    setErr(error ? "Could not create the account. If you already have one, sign in and open this link again." : "Account created. If a confirmation email arrives, open it, then sign in and redeem the code.");
  }

  async function redeem() {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const res = await callFunction("claim", { code, captchaToken: captcha || undefined }, session?.access_token);
      setMsg(res?.ok ? `Joined ${res.org_name}. Sign in again if your home page does not update.` : "This code is not valid, has expired, or was already used.");
    } catch (ex) {
      const codeName = ex instanceof Error ? ex.message : "request_failed";
      setErr(codeName === "captcha_not_configured"
        ? "Claim redemption needs CAPTCHA_SECRET on the server, or CAPTCHA_DEV_BYPASS=on for a private demo."
        : codeName === "unauthorized" ? "Sign in before redeeming this code."
        : "This code could not be redeemed.");
    } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto min-h-screen max-w-md p-4">
      <PageHeader title="Claim an organization" sub="The code in this link is single-use. It is checked on the server and is not stored in a readable form." />
      <Card className="space-y-4">
        {!session && (
          <form onSubmit={signUp} className="space-y-3">
            <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
            <Field label="Password"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} /></Field>
            <Button type="submit" disabled={busy}>Create account</Button>
            <p className="text-sm text-slate-500">Already have an account? <Link className="text-brand hover:underline" to="/login" state={{ from: `/claim/${code}` }}>Sign in</Link></p>
          </form>
        )}
        <Field label="CAPTCHA token" hint="Required when the server has a CAPTCHA secret."><Input value={captcha} onChange={(e) => setCaptcha(e.target.value)} /></Field>
        <Button className="w-full" disabled={busy || !session} onClick={redeem}>{busy ? "Checking…" : "Redeem code"}</Button>
        {err && <p role="alert" className="text-sm text-red-700">{err}</p>}
        {msg && <p role="status" className="text-sm text-emerald-800">{msg}</p>}
      </Card>
    </div>
  );
}
