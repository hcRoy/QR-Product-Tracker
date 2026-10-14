import { createClient } from "@supabase/supabase-js";

// Only the public anon key is used here. The service-role key must never be in frontend code.
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const supabase = createClient(SUPABASE_URL ?? "http://localhost", SUPABASE_ANON_KEY ?? "missing");
