-- 0010_onboarding.sql : claim links, self-registration, staff invites, join codes, bulk import.
-- Claim codes stay hashed. The plaintext is returned once by the issuing function and is not stored.
-- Direct writes stay closed. Callers are checked inside each function.

alter table public.app_settings
  add column self_registration_mode text not null default 'review'
    check (self_registration_mode in ('off', 'review', 'auto')),
  add column claim_expiry_days integer not null default 14 check (claim_expiry_days between 1 and 90),
  add column import_max_rows integer not null default 5000 check (import_max_rows between 1 and 5000),
  add column geofence_mode text not null default 'flag' check (geofence_mode in ('flag', 'block')),
  add column require_gps_for_custody boolean not null default false,
  add column shipment_overdue_days integer not null default 7 check (shipment_overdue_days between 1 and 365),
  add column consumer_provenance_enabled boolean not null default false,
  add column vendor_sees_sku boolean not null default false;

alter table public.organizations
  add column city text check (city is null or char_length(city) <= 120),
  add column address_line text check (address_line is null or char_length(address_line) <= 300);

alter table public.claim_codes
  add column use_count integer not null default 0 check (use_count >= 0);

create table public.claim_redemptions (
  code_id     uuid not null references public.claim_codes(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  redeemed_at timestamptz not null default now(),
  primary key (code_id, user_id)
);

alter table public.claim_redemptions enable row level security;
create policy claim_redemptions_select on public.claim_redemptions for select to authenticated
  using (public.is_admin());
grant select on public.claim_redemptions to authenticated;

-- Lets a security-definer onboarding function set a consumer to vendor.
-- The flag is set only for the update, then cleared. PostgREST runs each call in its own transaction.
create or replace function public.profiles_guard() returns trigger
language plpgsql set search_path = public as $$
declare v_admins int;
begin
  if new.role is not distinct from old.role and new.is_active is not distinct from old.is_active then
    return new;
  end if;

  if current_setting('app.profile_maintenance', true) is distinct from 'on'
     and coalesce(current_setting('is_superuser', true), 'off') <> 'on'
     and current_user not in ('service_role', 'supabase_admin')
     and not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if old.role = 'admin' and old.is_active and (new.role <> 'admin' or not new.is_active) then
    select count(*) into v_admins
    from public.profiles
    where role = 'admin' and is_active and id <> old.id;
    if v_admins = 0 then
      raise exception 'last active admin cannot be demoted or deactivated' using errcode = '42501';
    end if;
  end if;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (
    auth.uid(),
    case when old.role is distinct from new.role then 'profile.role_changed' else 'profile.active_changed' end,
    'profile', new.id,
    jsonb_build_object('from_role', old.role, 'to_role', new.role, 'from_active', old.is_active, 'to_active', new.is_active)
  );
  return new;
end $$;

create function public.promote_org_owners(p_org uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.profile_maintenance', 'on', true);
  update public.profiles p
     set role = 'vendor'
    from public.org_members m
   where m.org_id = p_org and m.user_id = p.id and m.org_role = 'owner' and m.status = 'active'
     and p.role = 'consumer' and p.is_active;
  perform set_config('app.profile_maintenance', 'off', true);
end $$;

create or replace function public.admin_set_org_status(p_org uuid, p_status text, p_note text) returns void
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
  if p_status = 'active' then perform public.promote_org_owners(p_org); end if;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'org.status_changed', 'organization', p_org,
          jsonb_build_object('from', v_old, 'to', p_status, 'note', left(nullif(btrim(p_note), ''), 500)));
end $$;

create or replace function public.admin_bulk_set_org_status(p_orgs uuid[], p_status text, p_note text) returns int
language plpgsql security definer set search_path = public as $$
declare v_n int; v_id uuid;
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
  if p_status = 'active' then
    foreach v_id in array p_orgs loop
      perform public.promote_org_owners(v_id);
    end loop;
  end if;
  return v_n;
end $$;

create function public.issue_claim(
  p_org uuid, p_kind public.claim_kind, p_role public.org_role, p_max_uses int, p_by uuid
) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v_code text; v_days int;
begin
  if p_max_uses is null or p_max_uses not between 1 and 500 then
    raise exception 'invalid max uses' using errcode = '22023';
  end if;
  if not exists (select 1 from public.organizations where id = p_org and status in ('pending', 'active')) then
    raise exception 'organization not found' using errcode = 'P0002';
  end if;
  select claim_expiry_days into v_days from public.app_settings;
  v_code := public.generate_token();
  insert into public.claim_codes (code_hash, org_id, kind, role, created_by, expires_at, max_uses)
  values (encode(digest(v_code, 'sha256'), 'hex'), p_org, p_kind, p_role, p_by, now() + make_interval(days => v_days), p_max_uses);
  return v_code;
end $$;

create function public.normalize_tax(p_tax text) returns text
language sql immutable as $$
  select nullif(upper(regexp_replace(coalesce(p_tax, ''), '[^A-Za-z0-9]', '', 'g')), '');
$$;

-- Anonymous preview. Same answer for missing, expired, revoked, and used codes.
create function public.preview_claim(p_code text, p_ip_hash text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c public.claim_codes; o public.organizations;
begin
  if not public.check_rate_limit('claim-preview:' || coalesce(nullif(p_ip_hash, ''), 'unknown'), 10, 60) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  select * into c from public.claim_codes
   where code_hash = encode(digest(coalesce(p_code, ''), 'sha256'), 'hex');
  if not found or c.revoked_at is not null or c.expires_at <= now() or c.use_count >= c.max_uses then
    return jsonb_build_object('ok', false);
  end if;
  select * into o from public.organizations where id = c.org_id and status in ('pending', 'active');
  if not found then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'org_name', o.name, 'kind', c.kind);
end $$;

create function public.redeem_claim(p_code text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  c public.claim_codes;
  o public.organizations;
begin
  if v_uid is null or not exists (select 1 from public.profiles where id = v_uid and is_active) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not public.check_rate_limit('claim:' || v_uid::text, 10, 60) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  select * into c from public.claim_codes
   where code_hash = encode(digest(coalesce(p_code, ''), 'sha256'), 'hex')
   for update;
  if not found or c.revoked_at is not null or c.expires_at <= now() or c.use_count >= c.max_uses then
    return jsonb_build_object('ok', false, 'error', 'claim_invalid');
  end if;
  if exists (select 1 from public.claim_redemptions where code_id = c.id and user_id = v_uid) then
    return jsonb_build_object('ok', false, 'error', 'claim_invalid');
  end if;
  select * into o from public.organizations where id = c.org_id for update;
  if not found or o.status not in ('pending', 'active') then
    return jsonb_build_object('ok', false, 'error', 'claim_invalid');
  end if;

  insert into public.claim_redemptions (code_id, user_id) values (c.id, v_uid);
  update public.claim_codes
     set use_count = use_count + 1,
         used_at = coalesce(used_at, now()),
         used_by = coalesce(used_by, v_uid)
   where id = c.id;
  insert into public.org_members (org_id, user_id, org_role, status)
  values (c.org_id, v_uid, c.role, 'active')
  on conflict (org_id, user_id) do update set org_role = excluded.org_role, status = 'active';

  if c.kind = 'org_owner' and o.status = 'pending' then
    update public.organizations
       set status = 'active', approved_at = now()
     where id = o.id;
  end if;
  perform public.promote_org_owners(c.org_id);
  -- Staff and managers who join also need the vendor role. Owners are covered above.
  perform set_config('app.profile_maintenance', 'on', true);
  update public.profiles set role = 'vendor' where id = v_uid and role = 'consumer' and is_active;
  perform set_config('app.profile_maintenance', 'off', true);

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (v_uid, 'claim.redeemed', 'organization', c.org_id, jsonb_build_object('kind', c.kind, 'role', c.role));
  return jsonb_build_object('ok', true, 'org_id', c.org_id, 'org_name', o.name, 'role', c.role);
end $$;

-- Called by the onboarding Edge Function with the service role, after it has created the auth user.
create function public.start_vendor_application(p_user uuid, p_name text, p_tax text, p_phone text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s public.app_settings; v_tax text; v_id uuid; v_name text := btrim(coalesce(p_name, ''));
begin
  select * into s from public.app_settings;
  if s.self_registration_mode = 'off' then
    return jsonb_build_object('ok', false, 'error', 'registration_closed');
  end if;
  if p_user is null or not exists (select 1 from public.profiles where id = p_user and is_active and role = 'consumer') then
    return jsonb_build_object('ok', false, 'error', 'unavailable');
  end if;
  if char_length(v_name) not between 1 and 200 then
    return jsonb_build_object('ok', false, 'error', 'invalid_input');
  end if;
  if exists (
    select 1 from public.org_members m
    join public.organizations o on o.id = m.org_id
    where m.user_id = p_user and m.org_role = 'owner' and o.status in ('pending', 'active')
  ) then
    return jsonb_build_object('ok', false, 'error', 'unavailable');
  end if;
  v_tax := public.normalize_tax(p_tax);
  if v_tax is not null and v_tax !~ '^[A-Z0-9]{5,20}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_input');
  end if;
  begin
    insert into public.organizations (name, tax_id_normalized, type, status, created_via, contact_phone, approved_at)
    values (v_name, v_tax, 'other',
            case when s.self_registration_mode = 'auto' then 'active'::public.org_status else 'pending'::public.org_status end,
            'self', left(nullif(btrim(p_phone), ''), 32),
            case when s.self_registration_mode = 'auto' then now() else null end)
    returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'unavailable');
  end;
  insert into public.org_members (org_id, user_id, org_role) values (v_id, p_user, 'owner');
  if s.self_registration_mode = 'auto' then
    perform public.promote_org_owners(v_id);
  end if;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (p_user, 'org.applied', 'organization', v_id, jsonb_build_object('mode', s.self_registration_mode));
  return jsonb_build_object('ok', true, 'org_id', v_id,
    'status', case when s.self_registration_mode = 'auto' then 'active' else 'pending' end);
end $$;

create function public.my_application_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); r jsonb;
begin
  if v_uid is null then raise exception 'forbidden' using errcode = '42501'; end if;
  select jsonb_build_object('org_id', o.id, 'name', o.name, 'status', o.status, 'created_via', o.created_via)
    into r
  from public.org_members m
  join public.organizations o on o.id = m.org_id
  where m.user_id = v_uid and m.org_role = 'owner'
  order by o.created_at desc
  limit 1;
  return coalesce(r, jsonb_build_object('status', 'none'));
