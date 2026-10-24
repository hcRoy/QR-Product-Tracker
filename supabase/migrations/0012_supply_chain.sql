-- 0012_supply_chain.sql : locations, shipments, custody events, discrepancies.
-- State changes go through the functions below. Vendors have no direct table access.
-- A custody retry with the same idempotency key returns the original event.

create type public.location_type as enum ('manufacturer', 'warehouse', 'distributor', 'retailer', 'other');
create type public.unit_state as enum ('registered', 'in_stock', 'in_transit', 'sold', 'lost_or_damaged');
create type public.shipment_status as enum ('draft', 'in_transit', 'partially_received', 'received', 'cancelled', 'closed');
create type public.custody_event_type as enum ('placed', 'dispatched', 'received', 'sold', 'reported_lost');
create type public.geofence_status as enum ('inside', 'outside', 'no_gps', 'no_reference');
create type public.discrepancy_kind as enum ('wrong_destination', 'unit_not_in_shipment', 'geofence_mismatch', 'missing_on_close');
create type public.discrepancy_status as enum ('open', 'resolved');
create type public.shipment_unit_status as enum ('expected', 'received', 'missing', 'removed');

create sequence public.shipment_ref_seq;

alter table public.product_units
  add column unit_state public.unit_state not null default 'registered',
  add column current_location_id uuid,
  add column current_shipment_id uuid,
  add column state_changed_at timestamptz not null default now();

create table public.locations (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete restrict,
  code              text check (code is null or char_length(btrim(code)) between 1 and 40),
  name              text not null check (char_length(btrim(name)) between 1 and 200),
  type              public.location_type not null default 'other',
  address_line      text check (address_line is null or char_length(address_line) <= 300),
  city              text check (city is null or char_length(city) <= 120),
  state             text check (state is null or char_length(state) <= 120),
  country           text check (country is null or char_length(country) <= 120),
  postal_code       text check (postal_code is null or char_length(postal_code) <= 20),
  latitude          numeric(9,6) check (latitude between -90 and 90),
  longitude         numeric(9,6) check (longitude between -180 and 180),
  geofence_radius_m integer not null default 200 check (geofence_radius_m > 0),
  is_active         boolean not null default true,
  created_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  constraint locations_coords_pair check ((latitude is null) = (longitude is null)),
  unique (org_id, code)
);
create index locations_org_idx on public.locations (org_id);

alter table public.product_units
  add constraint product_units_location_fk foreign key (current_location_id) references public.locations(id) on delete set null;

create table public.location_members (
  location_id uuid not null references public.locations(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  added_by    uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (location_id, user_id)
);

create function public.location_members_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from public.locations l
    join public.org_members m on m.org_id = l.org_id
    where l.id = new.location_id and m.user_id = new.user_id and m.status = 'active'
  ) then
    raise exception 'user is not an active member of this organization' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger location_members_guard before insert or update on public.location_members
  for each row execute function public.location_members_guard();

create table public.shipments (
  id                      uuid primary key default gen_random_uuid(),
  reference               text not null unique,
  origin_location_id      uuid not null references public.locations(id) on delete restrict,
  destination_location_id uuid not null references public.locations(id) on delete restrict,
  origin_org_id           uuid not null references public.organizations(id) on delete restrict,
  destination_org_id      uuid not null references public.organizations(id) on delete restrict,
  status                  public.shipment_status not null default 'draft',
  idempotency_key         uuid unique,
  note                    text check (note is null or char_length(note) <= 500),
  created_by              uuid references public.profiles(id) on delete set null,
  dispatched_at           timestamptz,
  closed_at               timestamptz,
  created_at              timestamptz not null default now(),
  constraint shipments_distinct_ends check (origin_location_id <> destination_location_id)
);
create index shipments_status_idx on public.shipments (status, created_at desc);
create index shipments_dest_idx on public.shipments (destination_location_id, status);

alter table public.product_units
  add constraint product_units_shipment_fk foreign key (current_shipment_id) references public.shipments(id) on delete set null;

create table public.shipment_units (
  id          uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.shipments(id) on delete cascade,
  unit_id     uuid not null references public.product_units(id) on delete restrict,
  status      public.shipment_unit_status not null default 'expected',
  is_open     boolean not null default true,
  unique (shipment_id, unit_id)
);
create unique index shipment_units_one_open on public.shipment_units (unit_id) where is_open;
create index shipment_units_shipment_idx on public.shipment_units (shipment_id);

create table public.custody_events (
  id               uuid primary key default gen_random_uuid(),
  unit_id          uuid not null references public.product_units(id) on delete restrict,
  shipment_id      uuid references public.shipments(id) on delete set null,
  location_id      uuid references public.locations(id) on delete set null,
  event_type       public.custody_event_type not null,
  actor_id         uuid references public.profiles(id) on delete set null,
  idempotency_key  uuid not null,
  occurred_at      timestamptz not null default clock_timestamp(),
  scan_event_id    uuid references public.scan_events(id) on delete set null,
  geofence_status  public.geofence_status,
  distance_m       integer check (distance_m is null or distance_m >= 0),
  note             text check (note is null or char_length(note) <= 500),
  unique (unit_id, idempotency_key)
);
create index custody_events_unit_idx on public.custody_events (unit_id, occurred_at desc);
create index custody_events_time_idx on public.custody_events (occurred_at desc);

create function public.custody_events_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'custody_events is append-only' using errcode = '42501';
end $$;
create trigger custody_events_immutable before update or delete on public.custody_events
  for each row execute function public.custody_events_immutable();

create table public.discrepancies (
  id          uuid primary key default gen_random_uuid(),
  kind        public.discrepancy_kind not null,
  status      public.discrepancy_status not null default 'open',
  unit_id     uuid references public.product_units(id) on delete set null,
  shipment_id uuid references public.shipments(id) on delete set null,
  location_id uuid references public.locations(id) on delete set null,
  actor_id    uuid references public.profiles(id) on delete set null,
  note        text check (note is null or char_length(note) <= 500),
  resolution  text check (resolution is null or char_length(resolution) <= 500),
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete set null
);
create index discrepancies_status_idx on public.discrepancies (status, created_at desc);

