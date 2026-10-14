-- 0002_functions_views.sql : admin RPCs, public tracking boundary, dashboard/map queries.

-- ====================== views (RLS applies as the calling user) ======================
create view public.product_overview with (security_invoker = true) as
select p.*,
       coalesce(u.unit_count, 0)    as unit_count,
       coalesce(u.scanned_units, 0) as scanned_units,
       ls.scanned_at                as last_scan_at,
       ls.latitude                  as last_scan_lat,
       ls.longitude                 as last_scan_lon,
       ls.accuracy_m                as last_scan_accuracy_m,
       (p.expiry_date is not null and p.expiry_date < public.local_today()) as is_expired
from public.products p
left join lateral (
  select count(*) as unit_count, count(*) filter (where pu.scan_count > 0) as scanned_units
  from public.product_units pu where pu.product_id = p.id
) u on true
left join lateral (
  select e.scanned_at, e.latitude, e.longitude, e.accuracy_m
  from public.product_units pu
  join public.scan_events e on e.id = pu.last_scan_id
  where pu.product_id = p.id
  order by pu.last_scan_at desc limit 1
) ls on true;

-- "Suspicious" = behavioural flags only. low_accuracy / expired_product are informational.
-- These are indicators for investigation, not proof of counterfeiting.
create view public.suspicious_scans with (security_invoker = true) as
select e.id as scan_id, e.scanned_at, e.flags, e.latitude, e.longitude, e.accuracy_m,
       e.unit_id, pu.product_id, p.name as product_name, p.batch_number,
       public.unit_label(p.batch_number, pu.serial) as unit_label
from public.scan_events e
join public.product_units pu on pu.id = e.unit_id
join public.products p on p.id = pu.product_id
where e.flags && array['rapid_repeat', 'implausible_travel', 'high_frequency'];

-- ====================== internal helpers (service_role only) ======================
create function public.token_fingerprint(p_token text) returns text
language sql immutable set search_path = public, extensions as $$
  select left(encode(digest(coalesce(p_token, ''), 'sha256'), 'hex'), 12);
$$;

create function public.log_rejected(p_token text, p_unit uuid, p_reason text, p_ip_hash text) returns void
language sql security definer set search_path = public as $$
  insert into public.rejected_attempts (token_fingerprint, unit_id, reason, ip_hash)
  values (public.token_fingerprint(p_token), p_unit, p_reason, p_ip_hash);
$$;

