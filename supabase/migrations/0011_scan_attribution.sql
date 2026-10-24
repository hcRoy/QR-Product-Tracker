-- 0011_scan_attribution.sql : who scanned, daily rollup, vendor-scoped scan and product reads.
-- record_scan gains two trailing arguments with defaults, so the existing 10-arg and 14-arg calls keep working.
-- Vendors have no table grant on products. They read an allow-list through these functions.

create index if not exists scan_events_scanner_time_idx
  on public.scan_events (scanner_id, scanned_at desc) where scanner_id is not null;

-- Daily counts in the configured time zone. The chart reads this instead of scanning every event.
-- scans_today stays timezone-correct because the day boundary is the app time zone, not UTC.
create table public.scan_daily (
  day     date primary key,
  scans   integer not null default 0 check (scans >= 0),
  flagged integer not null default 0 check (flagged >= 0)
);

insert into public.scan_daily (day, scans, flagged)
select (e.scanned_at at time zone s.timezone)::date,
       count(*)::int,
       count(*) filter (where e.flags && array['rapid_repeat', 'implausible_travel', 'high_frequency'])::int
from public.scan_events e
cross join public.app_settings s
group by 1;

create function public.scan_daily_add() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_day date; v_flag int;
begin
  v_day := (new.scanned_at at time zone (select timezone from public.app_settings))::date;
  v_flag := case when new.flags && array['rapid_repeat', 'implausible_travel', 'high_frequency'] then 1 else 0 end;
  insert into public.scan_daily as d (day, scans, flagged) values (v_day, 1, v_flag)
  on conflict (day) do update
    set scans = d.scans + 1, flagged = d.flagged + excluded.flagged;
  return new;
end $$;

create trigger scan_events_daily after insert on public.scan_events
  for each row execute function public.scan_daily_add();

alter table public.scan_daily enable row level security;
create policy scan_daily_select on public.scan_daily for select to authenticated using (public.is_admin());
grant select on public.scan_daily to authenticated;

create or replace function public.dashboard_metrics() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.app_settings; v_today date; r jsonb;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into s from public.app_settings;
  v_today := public.local_today();
  select jsonb_build_object(
    'products_total', count(*),
    'products_active', count(*) filter (where status = 'active'),
    'expired_products', count(*) filter (where status = 'active' and expiry_date < v_today),
    'expiring_soon', count(*) filter (where status = 'active' and expiry_date >= v_today
                                      and expiry_date <= v_today + s.expiring_soon_days)
  ) into r from public.products;
  r := r || jsonb_build_object(
    'products_scanned', (select count(distinct product_id) from public.product_units where scan_count > 0));
  r := r || jsonb_build_object(
    'products_never_scanned', (r ->> 'products_total')::int - (r ->> 'products_scanned')::int);
  r := r || (select jsonb_build_object('units_total', count(*),
                    'units_scanned', count(*) filter (where scan_count > 0),
                    'units_never_scanned', count(*) filter (where scan_count = 0))
               from public.product_units);
  r := r || jsonb_build_object(
    'scans_total', (select coalesce(sum(scans), 0) from public.scan_daily),
    'scans_today', (select coalesce(sum(scans), 0) from public.scan_daily where day = v_today),
    'units_suspicious_30d', (select count(distinct unit_id) from public.suspicious_scans
                              where scanned_at >= now() - interval '30 days'),
    'timezone', s.timezone);
  return r;
end $$;

