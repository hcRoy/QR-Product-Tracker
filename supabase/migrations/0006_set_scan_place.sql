-- 0006_set_scan_place.sql : fill reverse-geocoded place labels after a scan is recorded.
-- Geocoding now runs after insert (in the background of track-scan, or via the backfill script),
-- so a slow or blocked geocoder never delays or loses a scan.
-- Write-once: only rows that still have coordinates and no place labels can be filled.

create function public.set_scan_place(p_scan uuid, p_area text, p_city text, p_state text, p_country text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  p_area    := left(nullif(btrim(p_area), ''), 120);
  p_city    := left(nullif(btrim(p_city), ''), 120);
  p_state   := left(nullif(btrim(p_state), ''), 120);
  p_country := left(nullif(btrim(p_country), ''), 120);
  if coalesce(p_area, p_city, p_state, p_country) is null then return false; end if;

  perform set_config('app.scan_maintenance', 'on', true);
  update public.scan_events
     set location_area = p_area, location_city = p_city, location_state = p_state, location_country = p_country
   where id = p_scan
     and latitude is not null
     and location_area is null and location_city is null and location_state is null and location_country is null;
  get diagnostics v_n = row_count;
  perform set_config('app.scan_maintenance', 'off', true);
  return v_n = 1;
end $$;

revoke all on function public.set_scan_place(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.set_scan_place(uuid, text, text, text, text) to service_role;
