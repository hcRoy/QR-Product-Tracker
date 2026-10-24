import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, Navigate, useLocation } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { loginSchema, type LoginValues } from "../lib/schemas";
import { destinationForRole } from "../lib/roles";
import { Button, Card, Field, Input, Skeleton } from "../components/ui";

export default function Login() {
  const { session, role, loading } = useAuth();
  const from = (useLocation().state as { from?: string } | null)?.from ?? "/";
  const [err, setErr] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<LoginValues>({ resolver: zodResolver(loginSchema) });
  if (session && loading) return <div className="p-10"><Skeleton className="mx-auto h-8 w-64" /></div>;
  if (session && role) return <Navigate to={destinationForRole(role, from)} replace />;

  const submit = handleSubmit(async (v) => {
    setErr(null);
    const { error } = await supabase.auth.signInWithPassword(v);
    // Same message for every failure: do not reveal which accounts exist.
    if (error) setErr("Invalid email or password.");
  });
  return (
    <div className="grid min-h-screen place-items-center bg-accent/60 p-4">
      <Card className="w-full max-w-sm">
        <h1 className="text-xl font-semibold text-brand">QR Product Tracker</h1>
        <p className="mb-5 mt-1 text-sm text-slate-500">Sign in</p>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Email" error={errors.email?.message} required><Input type="email" autoComplete="username" {...register("email")} /></Field>
          <Field label="Password" error={errors.password?.message} required><Input type="password" autoComplete="current-password" {...register("password")} /></Field>
          {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
          <Button type="submit" className="w-full" disabled={isSubmitting}>{isSubmitting ? "Signing in…" : "Sign in"}</Button>
        </form>
        <p className="mt-4 text-sm text-slate-500">New vendor? <Link className="text-brand hover:underline" to="/register">Register an organization</Link></p>
      </Card>
    </div>
  );
}
