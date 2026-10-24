-- 0009_organizations.sql : organizations and membership. Onboarding (claim redemption, imports) is later.
-- Tenant isolation: a member reads only their own organizations. Managers read their org's members.
-- Nobody gets a direct write grant; platform-admin changes go through the RPCs below.

create type public.org_status as enum ('pending', 'active', 'suspended', 'rejected');
create type public.org_role as enum ('owner', 'manager', 'staff');
create type public.member_status as enum ('active', 'suspended', 'removed');
create type public.org_created_via as enum ('claim', 'self', 'bulk', 'admin');
create type public.claim_kind as enum ('org_owner', 'staff');

create table public.organizations (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null check (char_length(btrim(name)) between 1 and 200),
  legal_name         text check (char_length(legal_name) <= 200),
  tax_id_normalized  text check (tax_id_normalized ~ '^[A-Z0-9]{5,20}$'),
  type               text not null default 'other'
                       check (type in ('manufacturer', 'distributor', 'retailer', 'warehouse', 'other')),
  parent_org_id      uuid references public.organizations(id) on delete restrict,
  status             public.org_status not null default 'pending',
  created_via        public.org_created_via not null,
  approved_by        uuid references public.profiles(id) on delete set null,
  approved_at        timestamptz,
  contact_email      text check (char_length(contact_email) <= 200),
  contact_phone      text check (char_length(contact_phone) <= 32),
  limits             jsonb not null default '{"max_staff":50,"max_locations":20}'::jsonb,
  created_at         timestamptz not null default now(),
  constraint organizations_not_own_parent check (parent_org_id is distinct from id)
);
-- One live organization per tax id. Rejected/suspended rows do not block a later application.
create unique index organizations_tax_live_uniq on public.organizations (tax_id_normalized)
  where tax_id_normalized is not null and status in ('pending', 'active');
create index organizations_parent_idx on public.organizations (parent_org_id);
create index organizations_status_created_idx on public.organizations (status, created_at desc);
create index organizations_name_trgm on public.organizations using gin (name extensions.gin_trgm_ops);