create or replace function public.scan_activity_series(p_days int default 30)
returns table (day date, scans bigint, flagged bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_days is null or p_days not between 1 and 365 then
    raise exception 'p_days must be between 1 and 365' using errcode = '22023';
  end if;
  return query
  select d::date, coalesce(sd.scans, 0)::bigint, coalesce(sd.flagged, 0)::bigint
  from generate_series(public.local_today() - (p_days - 1), public.local_today(), interval '1 day') d
  left join public.scan_daily sd on sd.day = d::date
  order by d;
end $$;

drop function if exists public.record_scan(text, uuid, double precision, double precision, real,
                                           public.location_status, timestamptz, text, text, text,
                                           text, text, text, text);

create function public.record_scan(
  p_token text, p_idem uuid, p_lat double precision, p_lon double precision, p_accuracy real,
  p_loc_status public.location_status, p_loc_captured_at timestamptz,
  p_vendor_ref text, p_ip_hash text, p_ua text,
  p_area text default null, p_city text default null, p_state text default null, p_country text default null,
  p_scanner uuid default null, p_source text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s public.app_settings; u public.product_units; p public.products; prev public.scan_events;
  v_flags text[] := '{}'; v_now timestamptz := clock_timestamp();
  v_id uuid; v_dist double precision; v_hours double precision; v_gps boolean; v_n int;
  v_source text;
begin
  select * into s from public.app_settings;
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{22}$' or p_idem is null or p_loc_status is null then
    return jsonb_build_object('result', 'rejected', 'reason', 'invalid_input');
  end if;
  v_gps := p_loc_status = 'granted';
  if v_gps and (p_lat is null or p_lon is null or p_accuracy is null
                or p_lat not between -90 and 90 or p_lon not between -180 and 180 or p_accuracy < 0) then
    return jsonb_build_object('result', 'rejected', 'reason', 'invalid_input');
  end if;
  if not v_gps then
    p_lat := null; p_lon := null; p_accuracy := null;
    p_area := null; p_city := null; p_state := null; p_country := null;
  else
    p_area    := left(nullif(btrim(p_area), ''), 120);
    p_city    := left(nullif(btrim(p_city), ''), 120);
    p_state   := left(nullif(btrim(p_state), ''), 120);
    p_country := left(nullif(btrim(p_country), ''), 120);
  end if;
  p_vendor_ref := left(nullif(btrim(p_vendor_ref), ''), 100);
  v_source := coalesce(p_source, 'public');
  if v_source not in ('public', 'consumer', 'vendor', 'admin') then v_source := 'public'; end if;
  if p_scanner is not null and not exists (
    select 1 from public.profiles where id = p_scanner and is_active
  ) then
    p_scanner := null;
    v_source := 'public';
  end if;

  select * into u from public.product_units where token = p_token for update;
  if not found then
    perform public.log_rejected(p_token,
      (select unit_id from public.revoked_tokens where token = p_token), 'unknown_or_replaced_token', p_ip_hash);
    return jsonb_build_object('result', 'rejected', 'reason', 'invalid_token');
  end if;
  select * into p from public.products where id = u.product_id;
  if u.status = 'revoked' then
    perform public.log_rejected(p_token, u.id, 'revoked_token', p_ip_hash);
    return jsonb_build_object('result', 'rejected', 'reason', 'revoked');
  end if;
  if p.status = 'archived' then
    return jsonb_build_object('result', 'rejected', 'reason', 'unavailable');
  end if;
  if not v_gps and not s.allow_scan_without_gps then
    return jsonb_build_object('result', 'rejected', 'reason', 'location_required');
  end if;

  select id into v_id from public.scan_events where unit_id = u.id and idempotency_key = p_idem;
  if found then
    return jsonb_build_object('result', 'accepted', 'scan_id', v_id, 'replayed', true, 'location_recorded', v_gps);
  end if;

  select * into prev from public.scan_events where unit_id = u.id order by scanned_at desc limit 1;
  if found and v_now - prev.scanned_at < make_interval(secs => s.min_rescan_seconds) then
    v_flags := array_append(v_flags, 'rapid_repeat');
  end if;
  select count(*) into v_n from public.scan_events
   where unit_id = u.id and scanned_at > v_now - make_interval(secs => s.frequency_window_seconds);
  if v_n + 1 > s.frequency_max_scans then v_flags := array_append(v_flags, 'high_frequency'); end if;

  if v_gps then
    select * into prev from public.scan_events
     where unit_id = u.id and latitude is not null order by scanned_at desc limit 1;
    if found then
      v_dist := public.haversine_km(prev.latitude::float8, prev.longitude::float8, p_lat, p_lon);
      if v_dist * 1000 > coalesce(prev.accuracy_m, 0) + p_accuracy then
        v_hours := greatest(extract(epoch from v_now - prev.scanned_at) / 3600.0, 1.0 / 3600);
        if v_dist / v_hours > s.max_speed_kmh then v_flags := array_append(v_flags, 'implausible_travel'); end if;
      end if;
    end if;
    if p_accuracy > s.max_accuracy_m then v_flags := array_append(v_flags, 'low_accuracy'); end if;
  end if;
  if p.expiry_date is not null and p.expiry_date < public.local_today() then
    v_flags := array_append(v_flags, 'expired_product');
  end if;

  insert into public.scan_events (unit_id, idempotency_key, scanned_at, latitude, longitude, accuracy_m,
    location_status, location_captured_at, vendor_reference, ip_hash, user_agent, flags,
    location_area, location_city, location_state, location_country, scanner_id, source)
  values (u.id, p_idem, v_now, p_lat, p_lon, p_accuracy, p_loc_status, p_loc_captured_at,
    p_vendor_ref, p_ip_hash, left(p_ua, 300), v_flags,
    p_area, p_city, p_state, p_country, p_scanner, v_source)
  returning id into v_id;
  update public.product_units
     set scan_count = scan_count + 1, last_scan_at = v_now, last_scan_id = v_id where id = u.id;

  return jsonb_build_object('result', 'accepted', 'scan_id', v_id, 'replayed', false,
                            'recorded_at', v_now, 'location_recorded', v_gps);
end $$;

grant execute on function public.record_scan(text, uuid, double precision, double precision, real,
  public.location_status, timestamptz, text, text, text, text, text, text, text, uuid, text)
  to service_role;

-- Scanners a vendor may see: their own, or every active member when they manage the organization.
create function public.visible_scanner_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select auth.uid()
  union
  select m.user_id
  from public.org_members m
  where public.is_vendor()
    and m.status = 'active'
    and m.org_id in (
      select om.org_id from public.org_members om
      join public.organizations o on o.id = om.org_id and o.status = 'active'
      where om.user_id = auth.uid() and om.status = 'active' and om.org_role in ('owner', 'manager')
    );
$$;

create function public.vendor_my_scans(p_before timestamptz default null, p_before_id uuid default null, p_limit int default 25)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_limit int := least(greatest(coalesce(p_limit, 25), 1), 100); v_rows jsonb;
begin
  if not (public.is_vendor() or public.is_admin()) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and is_active) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  with page as (
    select e.id, e.scanned_at, e.location_status, e.location_area, e.location_city, e.location_state, e.location_country,
           e.flags, e.latitude, e.longitude, p.name as product_name, p.batch_number,
           public.unit_label(p.batch_number, pu.serial) as unit_label
    from public.scan_events e
    join public.product_units pu on pu.id = e.unit_id
    join public.products p on p.id = pu.product_id
    where (public.is_admin() or e.scanner_id in (select public.visible_scanner_ids()))
      and (p_before is null or (e.scanned_at, e.id) < (p_before, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
    order by e.scanned_at desc, e.id desc
    limit v_limit + 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'scanned_at', scanned_at, 'location_status', location_status,
    'location_area', location_area, 'location_city', location_city,
    'location_state', location_state, 'location_country', location_country,
    'flags', flags, 'latitude', latitude, 'longitude', longitude,
    'product_name', product_name, 'batch_number', batch_number, 'unit_label', unit_label
  ) order by scanned_at desc, id desc), '[]'::jsonb) into v_rows
  from (select * from page limit v_limit) q;
  return jsonb_build_object('rows', v_rows, 'limit', v_limit);
end $$;

create function public.vendor_my_products(p_limit int default 100) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.app_settings; v_rows jsonb;
begin
  if not (public.is_vendor() or public.is_admin()) then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into s from public.app_settings;
  select coalesce(jsonb_agg(item order by last_at desc), '[]'::jsonb) into v_rows
  from (
    select jsonb_strip_nulls(jsonb_build_object(
      'name', p.name, 'manufacturer', p.manufacturer, 'category', p.category,
      'batch_number', p.batch_number, 'expiry_date', p.expiry_date,
      'is_expired', p.expiry_date is not null and p.expiry_date < public.local_today(),
      'sku', case when s.vendor_sees_sku then p.sku else null end,
      'units_seen', count(distinct e.unit_id), 'last_scanned_at', max(e.scanned_at)
    )) as item, max(e.scanned_at) as last_at
    from public.scan_events e
    join public.product_units pu on pu.id = e.unit_id
    join public.products p on p.id = pu.product_id
    where public.is_admin() or e.scanner_id in (select public.visible_scanner_ids())
    group by p.id
    limit least(greatest(coalesce(p_limit, 100), 1), 200)
  ) q;
  return v_rows;
end $$;

create function public.org_scans(p_org uuid, p_before timestamptz default null, p_before_id uuid default null, p_limit int default 25)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_limit int := least(greatest(coalesce(p_limit, 25), 1), 100); v_rows jsonb;
begin
  if not (public.is_admin() or public.is_org_manager(p_org)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  with page as (
    select e.id, e.scanned_at, e.location_city, e.location_state, pr.full_name as scanner_name,
           p.name as product_name, public.unit_label(p.batch_number, pu.serial) as unit_label
    from public.scan_events e
    join public.product_units pu on pu.id = e.unit_id
    join public.products p on p.id = pu.product_id
    left join public.profiles pr on pr.id = e.scanner_id
    where e.scanner_id in (select user_id from public.org_members where org_id = p_org and status = 'active')
      and (p_before is null or (e.scanned_at, e.id) < (p_before, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
    order by e.scanned_at desc, e.id desc
    limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'scanned_at', scanned_at, 'location_city', location_city, 'location_state', location_state,
    'scanner_name', scanner_name, 'product_name', product_name, 'unit_label', unit_label
  ) order by scanned_at desc), '[]'::jsonb) into v_rows from page;
  return jsonb_build_object('rows', v_rows);
end $$;

revoke all on function public.scan_daily_add(), public.visible_scanner_ids(),
  public.vendor_my_scans(timestamptz, uuid, int), public.vendor_my_products(int),
  public.org_scans(uuid, timestamptz, uuid, int)
  from public, anon, authenticated;
grant execute on function public.vendor_my_scans(timestamptz, uuid, int), public.vendor_my_products(int),
  public.org_scans(uuid, timestamptz, uuid, int)
  to authenticated;