end $$;

create function public.org_create_downstream(
  p_parent uuid, p_name text, p_type text, p_email text, p_phone text, p_city text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_code text; v_name text := btrim(coalesce(p_name, ''));
begin
  if not (public.is_admin() or public.is_org_manager(p_parent)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_type is null or p_type not in ('manufacturer', 'distributor', 'retailer', 'warehouse', 'other') then
    raise exception 'invalid organization type' using errcode = '22023';
  end if;
  if char_length(v_name) not between 1 and 200 then
    raise exception 'invalid name' using errcode = '22023';
  end if;
  if not exists (select 1 from public.organizations where id = p_parent and status = 'active') then
    raise exception 'parent organization not found' using errcode = 'P0002';
  end if;
  insert into public.organizations (name, type, parent_org_id, status, created_via, contact_email, contact_phone, city)
  values (v_name, p_type, p_parent, 'pending', 'claim',
          left(nullif(btrim(p_email), ''), 200), left(nullif(btrim(p_phone), ''), 32), left(nullif(btrim(p_city), ''), 120))
  returning id into v_id;
  v_code := public.issue_claim(v_id, 'org_owner', 'owner', 1, auth.uid());
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'org.downstream_created', 'organization', v_id, jsonb_build_object('parent', p_parent));
  return jsonb_build_object('org_id', v_id, 'code', v_code);
end $$;

create function public.org_invite_staff(p_org uuid, p_role text) returns text
language plpgsql security definer set search_path = public as $$
declare v_code text; v_max int; v_n int;
begin
  if not (public.is_admin() or public.is_org_manager(p_org)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_role not in ('manager', 'staff') then
    raise exception 'invalid role' using errcode = '22023';
  end if;
  select coalesce((limits ->> 'max_staff')::int, 50) into v_max from public.organizations where id = p_org;
  select count(*) into v_n from public.org_members where org_id = p_org and status = 'active';
  if v_n >= v_max then raise exception 'staff limit reached' using errcode = '22023'; end if;
  v_code := public.issue_claim(p_org, 'staff', p_role::public.org_role, 1, auth.uid());
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'claim.issued', 'organization', p_org, jsonb_build_object('kind', 'staff', 'role', p_role));
  return v_code;
end $$;

create function public.org_create_join_code(p_org uuid, p_max_uses int) returns text
language plpgsql security definer set search_path = public as $$
declare v_code text;
begin
  if not (public.is_admin() or public.is_org_manager(p_org)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_code := public.issue_claim(p_org, 'staff', 'staff', p_max_uses, auth.uid());
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'claim.issued', 'organization', p_org, jsonb_build_object('kind', 'join', 'max_uses', p_max_uses));
  return v_code;
end $$;

create function public.org_revoke_claim(p_claim uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  select org_id into v_org from public.claim_codes where id = p_claim;
  if v_org is null then raise exception 'claim not found' using errcode = 'P0002'; end if;
  if not (public.is_admin() or public.is_org_manager(v_org) or public.is_org_manager((select parent_org_id from public.organizations where id = v_org))) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.claim_codes set revoked_at = now() where id = p_claim and revoked_at is null;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'claim.revoked', 'organization', v_org, jsonb_build_object('claim_id', p_claim));
end $$;

create function public.org_set_member_status(p_org uuid, p_user uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare v_role public.org_role; v_owners int;
begin
  if not (public.is_admin() or public.is_org_manager(p_org)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_status not in ('active', 'suspended', 'removed') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  select org_role into v_role from public.org_members where org_id = p_org and user_id = p_user;
  if not found then raise exception 'member not found' using errcode = 'P0002'; end if;
  if v_role = 'owner' and p_status <> 'active' then
    select count(*) into v_owners from public.org_members
     where org_id = p_org and org_role = 'owner' and status = 'active' and user_id <> p_user;
    if v_owners = 0 then
      raise exception 'last owner cannot be removed' using errcode = '42501';
    end if;
  end if;
  update public.org_members set status = p_status::public.member_status where org_id = p_org and user_id = p_user;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'org.member_status', 'organization', p_org,
          jsonb_build_object('user_id', p_user, 'status', p_status));
end $$;

create function public.org_bulk_import(p_org uuid, p_rows jsonb, p_dry_run boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s public.app_settings; v_job uuid; v_i int := 0; v_err int := 0; v_len int;
  v_row jsonb; v_name text; v_email text; v_tax text; v_type text; v_city text; v_phone text; v_addr text;
  v_existing uuid; v_child uuid; v_code text; v_rows jsonb := '[]'::jsonb; v_codes jsonb := '[]'::jsonb;
  v_msg text;
begin
  if not (public.is_admin() or public.is_org_manager(p_org)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.organizations where id = p_org and status = 'active') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into s from public.app_settings;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'rows must be an array' using errcode = '22023';
  end if;
  v_len := jsonb_array_length(p_rows);
  if v_len < 1 or v_len > s.import_max_rows then
    raise exception 'row count must be between 1 and the import limit' using errcode = '22023';
  end if;

  insert into public.org_import_jobs (org_id, created_by, dry_run, status, row_count)
  values (p_org, auth.uid(), coalesce(p_dry_run, true), 'pending', v_len)
  returning id into v_job;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_i := v_i + 1;
    v_msg := null; v_code := null; v_child := null;
    v_name := btrim(coalesce(v_row ->> 'name', ''));
    v_email := nullif(btrim(coalesce(v_row ->> 'email', '')), '');
    v_phone := left(nullif(btrim(coalesce(v_row ->> 'phone', '')), ''), 32);
    v_city := left(nullif(btrim(coalesce(v_row ->> 'city', '')), ''), 120);
    v_addr := left(nullif(btrim(coalesce(v_row ->> 'address', '')), ''), 300);
    v_type := coalesce(nullif(btrim(coalesce(v_row ->> 'type', '')), ''), 'other');
    v_tax := public.normalize_tax(v_row ->> 'tax_id');
    if char_length(v_name) not between 1 and 200 then v_msg := 'invalid_name';
    elsif v_email is not null and v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then v_msg := 'invalid_email';
    elsif v_type not in ('manufacturer', 'distributor', 'retailer', 'warehouse', 'other') then v_msg := 'invalid_type';
    elsif v_tax is not null and v_tax !~ '^[A-Z0-9]{5,20}$' then v_msg := 'invalid_tax';
    end if;
    if v_msg is null then
      select id into v_existing from public.organizations
       where parent_org_id = p_org and lower(name) = lower(v_name) and status in ('pending', 'active')
       limit 1;
      if v_existing is not null then
        v_rows := v_rows || jsonb_build_array(jsonb_build_object('row', v_i, 'ok', true, 'existing', true, 'name', v_name));
      elsif coalesce(p_dry_run, true) then
        v_rows := v_rows || jsonb_build_array(jsonb_build_object('row', v_i, 'ok', true, 'name', v_name));
      else
        begin
          insert into public.organizations (name, type, parent_org_id, status, created_via, contact_email, contact_phone, city, address_line, tax_id_normalized)
          values (v_name, v_type, p_org, 'pending', 'bulk', v_email, v_phone, v_city, v_addr, v_tax)
          returning id into v_child;
          v_code := public.issue_claim(v_child, 'org_owner', 'owner', 1, auth.uid());
          v_codes := v_codes || jsonb_build_array(jsonb_build_object('row', v_i, 'name', v_name, 'email', v_email, 'code', v_code));
          v_rows := v_rows || jsonb_build_array(jsonb_build_object('row', v_i, 'ok', true, 'name', v_name, 'org_id', v_child));
        exception when unique_violation then
          v_msg := 'unavailable';
        end;
      end if;
    end if;
    if v_msg is not null then
      v_err := v_err + 1;
      v_rows := v_rows || jsonb_build_array(jsonb_build_object('row', v_i, 'ok', false, 'error', v_msg));
      insert into public.org_import_rows (job_id, row_number, error, payload)
      values (v_job, v_i, v_msg, jsonb_build_object('name', v_name));
    end if;
  end loop;

  update public.org_import_jobs set status = 'completed', error_count = v_err where id = v_job;
  return jsonb_build_object('job_id', v_job, 'dry_run', coalesce(p_dry_run, true),
    'row_count', v_len, 'error_count', v_err, 'rows', v_rows, 'codes', v_codes);
end $$;

create function public.org_members_list(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.is_admin() or public.is_org_manager(p_org) or exists (
    select 1 from public.org_members where org_id = p_org and user_id = auth.uid() and status = 'active'
  )) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'user_id', m.user_id, 'full_name', p.full_name, 'org_role', m.org_role, 'status', m.status, 'created_at', m.created_at
    ) order by m.created_at)
    from public.org_members m
    join public.profiles p on p.id = m.user_id
    where m.org_id = p_org
      and (public.is_admin() or public.is_org_manager(p_org) or m.user_id = auth.uid())
  ), '[]'::jsonb);