alter table public.locations enable row level security;
alter table public.location_members enable row level security;
alter table public.shipments enable row level security;
alter table public.shipment_units enable row level security;
alter table public.custody_events enable row level security;
alter table public.discrepancies enable row level security;

create policy locations_select on public.locations for select to authenticated using (public.is_admin());
create policy location_members_select on public.location_members for select to authenticated using (public.is_admin());
create policy shipments_select on public.shipments for select to authenticated using (public.is_admin());
create policy shipment_units_select on public.shipment_units for select to authenticated using (public.is_admin());
create policy custody_events_select on public.custody_events for select to authenticated using (public.is_admin());
create policy discrepancies_select on public.discrepancies for select to authenticated using (public.is_admin());

grant select on public.locations, public.location_members, public.shipments, public.shipment_units,
                 public.custody_events, public.discrepancies
  to authenticated;

-- ---------- helpers ----------
create function public.vendor_assigned(p_user uuid, p_location uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.location_members lm
    join public.locations l on l.id = lm.location_id and l.is_active
    join public.org_members m on m.org_id = l.org_id and m.user_id = p_user and m.status = 'active'
    join public.profiles pr on pr.id = p_user and pr.is_active and pr.role = 'vendor'
    where lm.user_id = p_user and lm.location_id = p_location and public.org_is_active(l.org_id)
  );
$$;

