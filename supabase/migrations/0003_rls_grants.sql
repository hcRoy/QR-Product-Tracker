-- 0003_rls_grants.sql : Row Level Security and least-privilege grants.
-- Anonymous users get NO table or function access. The public tracking flow goes through
-- Edge Functions that call service_role-only functions (public_lookup, record_scan).

alter table public.profiles          enable row level security;
alter table public.app_settings      enable row level security;
alter table public.products          enable row level security;
alter table public.product_units     enable row level security;
alter table public.revoked_tokens    enable row level security;
alter table public.scan_events       enable row level security;
alter table public.rejected_attempts enable row level security;
alter table public.rate_limits       enable row level security;   -- no policies: service/definer only
alter table public.audit_logs        enable row level security;

-- profiles: own row or admin reads; only admins change roles (no self-promotion).
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
create policy profiles_admin_update on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy settings_select on public.app_settings for select to authenticated using (public.is_admin());
create policy settings_update on public.app_settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- products: admin read/insert/update. No delete policy: products are archived, never deleted.
create policy products_select on public.products for select to authenticated using (public.is_admin());
create policy products_insert on public.products for insert to authenticated with check (public.is_admin());
create policy products_update on public.products for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Read-only for admins; all writes go through audited RPCs.
create policy units_select      on public.product_units     for select to authenticated using (public.is_admin());
create policy revoked_select    on public.revoked_tokens    for select to authenticated using (public.is_admin());
create policy scans_select      on public.scan_events       for select to authenticated using (public.is_admin());
create policy rejected_select   on public.rejected_attempts for select to authenticated using (public.is_admin());
create policy audit_select      on public.audit_logs        for select to authenticated using (public.is_admin());

-- ---------- table grants ----------
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;

grant select on public.profiles, public.app_settings, public.products, public.product_units,
                public.revoked_tokens, public.scan_events, public.rejected_attempts,
                public.audit_logs, public.product_overview, public.suspicious_scans
  to authenticated;
grant insert, update on public.products to authenticated;
grant update on public.profiles, public.app_settings to authenticated;

-- ---------- function grants ----------
-- RLS helper must be callable by policies evaluated as authenticated.
grant execute on function public.is_admin(), public.local_today(), public.unit_label(text, int),
                          public.haversine_km(double precision, double precision, double precision, double precision)
  to authenticated, service_role;

-- Admin RPCs (each re-checks is_admin() internally).
grant execute on function public.create_product_with_units(jsonb, int), public.add_units(uuid, int),
                          public.rotate_unit_token(uuid, text), public.revoke_unit(uuid, text),
                          public.dashboard_metrics(), public.scan_activity_series(int),
                          public.map_points(uuid, text, timestamptz, timestamptz, boolean, int)
  to authenticated;

-- Public tracking boundary + maintenance: trusted server only.
grant execute on function public.public_lookup(text, text),
                          public.record_scan(text, uuid, double precision, double precision, real,
                                             public.location_status, timestamptz, text, text, text),
                          public.check_rate_limit(text, int, int),
                          public.log_rejected(text, uuid, text, text),
                          public.token_fingerprint(text),
                          public.purge_old_locations(),
                          public.generate_token()
  to service_role;
