-- 0001_schema.sql : core tables, constraints, indexes, triggers.
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create type public.app_role        as enum ('admin', 'viewer');
create type public.product_status  as enum ('active', 'archived');
create type public.unit_status     as enum ('active', 'revoked');
create type public.location_status as enum ('granted', 'denied', 'unavailable', 'timeout', 'unsupported');

-- ---------- helpers ----------
create function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

-- 128-bit CSPRNG token, base64url, always 22 chars.
create function public.generate_token() returns text
language sql volatile set search_path = public, extensions as $$
  select translate(rtrim(encode(gen_random_bytes(16), 'base64'), '='), '+/', '-_');
$$;

create function public.haversine_km(lat1 double precision, lon1 double precision,
                                    lat2 double precision, lon2 double precision)
returns double precision language sql immutable as $$
  select 2 * 6371.0088 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2)));
$$;

create function public.unit_label(batch text, serial int) returns text
language sql immutable as $$
  select coalesce(nullif(upper(batch), ''), 'NB') || '-' || lpad(serial::text, 5, '0');
$$;

-- ---------- profiles ----------
create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  full_name  text check (char_length(full_name) <= 120),
  role       public.app_role not null default 'viewer',
  created_at timestamptz not null default now()
);

-- New sign-ups are always 'viewer'. Promote admins manually (see README).
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name')
  on conflict do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- ---------- settings (single row, configurable rules) ----------
create table public.app_settings (
  id                       boolean primary key default true check (id),
  timezone                 text    not null default 'Asia/Kolkata',
  allow_scan_without_gps   boolean not null default true,
  max_accuracy_m           integer not null default 500  check (max_accuracy_m > 0),
  min_rescan_seconds       integer not null default 60   check (min_rescan_seconds >= 0),
  frequency_window_seconds integer not null default 3600 check (frequency_window_seconds > 0),
  frequency_max_scans      integer not null default 10   check (frequency_max_scans > 0),
  max_speed_kmh            integer not null default 900  check (max_speed_kmh > 0),
  location_retention_days  integer not null default 365  check (location_retention_days > 0),
  expiring_soon_days       integer not null default 30   check (expiring_soon_days >= 0),
  updated_at               timestamptz not null default now()
);
insert into public.app_settings default values;
create trigger app_settings_touch before update on public.app_settings
  for each row execute function public.touch_updated_at();

create function public.local_today() returns date language sql stable as $$
  select (now() at time zone timezone)::date from public.app_settings;
$$;