end $$;

create function public.org_downstream_list(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.is_admin() or public.is_org_manager(p_org)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', id, 'name', name, 'type', type, 'status', status, 'city', city, 'created_via', created_via, 'created_at', created_at
    ) order by created_at desc)
    from public.organizations where parent_org_id = p_org
  ), '[]'::jsonb);
end $$;

create function public.org_claims_list(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.is_admin() or public.is_org_manager(p_org)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', id, 'kind', kind, 'role', role, 'expires_at', expires_at, 'use_count', use_count,
      'max_uses', max_uses, 'revoked', revoked_at is not null, 'created_at', created_at
    ) order by created_at desc)
    from public.claim_codes where org_id = p_org
  ), '[]'::jsonb);
end $$;

create function public.org_overview(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o public.organizations; v_members int; v_children int;
begin
  if not (public.is_admin() or exists (
    select 1 from public.org_members where org_id = p_org and user_id = auth.uid() and status = 'active'
  )) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into o from public.organizations where id = p_org;
  if not found then raise exception 'organization not found' using errcode = 'P0002'; end if;
  select count(*) into v_members from public.org_members where org_id = p_org and status = 'active';
  select count(*) into v_children from public.organizations where parent_org_id = p_org;
  return jsonb_build_object(
    'id', o.id, 'name', o.name, 'type', o.type, 'status', o.status, 'city', o.city,
    'is_manager', public.is_admin() or public.is_org_manager(p_org),
    'members', v_members, 'downstream', v_children);
end $$;

create function public.my_orgs() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', o.id, 'name', o.name, 'status', o.status, 'org_role', m.org_role
  ) order by o.name), '[]'::jsonb)
  from public.org_members m
  join public.organizations o on o.id = m.org_id
  where m.user_id = auth.uid() and m.status = 'active';
