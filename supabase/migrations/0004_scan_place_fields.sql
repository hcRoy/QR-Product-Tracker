-- 0004_scan_place_fields.sql : store reverse-geocoded place labels on scan_events.
-- Place fields are written at insert time (append-only). They survive purge_old_locations()
-- so coarse location remains after precise coordinates are cleared.

alter table public.scan_events
  add column location_area    text check (location_area    is null or char_length(location_area)    <= 120),
  add column location_city    text check (location_city    is null or char_length(location_city)    <= 120),
  add column location_state   text check (location_state   is null or char_length(location_state)   <= 120),
  add column location_country text check (location_country is null or char_length(location_country) <= 120);

-- Replace record_scan with place-aware signature. Defaults keep existing 10-arg call sites working.
drop function if exists public.record_scan(text, uuid, double precision, double precision, real,
                                           public.location_status, timestamptz, text, text, text);

create function public.record_scan(
  p_token text, p_idem uuid, p_lat double precision, p_lon double precision, p_accuracy real,
  p_loc_status public.location_status, p_loc_captured_at timestamptz,
  p_vendor_ref text, p_ip_hash text, p_ua text,
  p_area text default null, p_city text default null, p_state text default null, p_country text default null
) returns jsonb
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
    location_status, location_captured_at, vendor_reference, ip_hash, user_agent, flags,
    location_area, location_city, location_state, location_country)
  values (u.id, p_idem, v_now, p_lat, p_lon, p_accuracy, p_loc_status, p_loc_captured_at,
    p_vendor_ref, p_ip_hash, left(p_ua, 300), v_flags,
    p_area, p_city, p_state, p_country)
  returning id into v_id;
  update public.product_units
     set scan_count = scan_count + 1, last_scan_at = v_now, last_scan_id = v_id where id = u.id;

  return jsonb_build_object('result', 'accepted', 'scan_id', v_id, 'replayed', false,
                            'recorded_at', v_now, 'location_recorded', v_gps);
end $$;

grant execute on function public.record_scan(text, uuid, double precision, double precision, real,
                                             public.location_status, timestamptz, text, text, text,
                                             text, text, text, text)
  to service_role;

-- map_points: include place labels for the admin map detail panel.
drop function if exists public.map_points(uuid, text, timestamptz, timestamptz, boolean, int);

create function public.map_points(p_product uuid default null, p_batch text default null,
  p_from timestamptz default null, p_to timestamptz default null,
  p_flagged boolean default false, p_limit int default 2000)
returns table (scan_id uuid, unit_id uuid, product_id uuid, product_name text, batch_number text,
  unit_label text, scanned_at timestamptz, latitude double precision, longitude double precision,
  accuracy_m real, flags text[],
  location_area text, location_city text, location_state text, location_country text)
language sql stable security invoker set search_path = public as $$
  select e.id, e.unit_id, p.id, p.name, p.batch_number, public.unit_label(p.batch_number, pu.serial),
         e.scanned_at, e.latitude::float8, e.longitude::float8, e.accuracy_m, e.flags,
         e.location_area, e.location_city, e.location_state, e.location_country
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

grant execute on function public.map_points(uuid, text, timestamptz, timestamptz, boolean, int)
  to authenticated;