-- Atomic fixed-window counter. Returns true while the caller is within the limit.
create function public.check_rate_limit(p_key text, p_limit int, p_window_seconds int) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_start timestamptz; v_count int;
begin
  v_start := to_timestamp(floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limits as r (key, window_start, count) values (p_key, v_start, 1)
  on conflict (key, window_start) do update set count = r.count + 1
  returning r.count into v_count;
  if random() < 0.01 then
    delete from public.rate_limits where window_start < now() - interval '1 hour';
  end if;
  return v_count <= p_limit;
end $$;

-- ====================== public tracking boundary (service_role only) ======================
-- Explicit allow-list of public fields. Not exposed: id, sku, price, created_by, internal ids.
create function public.public_lookup(p_token text, p_ip_hash text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u public.product_units; p public.products; s public.app_settings;
begin
  select * into s from public.app_settings;
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{22}$' then
    perform public.log_rejected(p_token, null, 'malformed_token', p_ip_hash);
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into u from public.product_units where token = p_token;
  if not found then
    perform public.log_rejected(p_token,
      (select unit_id from public.revoked_tokens where token = p_token), 'unknown_or_replaced_token', p_ip_hash);
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into p from public.products where id = u.product_id;
  if u.status = 'revoked' then
    perform public.log_rejected(p_token, u.id, 'revoked_token', p_ip_hash);
    return jsonb_build_object('status', 'revoked');
  end if;
  if p.status = 'archived' then
    return jsonb_build_object('status', 'unavailable');
  end if;
  return jsonb_build_object(
    'status', 'ok',
    'product', jsonb_build_object(
      'name', p.name, 'manufacturer', p.manufacturer, 'category', p.category,
      'description', p.description, 'batch_number', p.batch_number,
      'manufacturing_date', p.manufacturing_date, 'expiry_date', p.expiry_date,
      'is_expired', p.expiry_date is not null and p.expiry_date < public.local_today(),
      'package_type', p.package_type, 'package_description', p.package_description,
      'package_quantity', p.package_quantity, 'unit_of_measure', p.unit_of_measure,
      'unit_label', public.unit_label(p.batch_number, u.serial)),
    'tracking', jsonb_build_object(
      'allow_scan_without_gps', s.allow_scan_without_gps, 'max_accuracy_m', s.max_accuracy_m));
end $$;

create function public.record_scan(
  p_token text, p_idem uuid, p_lat double precision, p_lon double precision, p_accuracy real,
  p_loc_status public.location_status, p_loc_captured_at timestamptz,
  p_vendor_ref text, p_ip_hash text, p_ua text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s public.app_settings; u public.product_units; p public.products; prev public.scan_events;
  v_flags text[] := '{}'; v_now timestamptz := clock_timestamp();
  v_id uuid; v_dist double precision; v_hours double precision; v_gps boolean; v_n int;
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
  if not v_gps then p_lat := null; p_lon := null; p_accuracy := null; end if;
  p_vendor_ref := left(nullif(btrim(p_vendor_ref), ''), 100);

  -- Row lock serialises scans of one unit so flag evaluation sees a consistent history.
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

  -- Idempotent retry: same key returns the original event instead of inserting another.
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
      -- Ignore movement that is within the combined GPS uncertainty of the two readings.
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
    location_status, location_captured_at, vendor_reference, ip_hash, user_agent, flags)
  values (u.id, p_idem, v_now, p_lat, p_lon, p_accuracy, p_loc_status, p_loc_captured_at,
    p_vendor_ref, p_ip_hash, left(p_ua, 300), v_flags)
  returning id into v_id;
  update public.product_units
     set scan_count = scan_count + 1, last_scan_at = v_now, last_scan_id = v_id where id = u.id;

  return jsonb_build_object('result', 'accepted', 'scan_id', v_id, 'replayed', false,
                            'recorded_at', v_now, 'location_recorded', v_gps);
end $$;

-- Scheduled maintenance: removes precise coordinates after the retention window.
-- Scan rows themselves are kept (counts, timestamps, flags remain meaningful).
create function public.purge_old_locations() returns integer
language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  perform set_config('app.scan_maintenance', 'on', true);
  update public.scan_events e
     set latitude = null, longitude = null, accuracy_m = null, location_purged_at = now()
   where e.latitude is not null
     and e.scanned_at < now() - make_interval(days => (select location_retention_days from public.app_settings));
  get diagnostics v_n = row_count;
  perform set_config('app.scan_maintenance', 'off', true);
  return v_n;
end $$;

-- ====================== admin RPCs (is_admin() enforced inside) ======================
create function public.create_product_with_units(p jsonb, unit_count int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if unit_count is null or unit_count not between 1 and 1000 then
    raise exception 'unit_count must be between 1 and 1000' using errcode = '22023';
  end if;
  -- Explicit column list: unknown keys in p are ignored (no mass assignment).
  insert into public.products (name, sku, description, category, batch_number, manufacturing_date,
    expiry_date, unit_price, currency, package_quantity, unit_of_measure, package_type,
    package_description, image_path, manufacturer, created_by)
  values (p ->> 'name', nullif(p ->> 'sku', ''), nullif(p ->> 'description', ''), nullif(p ->> 'category', ''),
    nullif(p ->> 'batch_number', ''), nullif(p ->> 'manufacturing_date', '')::date,
    nullif(p ->> 'expiry_date', '')::date, nullif(p ->> 'unit_price', '')::numeric,
    coalesce(nullif(p ->> 'currency', ''), 'INR'), nullif(p ->> 'package_quantity', '')::int,
    nullif(p ->> 'unit_of_measure', ''), nullif(p ->> 'package_type', ''),
    nullif(p ->> 'package_description', ''), nullif(p ->> 'image_path', ''),
    nullif(p ->> 'manufacturer', ''), auth.uid())
  returning id into v_id;
  insert into public.product_units (product_id, serial, token)
  select v_id, g, public.generate_token() from generate_series(1, unit_count) g;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'units.generated', 'product', v_id, jsonb_build_object('count', unit_count));
  return jsonb_build_object('product_id', v_id, 'unit_count', unit_count);
end $$;

create function public.add_units(p_product uuid, p_count int) returns int
language plpgsql security definer set search_path = public as $$
declare v_max int;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_count is null or p_count not between 1 and 1000 then
    raise exception 'count must be between 1 and 1000' using errcode = '22023';
  end if;
  perform 1 from public.products where id = p_product and status = 'active' for update;
  if not found then raise exception 'product not found or archived' using errcode = 'P0002'; end if;
  select coalesce(max(serial), 0) into v_max from public.product_units where product_id = p_product;
  insert into public.product_units (product_id, serial, token)
  select p_product, v_max + g, public.generate_token() from generate_series(1, p_count) g;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'units.generated', 'product', p_product, jsonb_build_object('count', p_count));
  return p_count;
end $$;

-- Replace a compromised token. The unit keeps its identity (id, serial, history); the old
-- token moves to revoked_tokens so later scans of old labels are logged as attempts.
create function public.rotate_unit_token(p_unit uuid, p_reason text default null) returns text
language plpgsql security definer set search_path = public as $$
declare u public.product_units; v_new text;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into u from public.product_units where id = p_unit for update;
  if not found then raise exception 'unit not found' using errcode = 'P0002'; end if;
  insert into public.revoked_tokens (token, unit_id, reason) values (u.token, u.id, left(p_reason, 500));
  v_new := public.generate_token();
  update public.product_units
     set token = v_new, status = 'active', revoked_at = null, revoked_reason = null where id = u.id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'unit.token_rotated', 'product_unit', u.id, jsonb_build_object('reason', left(p_reason, 500)));
  return v_new;