create function public.actor_can_act(p_location uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or public.vendor_assigned(auth.uid(), p_location);
$$;

create function public.derived_idem(p_idem uuid, p_unit uuid) returns uuid
language sql immutable as $$
  select (
    substr(md5(p_idem::text || p_unit::text), 1, 8) || '-' ||
    substr(md5(p_idem::text || p_unit::text), 9, 4) || '-' ||
    substr(md5(p_idem::text || p_unit::text), 13, 4) || '-' ||
    substr(md5(p_idem::text || p_unit::text), 17, 4) || '-' ||
    substr(md5(p_idem::text || p_unit::text), 21, 12)
  )::uuid;
$$;

create function public.eval_geofence(
  p_location uuid, p_lat double precision, p_lon double precision, p_accuracy real, p_status public.location_status
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.app_settings; loc public.locations; v_m double precision; v_status public.geofence_status := 'no_reference';
  v_blocked boolean := false; v_reason text;
begin
  select * into s from public.app_settings;
  if p_location is not null then
    select * into loc from public.locations where id = p_location;
  end if;
  if loc.id is null or loc.latitude is null then
    v_status := 'no_reference';
  elsif p_status is distinct from 'granted' or p_lat is null or p_lon is null then
    v_status := 'no_gps';
    if s.require_gps_for_custody then v_blocked := true; v_reason := 'location_required'; end if;
  else
    v_m := public.haversine_km(loc.latitude::float8, loc.longitude::float8, p_lat, p_lon) * 1000.0;
    if v_m - coalesce(p_accuracy, 0) <= loc.geofence_radius_m then v_status := 'inside';
    else
      v_status := 'outside';
      if s.geofence_mode = 'block' then v_blocked := true; v_reason := 'geofence'; end if;
    end if;
  end if;
  return jsonb_build_object('status', v_status, 'distance_m', case when v_m is null then null else round(v_m)::int end,
                            'blocked', v_blocked, 'reason', v_reason);
end $$;

-- Writes one custody event and the linked scan. Caller has already checked the transition.
create function public.custody_apply(
  p_type public.custody_event_type, p_unit uuid, p_location uuid, p_shipment uuid, p_idem uuid,
  p_lat double precision, p_lon double precision, p_accuracy real, p_loc_status public.location_status, p_note text,
  p_next public.unit_state, p_next_location uuid, p_next_shipment uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_existing uuid; v_scan uuid; v_id uuid; v_now timestamptz := clock_timestamp();
  g jsonb; v_uid uuid := auth.uid(); u public.product_units;
begin
  select id into v_existing from public.custody_events where unit_id = p_unit and idempotency_key = p_idem;
  if found then
    return jsonb_build_object('result', 'accepted', 'replayed', true, 'custody_id', v_existing);
  end if;
  if p_loc_status = 'granted' and (p_lat is null or p_lon is null or p_accuracy is null
     or p_lat not between -90 and 90 or p_lon not between -180 and 180 or p_accuracy < 0) then
    return jsonb_build_object('result', 'rejected', 'reason', 'invalid_input');
  end if;
  g := public.eval_geofence(p_location, p_lat, p_lon, p_accuracy, p_loc_status);
  if (g ->> 'blocked')::boolean then
    return jsonb_build_object('result', 'rejected', 'reason', g ->> 'reason', 'geofence', g ->> 'status');
  end if;
  if p_loc_status is distinct from 'granted' then
    p_lat := null; p_lon := null; p_accuracy := null;
  end if;
  select * into u from public.product_units where id = p_unit;
  insert into public.scan_events (unit_id, idempotency_key, scanned_at, latitude, longitude, accuracy_m,
    location_status, source, scanner_id, flags)
  values (p_unit, p_idem, v_now, p_lat, p_lon, p_accuracy, p_loc_status,
    case when public.is_admin() then 'admin' else 'vendor' end, v_uid, '{}')
  returning id into v_scan;
  update public.product_units
     set scan_count = scan_count + 1, last_scan_at = v_now, last_scan_id = v_scan
   where id = p_unit;
  insert into public.custody_events (unit_id, shipment_id, location_id, event_type, actor_id, idempotency_key,
    occurred_at, scan_event_id, geofence_status, distance_m, note)
  values (p_unit, p_shipment, p_location, p_type, v_uid, p_idem, v_now, v_scan,
    (g ->> 'status')::public.geofence_status, nullif(g ->> 'distance_m', '')::int, left(nullif(btrim(p_note), ''), 500))
  returning id into v_id;
  update public.product_units
     set unit_state = p_next, current_location_id = p_next_location, current_shipment_id = p_next_shipment,
         state_changed_at = v_now
   where id = p_unit;
  if (g ->> 'status') = 'outside' then
    insert into public.discrepancies (kind, unit_id, shipment_id, location_id, actor_id, note)
    values ('geofence_mismatch', p_unit, p_shipment, p_location, v_uid, 'Reported position was outside the location geofence');
  end if;
  return jsonb_build_object('result', 'accepted', 'replayed', false, 'custody_id', v_id, 'geofence', g ->> 'status');
end $$;

create function public.require_actor() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not exists (select 1 from public.profiles where id = auth.uid() and is_active and role in ('admin', 'vendor')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end $$;

create function public.place_units(p_location uuid, p_units uuid[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_n int := 0; r jsonb;
begin
  perform public.require_actor();
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(cardinality(p_units), 0) < 1 or cardinality(p_units) > 500 then
    raise exception 'place 1 to 500 units' using errcode = '22023';
  end if;
  if not exists (select 1 from public.locations where id = p_location and is_active) then
    raise exception 'location not found' using errcode = 'P0002';
  end if;
  foreach v_id in array p_units loop
    perform 1 from public.product_units where id = v_id and status = 'active' and unit_state = 'registered' for update;
    if not found then
      return jsonb_build_object('result', 'rejected', 'reason', 'illegal_transition', 'unit_id', v_id);
    end if;
  end loop;
  foreach v_id in array p_units loop
    r := public.custody_apply('placed', v_id, p_location, null, gen_random_uuid(), null, null, null, 'unsupported', null,
                              'in_stock', p_location, null);
    if r ->> 'result' <> 'accepted' then return r; end if;
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('result', 'accepted', 'count', v_n);
end $$;

create function public.create_shipment(p_origin uuid, p_destination uuid, p_note text default null, p_idem uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.locations; d public.locations; v_id uuid; v_ref text;
begin
  perform public.require_actor();
  if p_idem is not null then
    select id into v_id from public.shipments where idempotency_key = p_idem;
    if found then return jsonb_build_object('shipment_id', v_id, 'replayed', true); end if;
  end if;
  select * into o from public.locations where id = p_origin and is_active;
  select * into d from public.locations where id = p_destination and is_active;
  if o.id is null or d.id is null then raise exception 'location not found' using errcode = 'P0002'; end if;
  if o.id = d.id then raise exception 'origin and destination must differ' using errcode = '22023'; end if;
  if not public.org_is_active(d.org_id) then raise exception 'destination organization is not active' using errcode = '42501'; end if;
  if not public.actor_can_act(o.id) then raise exception 'forbidden' using errcode = '42501'; end if;
  v_ref := 'SHP-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.shipment_ref_seq')::text, 6, '0');
  insert into public.shipments (reference, origin_location_id, destination_location_id, origin_org_id, destination_org_id,
    idempotency_key, note, created_by)
  values (v_ref, o.id, d.id, o.org_id, d.org_id, p_idem, left(nullif(btrim(p_note), ''), 500), auth.uid())
  returning id into v_id;
  return jsonb_build_object('shipment_id', v_id, 'reference', v_ref, 'replayed', false);
end $$;

create function public.shipment_add_units(p_shipment uuid, p_units uuid[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare sh public.shipments; v_id uuid; u public.product_units; v_n int := 0;
begin
  perform public.require_actor();
  select * into sh from public.shipments where id = p_shipment for update;
  if not found or sh.status <> 'draft' then
    return jsonb_build_object('result', 'rejected', 'reason', 'illegal_transition');
  end if;
  if not public.actor_can_act(sh.origin_location_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(cardinality(p_units), 0) < 1 or cardinality(p_units) > 500 then
    raise exception 'add 1 to 500 units' using errcode = '22023';
  end if;
  foreach v_id in array p_units loop
    select * into u from public.product_units where id = v_id for update;
    if not found or u.status <> 'active' or u.unit_state <> 'in_stock' or u.current_location_id is distinct from sh.origin_location_id then
      return jsonb_build_object('result', 'rejected', 'reason', 'illegal_transition', 'unit_id', v_id);
    end if;
    if exists (select 1 from public.shipment_units where unit_id = v_id and is_open) then
      return jsonb_build_object('result', 'rejected', 'reason', 'already_in_shipment', 'unit_id', v_id);
    end if;
  end loop;
  foreach v_id in array p_units loop
    insert into public.shipment_units (shipment_id, unit_id, status, is_open) values (sh.id, v_id, 'expected', true);
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('result', 'accepted', 'count', v_n);
exception when unique_violation then
  return jsonb_build_object('result', 'rejected', 'reason', 'already_in_shipment');
end $$;

create function public.dispatch_shipment(
  p_shipment uuid, p_idem uuid,
  p_lat double precision default null, p_lon double precision default null, p_accuracy real default null,
  p_loc_status public.location_status default 'denied'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare sh public.shipments; u public.product_units; r jsonb; g jsonb; v_unit uuid;
begin
  perform public.require_actor();
  if p_idem is null then return jsonb_build_object('result', 'rejected', 'reason', 'invalid_input'); end if;
  select * into sh from public.shipments where id = p_shipment for update;
  if not found then raise exception 'shipment not found' using errcode = 'P0002'; end if;
  if sh.status = 'in_transit' and sh.idempotency_key = p_idem then
    return jsonb_build_object('result', 'accepted', 'replayed', true, 'shipment_id', sh.id);
  end if;
  if sh.status <> 'draft' then return jsonb_build_object('result', 'rejected', 'reason', 'illegal_transition'); end if;
  if not public.actor_can_act(sh.origin_location_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_loc_status = 'granted' and (p_lat is null or p_lon is null or p_accuracy is null
     or p_lat not between -90 and 90 or p_lon not between -180 and 180 or p_accuracy < 0) then
    return jsonb_build_object('result', 'rejected', 'reason', 'invalid_input');
  end if;
  if not exists (select 1 from public.shipment_units where shipment_id = sh.id and status = 'expected') then
    return jsonb_build_object('result', 'rejected', 'reason', 'empty_shipment');
  end if;
  for u in
    select pu.* from public.product_units pu
    join public.shipment_units su on su.unit_id = pu.id and su.shipment_id = sh.id and su.status = 'expected'
    for update of pu
  loop
    if u.status <> 'active' or u.unit_state <> 'in_stock' or u.current_location_id is distinct from sh.origin_location_id then
      return jsonb_build_object('result', 'rejected', 'reason', 'illegal_transition', 'unit_id', u.id);
    end if;
  end loop;
  g := public.eval_geofence(sh.origin_location_id, p_lat, p_lon, p_accuracy, p_loc_status);
  if (g ->> 'blocked')::boolean then
    return jsonb_build_object('result', 'rejected', 'reason', g ->> 'reason', 'geofence', g ->> 'status');
  end if;
  for v_unit in select unit_id from public.shipment_units where shipment_id = sh.id and status = 'expected' loop
    r := public.custody_apply('dispatched', v_unit, sh.origin_location_id, sh.id, public.derived_idem(p_idem, v_unit),
      p_lat, p_lon, p_accuracy, p_loc_status, null, 'in_transit', sh.origin_location_id, sh.id);
    if r ->> 'result' <> 'accepted' then return r; end if;
  end loop;
  update public.shipments set status = 'in_transit', dispatched_at = clock_timestamp(), idempotency_key = p_idem where id = sh.id;
  return jsonb_build_object('result', 'accepted', 'replayed', false, 'shipment_id', sh.id);
end $$;

create function public.record_custody_action(
  p_action text, p_token text, p_location uuid, p_shipment uuid, p_idem uuid,
  p_lat double precision default null, p_lon double precision default null, p_accuracy real default null,
  p_loc_status public.location_status default 'denied', p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u public.product_units; p public.products; loc public.locations; sh public.shipments; su public.shipment_units;
  r jsonb; v_open int;
begin
  perform public.require_actor();
  if p_idem is null or p_token is null or p_token !~ '^[A-Za-z0-9_-]{22}$' or p_action not in ('receive', 'sell', 'report_lost') then
    return jsonb_build_object('result', 'rejected', 'reason', 'invalid_input');
  end if;
  select * into u from public.product_units where token = p_token for update;
  if not found or u.status = 'revoked' then
    return jsonb_build_object('result', 'rejected', 'reason', case when not found then 'invalid_token' else 'revoked' end);
  end if;
  select * into p from public.products where id = u.product_id;
  if p.status = 'archived' then return jsonb_build_object('result', 'rejected', 'reason', 'unavailable'); end if;
  if exists (select 1 from public.custody_events where unit_id = u.id and idempotency_key = p_idem) then
    return jsonb_build_object('result', 'accepted', 'replayed', true);
  end if;
  if p_location is not null then
    select * into loc from public.locations where id = p_location and is_active;
    if not found then return jsonb_build_object('result', 'rejected', 'reason', 'invalid_input'); end if;
    if not public.actor_can_act(loc.id) then raise exception 'forbidden' using errcode = '42501'; end if;
  end if;

  if p_action = 'receive' then
    if p_location is null then return jsonb_build_object('result', 'rejected', 'reason', 'invalid_input'); end if;
    select * into su from public.shipment_units where unit_id = u.id and is_open limit 1;
    if not found then
      insert into public.discrepancies (kind, unit_id, location_id, actor_id, note)
      values ('unit_not_in_shipment', u.id, p_location, auth.uid(), 'Receive attempted for a unit that is not in an open shipment');
      return jsonb_build_object('result', 'rejected', 'reason', 'unit_not_in_shipment');
    end if;
    select * into sh from public.shipments where id = su.shipment_id for update;
    if p_shipment is not null and p_shipment is distinct from sh.id then
      insert into public.discrepancies (kind, unit_id, shipment_id, location_id, actor_id)
      values ('unit_not_in_shipment', u.id, p_shipment, p_location, auth.uid());
      return jsonb_build_object('result', 'rejected', 'reason', 'unit_not_in_shipment');
    end if;
    if p_location is distinct from sh.destination_location_id or u.unit_state <> 'in_transit' then
      insert into public.discrepancies (kind, unit_id, shipment_id, location_id, actor_id, note)
      values ('wrong_destination', u.id, sh.id, p_location, auth.uid(), 'Receive location does not match the shipment destination');
      return jsonb_build_object('result', 'rejected', 'reason', 'wrong_destination');
    end if;
    r := public.custody_apply('received', u.id, sh.destination_location_id, sh.id, p_idem,
      p_lat, p_lon, p_accuracy, p_loc_status, p_note, 'in_stock', sh.destination_location_id, null);
    if r ->> 'result' <> 'accepted' or (r ->> 'replayed')::boolean then return r; end if;
    update public.shipment_units set status = 'received', is_open = false where id = su.id;
    select count(*) into v_open from public.shipment_units where shipment_id = sh.id and is_open;
    update public.shipments set status = case when v_open = 0 then 'received'::public.shipment_status else 'partially_received'::public.shipment_status end
     where id = sh.id;
    return r;
  elsif p_action = 'sell' then
    if u.unit_state <> 'in_stock' or p_location is null or u.current_location_id is distinct from p_location or loc.type <> 'retailer' then
      return jsonb_build_object('result', 'rejected', 'reason', 'illegal_transition');
    end if;
    return public.custody_apply('sold', u.id, p_location, null, p_idem, p_lat, p_lon, p_accuracy, p_loc_status, p_note,
      'sold', p_location, null);
  elsif p_action = 'report_lost' then
    if nullif(btrim(p_note), '') is null then return jsonb_build_object('result', 'rejected', 'reason', 'note_required'); end if;
    if u.unit_state not in ('registered', 'in_stock', 'in_transit') then
      return jsonb_build_object('result', 'rejected', 'reason', 'illegal_transition');
    end if;
    if u.unit_state = 'registered' and not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
    if u.unit_state = 'in_stock' and not public.actor_can_act(u.current_location_id) then raise exception 'forbidden' using errcode = '42501'; end if;
    if u.unit_state = 'in_transit' then
      select * into su from public.shipment_units where unit_id = u.id and is_open limit 1;
      select * into sh from public.shipments where id = su.shipment_id;
      if not (public.is_admin() or public.actor_can_act(sh.origin_location_id) or public.actor_can_act(sh.destination_location_id)) then
        raise exception 'forbidden' using errcode = '42501';
      end if;
    end if;
    r := public.custody_apply('reported_lost', u.id, coalesce(p_location, u.current_location_id), u.current_shipment_id, p_idem,
      p_lat, p_lon, p_accuracy, p_loc_status, p_note, 'lost_or_damaged', u.current_location_id, null);
    if r ->> 'result' = 'accepted' and not coalesce((r ->> 'replayed')::boolean, false) then
      update public.shipment_units set status = 'missing', is_open = false where unit_id = u.id and is_open;
    end if;
    return r;
  end if;
  return jsonb_build_object('result', 'rejected', 'reason', 'invalid_input');
end $$;

create function public.close_shipment(p_shipment uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare sh public.shipments; su record; v_n int := 0;
begin
  perform public.require_actor();
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into sh from public.shipments where id = p_shipment for update;
  if not found or sh.status not in ('in_transit', 'partially_received') then
    return jsonb_build_object('result', 'rejected', 'reason', 'illegal_transition');
  end if;
  for su in select * from public.shipment_units where shipment_id = sh.id and is_open for update loop
    update public.shipment_units set status = 'missing', is_open = false where id = su.id;
    update public.product_units
       set unit_state = 'lost_or_damaged', current_shipment_id = null, state_changed_at = clock_timestamp()
     where id = su.unit_id;
    insert into public.discrepancies (kind, unit_id, shipment_id, actor_id, note)
    values ('missing_on_close', su.unit_id, sh.id, auth.uid(), left(coalesce(nullif(btrim(p_note), ''), 'Unreceived when the shipment was closed'), 500));
    v_n := v_n + 1;
  end loop;
  update public.shipments set status = 'closed', closed_at = clock_timestamp() where id = sh.id;
  return jsonb_build_object('result', 'accepted', 'missing', v_n);
end $$;

create function public.cancel_shipment(p_shipment uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare sh public.shipments;
begin
  perform public.require_actor();
  select * into sh from public.shipments where id = p_shipment for update;
  if not found or sh.status <> 'draft' then return jsonb_build_object('result', 'rejected', 'reason', 'illegal_transition'); end if;
  if not (public.is_admin() or public.actor_can_act(sh.origin_location_id)) then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.shipment_units set status = 'removed', is_open = false where shipment_id = sh.id and is_open;
  update public.shipments set status = 'cancelled', closed_at = clock_timestamp(),
    note = left(coalesce(note || ' ', '') || coalesce(nullif(btrim(p_note), ''), ''), 500)
   where id = sh.id;
  return jsonb_build_object('result', 'accepted');
end $$;

create function public.resolve_discrepancy(p_id uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.discrepancies
     set status = 'resolved', resolution = left(nullif(btrim(p_note), ''), 500), resolved_at = now(), resolved_by = auth.uid()
   where id = p_id and status = 'open';
  if not found then raise exception 'discrepancy not found' using errcode = 'P0002'; end if;
end $$;

-- ---------- reads ----------
create function public.unit_journey(p_unit uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare u public.product_units;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into u from public.product_units where id = p_unit;
  if not found then raise exception 'unit not found' using errcode = 'P0002'; end if;
  return jsonb_build_object('unit_state', u.unit_state, 'events', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'event_type', c.event_type, 'occurred_at', c.occurred_at, 'geofence_status', c.geofence_status,
      'note', c.note, 'location_name', l.name, 'location_type', l.type, 'city', l.city
    ) order by c.occurred_at)
    from public.custody_events c left join public.locations l on l.id = c.location_id
    where c.unit_id = p_unit
  ), '[]'::jsonb));
end $$;

create function public.product_custody(p_product uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(x) from (
      select jsonb_build_object(
        'id', c.id, 'event_type', c.event_type, 'occurred_at', c.occurred_at,
        'unit_label', public.unit_label(p.batch_number, pu.serial), 'unit_id', pu.id,
        'location_name', l.name, 'city', l.city, 'geofence_status', c.geofence_status
      ) as x
      from public.custody_events c
      join public.product_units pu on pu.id = c.unit_id
      join public.products p on p.id = pu.product_id
      left join public.locations l on l.id = c.location_id
      where pu.product_id = p_product
      order by c.occurred_at desc
      limit 40
    ) s
  ), '[]'::jsonb);
end $$;

create function public.admin_locations() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when public.is_admin() then coalesce(jsonb_agg(jsonb_build_object(
    'id', l.id, 'org_id', l.org_id, 'org_name', o.name, 'code', l.code, 'name', l.name, 'type', l.type,
    'address_line', l.address_line, 'city', l.city, 'state', l.state, 'country', l.country,
    'latitude', l.latitude, 'longitude', l.longitude, 'geofence_radius_m', l.geofence_radius_m, 'is_active', l.is_active
  ) order by o.name, l.name), '[]'::jsonb) else '[]'::jsonb end
  from public.locations l join public.organizations o on o.id = l.org_id;
$$;

create function public.org_locations_list(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.is_admin() or public.is_org_manager(p_org)) then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', id, 'code', code, 'name', name, 'type', type, 'city', city, 'state', state,
      'latitude', latitude, 'longitude', longitude, 'geofence_radius_m', geofence_radius_m, 'is_active', is_active
    ) order by name) from public.locations where org_id = p_org
  ), '[]'::jsonb);
end $$;

create function public.org_save_location(
  p_id uuid, p_org uuid, p_name text, p_type text, p_code text, p_address text, p_city text, p_state text,
  p_country text, p_postal text, p_lat double precision, p_lon double precision, p_radius int, p_active boolean
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_max int; v_n int; v_type public.location_type;
begin
  if not (public.is_admin() or public.is_org_manager(p_org)) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_type is null or p_type not in ('manufacturer', 'warehouse', 'distributor', 'retailer', 'other') then
    raise exception 'invalid location type' using errcode = '22023';
  end if;
  v_type := p_type::public.location_type;
  if (p_lat is null) <> (p_lon is null) then raise exception 'latitude and longitude are set together' using errcode = '22023'; end if;
  if p_id is null then
    select coalesce((limits ->> 'max_locations')::int, 20) into v_max from public.organizations where id = p_org;
    select count(*) into v_n from public.locations where org_id = p_org and is_active;
    if v_n >= coalesce(v_max, 20) then raise exception 'location limit reached' using errcode = '22023'; end if;
    insert into public.locations (org_id, code, name, type, address_line, city, state, country, postal_code,
      latitude, longitude, geofence_radius_m, is_active, created_by)
    values (p_org, nullif(btrim(p_code), ''), btrim(p_name), v_type, left(nullif(btrim(p_address), ''), 300),
      left(nullif(btrim(p_city), ''), 120), left(nullif(btrim(p_state), ''), 120), left(nullif(btrim(p_country), ''), 120),
      left(nullif(btrim(p_postal), ''), 20), p_lat, p_lon, coalesce(p_radius, 200), coalesce(p_active, true), auth.uid())
    returning id into v_id;
  else
    update public.locations set code = nullif(btrim(p_code), ''), name = btrim(p_name), type = v_type,
      address_line = left(nullif(btrim(p_address), ''), 300), city = left(nullif(btrim(p_city), ''), 120),
      state = left(nullif(btrim(p_state), ''), 120), country = left(nullif(btrim(p_country), ''), 120),
      postal_code = left(nullif(btrim(p_postal), ''), 20), latitude = p_lat, longitude = p_lon,
      geofence_radius_m = coalesce(p_radius, geofence_radius_m), is_active = coalesce(p_active, is_active)
    where id = p_id and org_id = p_org
    returning id into v_id;
    if v_id is null then raise exception 'location not found' using errcode = 'P0002'; end if;
  end if;
  return v_id;
end $$;

create function public.org_assign_location(p_location uuid, p_user uuid, p_assign boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  select org_id into v_org from public.locations where id = p_location;
  if v_org is null then raise exception 'location not found' using errcode = 'P0002'; end if;
  if not (public.is_admin() or public.is_org_manager(v_org)) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_assign then
    insert into public.location_members (location_id, user_id, added_by) values (p_location, p_user, auth.uid())
    on conflict do nothing;
  else
    delete from public.location_members where location_id = p_location and user_id = p_user;
  end if;
end $$;

create function public.location_assignees(p_location uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_org uuid;
begin
  select org_id into v_org from public.locations where id = p_location;
  if not (public.is_admin() or public.is_org_manager(v_org)) then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(user_id) from public.location_members where location_id = p_location
  ), '[]'::jsonb);
end $$;

create function public.admin_shipments(p_status text default null, p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(x) from (
      select jsonb_build_object(
        'id', sh.id, 'reference', sh.reference, 'status', sh.status, 'created_at', sh.created_at, 'dispatched_at', sh.dispatched_at,
        'origin_name', o.name, 'destination_name', d.name, 'origin_city', o.city, 'destination_city', d.city,
        'origin_id', o.id, 'destination_id', d.id,
        'expected', (select count(*) from public.shipment_units su where su.shipment_id = sh.id and su.status = 'expected'),
        'received', (select count(*) from public.shipment_units su where su.shipment_id = sh.id and su.status = 'received'),
        'overdue', sh.status in ('in_transit', 'partially_received')
          and sh.dispatched_at < now() - make_interval(days => (select shipment_overdue_days from public.app_settings))
      ) as x
      from public.shipments sh
      join public.locations o on o.id = sh.origin_location_id
      join public.locations d on d.id = sh.destination_location_id
      where p_status is null or sh.status::text = p_status
      order by sh.created_at desc
      limit least(greatest(coalesce(p_limit, 50), 1), 200)
    ) s
  ), '[]'::jsonb);
end $$;

create function public.admin_shipment_units(p_shipment uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'unit_id', pu.id, 'unit_label', public.unit_label(p.batch_number, pu.serial),
      'product_name', p.name, 'unit_state', pu.unit_state, 'line_status', su.status, 'token', pu.token
    ) order by pu.serial)
    from public.shipment_units su
    join public.product_units pu on pu.id = su.unit_id
    join public.products p on p.id = pu.product_id
    where su.shipment_id = p_shipment
  ), '[]'::jsonb);
end $$;

create function public.admin_discrepancies(p_status text default 'open', p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(x) from (
      select jsonb_build_object(
        'id', d.id, 'kind', d.kind, 'status', d.status, 'created_at', d.created_at, 'note', d.note, 'resolution', d.resolution,
        'unit_label', public.unit_label(p.batch_number, pu.serial), 'product_name', p.name,
        'location_name', l.name, 'shipment_id', d.shipment_id
      ) as x
      from public.discrepancies d
      left join public.product_units pu on pu.id = d.unit_id
      left join public.products p on p.id = pu.product_id
      left join public.locations l on l.id = d.location_id
      where p_status is null or d.status::text = p_status
      order by d.created_at desc
      limit least(greatest(coalesce(p_limit, 50), 1), 200)
    ) s
  ), '[]'::jsonb);
end $$;

create function public.admin_custody_export(p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(x) from (
      select jsonb_build_object(
        'occurred_at', c.occurred_at, 'event_type', c.event_type, 'unit_label', public.unit_label(p.batch_number, pu.serial),
        'product_name', p.name, 'location_name', l.name, 'city', l.city, 'geofence_status', c.geofence_status, 'note', c.note
      ) as x
      from public.custody_events c
      join public.product_units pu on pu.id = c.unit_id
      join public.products p on p.id = pu.product_id
      left join public.locations l on l.id = c.location_id
      where (p_from is null or c.occurred_at >= p_from) and (p_to is null or c.occurred_at < p_to)
      order by c.occurred_at desc
      limit 5000
    ) s
  ), '[]'::jsonb);
end $$;

create function public.supply_chain_metrics() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.app_settings;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into s from public.app_settings;
  return jsonb_build_object(
    'units_in_transit', (select count(*) from public.product_units where unit_state = 'in_transit'),
    'open_discrepancies', (select count(*) from public.discrepancies where status = 'open'),
    'overdue_shipments', (select count(*) from public.shipments
       where status in ('in_transit', 'partially_received')
         and dispatched_at < now() - make_interval(days => s.shipment_overdue_days)),
    'shipments_open', (select count(*) from public.shipments where status in ('draft', 'in_transit', 'partially_received')),
    'locations', (select count(*) from public.locations where is_active)
  );
end $$;

create function public.units_by_location() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'location_id', id, 'name', name, 'city', city, 'latitude', latitude, 'longitude', longitude,
      'in_stock', in_stock, 'in_transit', in_transit
    ) order by name)
    from (
      select l.id, l.name, l.city, l.latitude, l.longitude,
        count(*) filter (where pu.unit_state = 'in_stock') as in_stock,
        count(*) filter (where pu.unit_state = 'in_transit') as in_transit
      from public.locations l
      left join public.product_units pu on pu.current_location_id = l.id
      group by l.id
    ) s
  ), '[]'::jsonb);
