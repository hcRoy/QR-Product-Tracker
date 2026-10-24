import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import type { AppRole } from "./roles";

interface AuthState {
  session: Session | null; role: AppRole | null; isActive: boolean; name: string | null;
  loading: boolean; signOut: () => Promise<void>;
}
const Ctx = createContext<AuthState>({ session: null, role: null, isActive: false, name: null, loading: true, signOut: async () => {} });
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<{ role: AppRole; is_active: boolean; full_name: string | null } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); if (!data.session) setLoading(false); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => { setSession(s); if (!s) { setProfile(null); setLoading(false); } });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    let live = true;
    // The role shown here only drives the UI. Real enforcement is RLS + RPC checks in the database.
    supabase.from("profiles").select("role,is_active,full_name").eq("id", session.user.id).single()
      .then(({ data }) => { if (live) { setProfile(data as typeof profile); setLoading(false); } });
    return () => { live = false; };
  }, [session]);

  return (
    <Ctx.Provider value={{ session, role: profile?.role ?? null, isActive: profile?.is_active === true, name: profile?.full_name ?? null, loading,
      signOut: async () => { await supabase.auth.signOut(); } }}>
      {children}
    </Ctx.Provider>
  );
}