end $$;

create function public.revoke_unit(p_unit uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.product_units
     set status = 'revoked', revoked_at = now(), revoked_reason = left(p_reason, 500)
   where id = p_unit and status = 'active';
  if not found then raise exception 'unit not found or already revoked' using errcode = 'P0002'; end if;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'unit.revoked', 'product_unit', p_unit, jsonb_build_object('reason', left(p_reason, 500)));
end $$;

-- Metric definitions (all "today"/expiry boundaries use app_settings.timezone):
--   products_*        : product records. products_scanned = has >=1 unit with >=1 scan.
--   units_*           : physical units. units_never_scanned = scan_count = 0.
--   scans_total/today : accepted scan_events rows ("today" = since local midnight).
--   expired_products  : active products with expiry_date < local today.
--   expiring_soon     : active, expiry within expiring_soon_days (inclusive of today).
--   units_suspicious_30d : distinct units with a behavioural flag in the last 30 days.
create function public.dashboard_metrics() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.app_settings; v_today date; v_start timestamptz; r jsonb;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into s from public.app_settings;
  v_today := public.local_today();
  v_start := v_today::timestamp at time zone s.timezone;
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
    'scans_total', (select count(*) from public.scan_events),
    'scans_today', (select count(*) from public.scan_events where scanned_at >= v_start),
    'units_suspicious_30d', (select count(distinct unit_id) from public.suspicious_scans
                              where scanned_at >= now() - interval '30 days'),
    'timezone', s.timezone);
  return r;
end $$;

create function public.scan_activity_series(p_days int default 30)
returns table (day date, scans bigint, flagged bigint)
language plpgsql stable security definer set search_path = public as $$
declare s public.app_settings;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_days is null or p_days not between 1 and 365 then
    raise exception 'p_days must be between 1 and 365' using errcode = '22023';
  end if;
  select * into s from public.app_settings;
  return query
  select d::date, count(e.id),
         count(e.id) filter (where e.flags && array['rapid_repeat', 'implausible_travel', 'high_frequency'])
  from generate_series(public.local_today() - (p_days - 1), public.local_today(), interval '1 day') d
  left join public.scan_events e
    on e.scanned_at >= (d at time zone s.timezone)
   and e.scanned_at <  ((d + interval '1 day') at time zone s.timezone)
  group by d order by d;
end $$;

-- Security invoker: RLS decides who can read; non-admins get no rows.
create function public.map_points(p_product uuid default null, p_batch text default null,
  p_from timestamptz default null, p_to timestamptz default null,
  p_flagged boolean default false, p_limit int default 2000)
returns table (scan_id uuid, unit_id uuid, product_id uuid, product_name text, batch_number text,
  unit_label text, scanned_at timestamptz, latitude double precision, longitude double precision,
  accuracy_m real, flags text[])
language sql stable security invoker set search_path = public as $$
  select e.id, e.unit_id, p.id, p.name, p.batch_number, public.unit_label(p.batch_number, pu.serial),
         e.scanned_at, e.latitude::float8, e.longitude::float8, e.accuracy_m, e.flags
  from public.scan_events e
  join public.product_units pu on pu.id = e.unit_id
  join public.products p on p.id = pu.product_id
  where e.latitude is not null
    and (p_product is null or p.id = p_product)
    and (p_batch is null or lower(p.batch_number) = lower(p_batch))
    and (p_from is null or e.scanned_at >= p_from)
    and (p_to is null or e.scanned_at < p_to)
    and (not p_flagged or e.flags && array['rapid_repeat', 'implausible_travel', 'high_frequency'])
  order by e.scanned_at desc
  limit least(greatest(p_limit, 1), 5000);
$$;