end $$;

create function public.lane_volumes() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'origin_id', origin_id, 'origin_name', origin_name, 'origin_lat', origin_lat, 'origin_lon', origin_lon,
      'destination_id', destination_id, 'destination_name', destination_name,
      'destination_lat', destination_lat, 'destination_lon', destination_lon,
      'shipments', shipments
    ))
    from (
      select o.id as origin_id, o.name as origin_name, o.latitude as origin_lat, o.longitude as origin_lon,
        d.id as destination_id, d.name as destination_name, d.latitude as destination_lat, d.longitude as destination_lon,
        count(*) as shipments
      from public.shipments sh
      join public.locations o on o.id = sh.origin_location_id
      join public.locations d on d.id = sh.destination_location_id
      where sh.status <> 'cancelled'
      group by o.id, d.id
    ) s
  ), '[]'::jsonb);
end $$;

create function public.vendor_my_locations() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', l.id, 'name', l.name, 'type', l.type, 'city', l.city, 'org_name', o.name,
    'latitude', l.latitude, 'longitude', l.longitude, 'geofence_radius_m', l.geofence_radius_m
  ) order by l.name), '[]'::jsonb)
  from public.location_members lm
  join public.locations l on l.id = lm.location_id and l.is_active
  join public.organizations o on o.id = l.org_id and o.status = 'active'
  where lm.user_id = auth.uid() and public.is_vendor();