create table public.org_members (
  org_id     uuid not null references public.organizations(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  org_role   public.org_role not null,
  status     public.member_status not null default 'active',
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index org_members_user_idx on public.org_members (user_id);

-- Claim codes are stored hashed. Redemption is Step A2; the table exists so that step does not rewrite this one.
create table public.claim_codes (
  id          uuid primary key default gen_random_uuid(),
  code_hash   text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  kind        public.claim_kind not null,
  role        public.org_role not null,
  created_by  uuid references public.profiles(id) on delete set null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  used_by     uuid references public.profiles(id) on delete set null,
  revoked_at  timestamptz,
  max_uses    integer not null default 1 check (max_uses >= 1),
  created_at  timestamptz not null default now()
);
create index claim_codes_org_idx on public.claim_codes (org_id);

create table public.org_import_jobs (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  created_by  uuid references public.profiles(id) on delete set null,
  dry_run     boolean not null default true,
  status      text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  row_count   integer not null default 0 check (row_count >= 0),
  error_count integer not null default 0 check (error_count >= 0),
  created_at  timestamptz not null default now()
);
create index org_import_jobs_org_idx on public.org_import_jobs (org_id, created_at desc);

create table public.org_import_rows (
  job_id     uuid not null references public.org_import_jobs(id) on delete cascade,
  row_number integer not null check (row_number > 0),
  error      text,
  payload    jsonb not null default '{}',
  primary key (job_id, row_number)
);

-- ---------- helpers (security definer, so policies do not recurse through RLS) ----------
create function public.my_org_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select m.org_id
  from public.org_members m
  where m.user_id = (select auth.uid()) and m.status = 'active';
$$;

create function public.org_is_active(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.organizations where id = p_org and status = 'active');
$$;

create function public.is_org_manager(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.org_members
    where org_id = p_org and user_id = (select auth.uid())
      and status = 'active' and org_role in ('owner', 'manager')
  ) and public.org_is_active(p_org);
$$;

-- ---------- RLS ----------
alter table public.organizations   enable row level security;
alter table public.org_members     enable row level security;
alter table public.claim_codes     enable row level security;
alter table public.org_import_jobs enable row level security;
alter table public.org_import_rows enable row level security;

create policy organizations_select on public.organizations for select to authenticated
  using (public.is_admin() or id in (select public.my_org_ids()));

create policy org_members_select on public.org_members for select to authenticated
  using (
    public.is_admin()
    or user_id = (select auth.uid())
    or public.is_org_manager(org_id)
  );

create policy claim_codes_select on public.claim_codes for select to authenticated
  using (public.is_admin());
create policy org_import_jobs_select on public.org_import_jobs for select to authenticated
  using (public.is_admin() or public.is_org_manager(org_id));
create policy org_import_rows_select on public.org_import_rows for select to authenticated
  using (exists (
    select 1 from public.org_import_jobs j
    where j.id = job_id and (public.is_admin() or public.is_org_manager(j.org_id))
  ));

grant select on public.organizations, public.org_members, public.claim_codes,
                 public.org_import_jobs, public.org_import_rows
  to authenticated;

revoke all on function public.my_org_ids(), public.org_is_active(uuid), public.is_org_manager(uuid)
  from public, anon, authenticated;
grant execute on function public.my_org_ids(), public.org_is_active(uuid), public.is_org_manager(uuid)
  to authenticated, service_role;

-- ---------- admin RPCs ----------
create function public.admin_search_users(p_page int, p_q text, p_role text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_q text := nullif(replace(replace(left(btrim(coalesce(p_q, '')), 80), '%', ''), '_', ''), '');
  v_size int := 25;
  v_page int := least(greatest(coalesce(p_page, 1), 1), 10000);
  v_total int; v_rows jsonb;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_role is not null and p_role <> '' and p_role not in ('admin', 'vendor', 'consumer') then
    raise exception 'invalid role' using errcode = '22023';
  end if;
  select count(*) into v_total from public.profiles p
   where (p_role is null or p_role = '' or p.role::text = p_role)
     and (v_q is null or p.full_name ilike '%' || v_q || '%' or p.id::text ilike '%' || v_q || '%');
  select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc, s.id), '[]') into v_rows from (
    select p.id, p.full_name, p.role, p.is_active, p.created_at
    from public.profiles p
    where (p_role is null or p_role = '' or p.role::text = p_role)
      and (v_q is null or p.full_name ilike '%' || v_q || '%' or p.id::text ilike '%' || v_q || '%')
    order by p.created_at desc, p.id
    limit v_size offset (v_page - 1) * v_size
  ) s;
  return jsonb_build_object('rows', v_rows, 'total', v_total, 'page', v_page, 'page_size', v_size);
end $$;

create function public.admin_set_role(p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_role not in ('admin', 'vendor', 'consumer') then
    raise exception 'invalid role' using errcode = '22023';
  end if;
  update public.profiles set role = p_role::public.app_role where id = p_user;
  if not found then raise exception 'user not found' using errcode = 'P0002'; end if;
end $$;

create function public.admin_set_active(p_user uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_active is null then raise exception 'invalid active flag' using errcode = '22023'; end if;
  update public.profiles set is_active = p_active where id = p_user;
  if not found then raise exception 'user not found' using errcode = 'P0002'; end if;
end $$;

create function public.admin_search_orgs(p_page int, p_q text, p_status text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_q text := nullif(replace(replace(left(btrim(coalesce(p_q, '')), 80), '%', ''), '_', ''), '');
  v_size int := 25;
  v_page int := least(greatest(coalesce(p_page, 1), 1), 10000);
  v_total int; v_rows jsonb;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_status is not null and p_status <> '' and p_status not in ('pending', 'active', 'suspended', 'rejected') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  select count(*) into v_total from public.organizations o
   where (p_status is null or p_status = '' or o.status::text = p_status)
     and (v_q is null or o.name ilike '%' || v_q || '%' or o.tax_id_normalized ilike '%' || v_q || '%');
  select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc, s.id), '[]') into v_rows from (
    select o.id, o.name, o.type, o.status, o.created_via, o.tax_id_normalized, o.parent_org_id,
           parent.name as parent_name, o.created_at,
           (select count(*) from public.org_members m where m.org_id = o.id and m.status = 'active') as member_count
    from public.organizations o
    left join public.organizations parent on parent.id = o.parent_org_id
    where (p_status is null or p_status = '' or o.status::text = p_status)
      and (v_q is null or o.name ilike '%' || v_q || '%' or o.tax_id_normalized ilike '%' || v_q || '%')
    order by o.created_at desc, o.id
    limit v_size offset (v_page - 1) * v_size
  ) s;
  return jsonb_build_object('rows', v_rows, 'total', v_total, 'page', v_page, 'page_size', v_size);
end $$;

create function public.admin_create_org(p_name text, p_type text, p_parent uuid, p_tax_id text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_tax text := nullif(upper(regexp_replace(coalesce(p_tax_id, ''), '[^A-Za-z0-9]', '', 'g')), '');
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_type is null or p_type not in ('manufacturer', 'distributor', 'retailer', 'warehouse', 'other') then
    raise exception 'invalid organization type' using errcode = '22023';
  end if;
  if p_parent is not null and not exists (select 1 from public.organizations where id = p_parent) then
    raise exception 'parent organization not found' using errcode = 'P0002';
  end if;
  insert into public.organizations (name, type, parent_org_id, tax_id_normalized, status, created_via, approved_by, approved_at)
  values (btrim(p_name), p_type, p_parent, v_tax, 'active', 'admin', auth.uid(), now())
  returning id into v_id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'org.created', 'organization', v_id, jsonb_build_object('name', btrim(p_name), 'via', 'admin'));
  return v_id;
end $$;

create function public.admin_set_org_status(p_org uuid, p_status text, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare v_old public.org_status;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_status not in ('active', 'suspended', 'rejected') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  select status into v_old from public.organizations where id = p_org for update;
  if not found then raise exception 'organization not found' using errcode = 'P0002'; end if;
  update public.organizations
     set status = p_status::public.org_status,
         approved_by = case when p_status = 'active' then auth.uid() else approved_by end,
         approved_at = case when p_status = 'active' then now() else approved_at end
   where id = p_org;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'org.status_changed', 'organization', p_org,
          jsonb_build_object('from', v_old, 'to', p_status, 'note', left(nullif(btrim(p_note), ''), 500)));
end $$;

-- Set-based, capped at 100 ids per call.
create function public.admin_bulk_set_org_status(p_orgs uuid[], p_status text, p_note text) returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_status not in ('active', 'suspended', 'rejected') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_orgs), 0) = 0 or cardinality(p_orgs) > 100 then
    raise exception 'bulk status accepts 1 to 100 organizations' using errcode = '22023';
  end if;
  with upd as (
    update public.organizations
       set status = p_status::public.org_status,
           approved_by = case when p_status = 'active' then auth.uid() else approved_by end,
           approved_at = case when p_status = 'active' then now() else approved_at end
     where id = any (p_orgs)
    returning id
  )
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  select auth.uid(), 'org.status_changed', 'organization', id,
         jsonb_build_object('to', p_status, 'note', left(nullif(btrim(p_note), ''), 500), 'bulk', true)
  from upd;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function
  public.admin_search_users(int, text, text),
  public.admin_set_role(uuid, text),
  public.admin_set_active(uuid, boolean),
  public.admin_search_orgs(int, text, text),
  public.admin_create_org(text, text, uuid, text),
  public.admin_set_org_status(uuid, text, text),
  public.admin_bulk_set_org_status(uuid[], text, text)
  from public, anon, authenticated;
grant execute on function
  public.admin_search_users(int, text, text),
  public.admin_set_role(uuid, text),
  public.admin_set_active(uuid, boolean),
  public.admin_search_orgs(int, text, text),
  public.admin_create_org(text, text, uuid, text),
  public.admin_set_org_status(uuid, text, text),
  public.admin_bulk_set_org_status(uuid[], text, text)
  to authenticated, service_role;