-- ---------- products ----------
create table public.products (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null check (char_length(btrim(name)) between 1 and 200),
  sku                 text check (char_length(sku) between 1 and 64),
  description         text check (char_length(description) <= 2000),
  category            text check (char_length(category) <= 100),
  batch_number        text check (char_length(batch_number) <= 64),
  manufacturing_date  date,
  expiry_date         date,
  unit_price          numeric(12,2) check (unit_price >= 0),
  currency            char(3) not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  package_quantity    integer check (package_quantity > 0),
  unit_of_measure     text check (char_length(unit_of_measure) <= 32),
  package_type        text check (char_length(package_type) <= 100),
  package_description text check (char_length(package_description) <= 1000),
  image_path          text,
  manufacturer        text check (char_length(manufacturer) <= 200),
  status              public.product_status not null default 'active',
  created_by          uuid references public.profiles(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint products_dates_ok check (expiry_date is null or manufacturing_date is null
                                      or expiry_date >= manufacturing_date)
);
-- Duplicate SKUs are allowed across different batches; the same SKU+batch cannot be registered twice.
create unique index products_sku_batch_uniq
  on public.products (lower(sku), coalesce(lower(batch_number), '')) where sku is not null;
create index products_status_idx  on public.products (status);
create index products_expiry_idx  on public.products (expiry_date) where expiry_date is not null;
create index products_created_idx on public.products (created_at desc);
create index products_batch_idx   on public.products (lower(batch_number));
create index products_name_trgm   on public.products using gin (name extensions.gin_trgm_ops);
create index products_sku_trgm    on public.products using gin (sku extensions.gin_trgm_ops);

create function public.products_guard() returns trigger language plpgsql as $$
begin
  -- Immutable columns: protects against mass-assignment from clients.
  new.id := old.id; new.created_by := old.created_by; new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end $$;
create trigger products_guard before update on public.products
  for each row execute function public.products_guard();

-- ---------- product_units (one row per physical unit) ----------
-- Phase 1 trade-off: the unit row IS the QR identity (token lives here). A separate
-- token table would add joins without benefit; rotation history goes to revoked_tokens.
create table public.product_units (
  id             uuid primary key default gen_random_uuid(),
  product_id     uuid not null references public.products(id) on delete restrict,
  serial         integer not null check (serial > 0),
  token          text not null unique check (token ~ '^[A-Za-z0-9_-]{22}$'),
  status         public.unit_status not null default 'active',
  revoked_at     timestamptz,
  revoked_reason text check (char_length(revoked_reason) <= 500),
  scan_count     integer not null default 0,
  last_scan_at   timestamptz,
  last_scan_id   uuid,
  created_at     timestamptz not null default now(),
  unique (product_id, serial)
);
create index product_units_product_scan_idx on public.product_units (product_id, last_scan_at desc);

create table public.revoked_tokens (
  token      text primary key,
  unit_id    uuid not null references public.product_units(id) on delete cascade,
  reason     text,
  revoked_at timestamptz not null default now()
);
create index revoked_tokens_unit_idx on public.revoked_tokens (unit_id);

-- ---------- scan_events (append-only) ----------
create table public.scan_events (
  id                   uuid primary key default gen_random_uuid(),
  unit_id              uuid not null references public.product_units(id) on delete restrict,
  idempotency_key      uuid not null,
  scanned_at           timestamptz not null default now(),   -- server time, authoritative
  latitude             numeric(9,6) check (latitude  between -90  and 90),
  longitude            numeric(9,6) check (longitude between -180 and 180),
  accuracy_m           real check (accuracy_m >= 0),
  location_status      public.location_status not null,
  location_captured_at timestamptz,                          -- client-reported, informational only
  location_purged_at   timestamptz,
  source               text not null default 'public_web',
  scanner_id           uuid references public.profiles(id) on delete set null,
  vendor_reference     text check (char_length(vendor_reference) <= 100),
  ip_hash              text,
  user_agent           text,
  flags                text[] not null default '{}',
  unique (unit_id, idempotency_key),
  constraint scan_coords_pair check ((latitude is null) = (longitude is null)),
  constraint scan_coords_need_grant check (location_status = 'granted' or latitude is null)
);
create index scan_events_unit_time_idx on public.scan_events (unit_id, scanned_at desc);
create index scan_events_time_idx      on public.scan_events (scanned_at desc);
create index scan_events_flags_idx     on public.scan_events using gin (flags) where cardinality(flags) > 0;

alter table public.product_units
  add constraint product_units_last_scan_fk foreign key (last_scan_id)
  references public.scan_events(id) on delete set null;

create function public.scan_events_immutable() returns trigger language plpgsql as $$
begin
  if current_setting('app.scan_maintenance', true) = 'on' and tg_op = 'UPDATE' then
    return new;  -- only purge_old_locations() sets this
  end if;
  raise exception 'scan_events is append-only' using errcode = '42501';
end $$;
create trigger scan_events_immutable before update or delete on public.scan_events
  for each row execute function public.scan_events_immutable();

-- Rejected / invalid token attempts. Only a fingerprint of the token is kept, never the token.
create table public.rejected_attempts (
  id                bigint generated always as identity primary key,
  token_fingerprint text not null,
  unit_id           uuid references public.product_units(id) on delete set null,
  reason            text not null,
  ip_hash           text,
  created_at        timestamptz not null default now()
);
create index rejected_attempts_time_idx on public.rejected_attempts (created_at desc);

create table public.rate_limits (
  key          text not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (key, window_start)
);

create table public.audit_logs (
  id          bigint generated always as identity primary key,
  actor_id    uuid,
  action      text not null,
  entity_type text not null,
  entity_id   uuid,
  details     jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index audit_logs_time_idx   on public.audit_logs (created_at desc);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);

-- Audit trigger for products (field-level diff, no full row copies).
create function public.audit_products() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_action text; v_details jsonb;
begin
  if tg_op = 'INSERT' then
    v_action := 'product.created';
    v_details := jsonb_build_object('name', new.name, 'batch', new.batch_number);
  else
    v_action := case when old.status <> 'archived' and new.status = 'archived'
                     then 'product.archived' else 'product.updated' end;
    select coalesce(jsonb_object_agg(n.key, n.value), '{}') into v_details
    from jsonb_each(to_jsonb(new)) n
    where n.key <> 'updated_at' and to_jsonb(old) -> n.key is distinct from n.value;
  end if;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), v_action, 'product', new.id, v_details);
  return new;
end $$;
create trigger products_audit after insert or update on public.products
  for each row execute function public.audit_products();