$$;

create function public.vendor_inbound_summary() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_vendor() then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object(
    'inbound', (select count(*) from public.shipments sh
      where sh.status in ('in_transit', 'partially_received') and public.vendor_assigned(auth.uid(), sh.destination_location_id)),
    'to_dispatch', (select count(*) from public.shipments sh
      where sh.status = 'draft' and public.vendor_assigned(auth.uid(), sh.origin_location_id))
  );
end $$;

create function public.vendor_open_shipments() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_vendor() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(x) from (
      select jsonb_build_object(
        'id', sh.id, 'reference', sh.reference, 'status', sh.status, 'dispatched_at', sh.dispatched_at,
        'origin_name', o.name, 'destination_name', d.name,
        'can_dispatch', sh.status = 'draft' and public.vendor_assigned(auth.uid(), sh.origin_location_id),
        'can_receive', sh.status in ('in_transit', 'partially_received') and public.vendor_assigned(auth.uid(), sh.destination_location_id),
        'units', (select count(*) from public.shipment_units su where su.shipment_id = sh.id and su.status <> 'removed')
      ) as x
      from public.shipments sh
      join public.locations o on o.id = sh.origin_location_id
      join public.locations d on d.id = sh.destination_location_id
      where sh.status in ('draft', 'in_transit', 'partially_received')
        and (public.vendor_assigned(auth.uid(), sh.origin_location_id) or public.vendor_assigned(auth.uid(), sh.destination_location_id))
      order by sh.created_at desc
      limit 100
    ) s
  ), '[]'::jsonb);