$$;

revoke all on function
  public.promote_org_owners(uuid), public.issue_claim(uuid, public.claim_kind, public.org_role, int, uuid),
  public.normalize_tax(text), public.preview_claim(text, text), public.redeem_claim(text),
  public.start_vendor_application(uuid, text, text, text), public.my_application_status(),
  public.org_create_downstream(uuid, text, text, text, text, text), public.org_invite_staff(uuid, text),
  public.org_create_join_code(uuid, int), public.org_revoke_claim(uuid),
  public.org_set_member_status(uuid, uuid, text), public.org_bulk_import(uuid, jsonb, boolean),
  public.org_members_list(uuid), public.org_downstream_list(uuid), public.org_claims_list(uuid),
  public.org_overview(uuid), public.my_orgs()
  from public, anon, authenticated;

grant execute on function public.redeem_claim(text), public.my_application_status(), public.my_orgs(),
  public.org_create_downstream(uuid, text, text, text, text, text), public.org_invite_staff(uuid, text),
  public.org_create_join_code(uuid, int), public.org_revoke_claim(uuid),
  public.org_set_member_status(uuid, uuid, text), public.org_bulk_import(uuid, jsonb, boolean),
  public.org_members_list(uuid), public.org_downstream_list(uuid), public.org_claims_list(uuid),
  public.org_overview(uuid)
  to authenticated;

grant execute on function public.preview_claim(text, text), public.start_vendor_application(uuid, text, text, text),
  public.redeem_claim(text)
  to service_role;