end $$;

-- Staff see units they scanned. Owners and managers of either end see every unit on the shipment. Tokens are never returned.
create function public.vendor_shipment_detail(p_shipment uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare sh public.shipments; v_wide boolean;
begin
  if not public.is_vendor() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into sh from public.shipments where id = p_shipment;
  if not found then raise exception 'shipment not found' using errcode = 'P0002'; end if;
  if not (public.vendor_assigned(auth.uid(), sh.origin_location_id) or public.vendor_assigned(auth.uid(), sh.destination_location_id)
          or public.is_org_manager(sh.origin_org_id) or public.is_org_manager(sh.destination_org_id)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_wide := public.is_org_manager(sh.origin_org_id) or public.is_org_manager(sh.destination_org_id);
  return jsonb_build_object(
    'id', sh.id, 'reference', sh.reference, 'status', sh.status,
    'units', coalesce((
      select jsonb_agg(jsonb_build_object(
        'unit_label', public.unit_label(p.batch_number, pu.serial), 'product_name', p.name,
        'unit_state', pu.unit_state, 'line_status', su.status
      ))
      from public.shipment_units su
      join public.product_units pu on pu.id = su.unit_id
      join public.products p on p.id = pu.product_id
      where su.shipment_id = sh.id and su.status <> 'removed'
        and (v_wide or exists (select 1 from public.scan_events e where e.unit_id = pu.id and e.scanner_id = auth.uid()))
    ), '[]'::jsonb));
end $$;

-- Public lookup: anonymous and consumer stay on the allow-list. Vendors also get server-computed actions.
drop function if exists public.public_lookup(text, text);

create function public.public_lookup(p_token text, p_ip_hash text, p_actor uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u public.product_units; p public.products; s public.app_settings;
  v_role text := 'anonymous'; v_active boolean := false; v_product jsonb; v_actions jsonb := '[]'::jsonb; v_prov jsonb;
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
  if p.status = 'archived' then return jsonb_build_object('status', 'unavailable'); end if;

  if p_actor is not null then
    select role::text, is_active into v_role, v_active from public.profiles where id = p_actor;
    if not found or not v_active then v_role := 'anonymous'; end if;
  end if;

  v_product := jsonb_build_object(
    'name', p.name, 'manufacturer', p.manufacturer, 'category', p.category,
    'description', p.description, 'batch_number', p.batch_number,
    'manufacturing_date', p.manufacturing_date, 'expiry_date', p.expiry_date,
    'is_expired', p.expiry_date is not null and p.expiry_date < public.local_today(),
    'package_type', p.package_type, 'package_description', p.package_description,
    'package_quantity', p.package_quantity, 'unit_of_measure', p.unit_of_measure,
    'unit_label', public.unit_label(p.batch_number, u.serial));
  if v_role = 'vendor' and s.vendor_sees_sku then
    v_product := v_product || jsonb_build_object('sku', p.sku);
  end if;
  if v_role = 'vendor' then
    if u.unit_state = 'in_transit' and exists (
      select 1 from public.shipment_units su
      join public.shipments sh on sh.id = su.shipment_id
      where su.unit_id = u.id and su.is_open and public.vendor_assigned(p_actor, sh.destination_location_id)
    ) then v_actions := v_actions || '["receive"]'::jsonb; end if;
    if u.unit_state = 'in_stock' and exists (
      select 1 from public.locations l
      where l.id = u.current_location_id and l.type = 'retailer' and public.vendor_assigned(p_actor, l.id)
    ) then v_actions := v_actions || '["sell"]'::jsonb; end if;
    if u.unit_state in ('in_stock', 'in_transit') and (
      public.vendor_assigned(p_actor, u.current_location_id)
      or exists (
        select 1 from public.shipment_units su
        join public.shipments sh on sh.id = su.shipment_id
        where su.unit_id = u.id and su.is_open
          and (public.vendor_assigned(p_actor, sh.origin_location_id) or public.vendor_assigned(p_actor, sh.destination_location_id))
      )
    ) then v_actions := v_actions || '["report_lost"]'::jsonb; end if;
  end if;
  if s.consumer_provenance_enabled and v_role in ('anonymous', 'consumer') then
    select coalesce(jsonb_agg(jsonb_build_object(
      'location_type', l.type, 'city', l.city, 'occurred_on', (c.occurred_at at time zone s.timezone)::date
    ) order by c.occurred_at), '[]'::jsonb) into v_prov
    from public.custody_events c
    left join public.locations l on l.id = c.location_id
    where c.unit_id = u.id;
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'status', 'ok',
    'viewer_role', v_role,
    'product', v_product,
    'scan_count', u.scan_count,
    'first_scanned_at', (select min(scanned_at) from public.scan_events where unit_id = u.id),
    'available_actions', v_actions,
    'provenance', v_prov,
    'admin_product_id', case when v_role = 'admin' then to_jsonb(p.id) else 'null'::jsonb end,
    'tracking', jsonb_build_object('allow_scan_without_gps', s.allow_scan_without_gps, 'max_accuracy_m', s.max_accuracy_m)));
end $$;

grant execute on function public.public_lookup(text, text, uuid) to service_role;

revoke all on function
  public.location_members_guard(), public.vendor_assigned(uuid, uuid), public.actor_can_act(uuid),
  public.derived_idem(uuid, uuid), public.eval_geofence(uuid, double precision, double precision, real, public.location_status),
  public.custody_apply(public.custody_event_type, uuid, uuid, uuid, uuid, double precision, double precision, real, public.location_status, text, public.unit_state, uuid, uuid),
  public.require_actor(),
  public.place_units(uuid, uuid[]), public.create_shipment(uuid, uuid, text, uuid), public.shipment_add_units(uuid, uuid[]),
  public.dispatch_shipment(uuid, uuid, double precision, double precision, real, public.location_status),
  public.record_custody_action(text, text, uuid, uuid, uuid, double precision, double precision, real, public.location_status, text),
  public.close_shipment(uuid, text), public.cancel_shipment(uuid, text), public.resolve_discrepancy(uuid, text),
  public.unit_journey(uuid), public.product_custody(uuid), public.admin_locations(), public.org_locations_list(uuid),
  public.org_save_location(uuid, uuid, text, text, text, text, text, text, text, text, double precision, double precision, int, boolean),
  public.org_assign_location(uuid, uuid, boolean), public.location_assignees(uuid),
  public.admin_shipments(text, int), public.admin_shipment_units(uuid), public.admin_discrepancies(text, int),
  public.admin_custody_export(timestamptz, timestamptz), public.supply_chain_metrics(), public.units_by_location(),
  public.lane_volumes(), public.vendor_my_locations(), public.vendor_inbound_summary(), public.vendor_open_shipments(),
  public.vendor_shipment_detail(uuid)
  from public, anon, authenticated;

grant execute on function
  public.place_units(uuid, uuid[]), public.create_shipment(uuid, uuid, text, uuid), public.shipment_add_units(uuid, uuid[]),
  public.dispatch_shipment(uuid, uuid, double precision, double precision, real, public.location_status),
  public.record_custody_action(text, text, uuid, uuid, uuid, double precision, double precision, real, public.location_status, text),
  public.close_shipment(uuid, text), public.cancel_shipment(uuid, text), public.resolve_discrepancy(uuid, text),
  public.unit_journey(uuid), public.product_custody(uuid), public.admin_locations(), public.org_locations_list(uuid),
  public.org_save_location(uuid, uuid, text, text, text, text, text, text, text, text, double precision, double precision, int, boolean),
  public.org_assign_location(uuid, uuid, boolean), public.location_assignees(uuid),
  public.admin_shipments(text, int), public.admin_shipment_units(uuid), public.admin_discrepancies(text, int),
  public.admin_custody_export(timestamptz, timestamptz), public.supply_chain_metrics(), public.units_by_location(),
  public.lane_volumes(), public.vendor_my_locations(), public.vendor_inbound_summary(), public.vendor_open_shipments(),
  public.vendor_shipment_detail(uuid)
  to authenticated;
