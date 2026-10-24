-- 0008_roles_users.sql : consumer is the default role. Role and active-flag changes are guarded.

alter table public.profiles
  add column is_active boolean not null default true;

alter table public.profiles
  alter column role set default 'consumer';

-- Existing non-admins were 'viewer'. That value remains in the enum but is no longer assigned.
update public.profiles set role = 'consumer' where role = 'viewer';

create index profiles_role_idx on public.profiles (role);
create index profiles_name_trgm on public.profiles using gin (full_name extensions.gin_trgm_ops);

-- New sign-ups are always 'consumer'. Platform role changes go through admin RPCs (or the SQL editor as owner).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, left(new.raw_user_meta_data ->> 'full_name', 120))
  on conflict do nothing;
  return new;
end $$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role = 'admin' and is_active
  );
$$;

create function public.has_role(p_role text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role::text = p_role and is_active
  );
$$;

create function public.is_vendor() returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_role('vendor');
$$;

create function public.is_consumer() returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_role('consumer');
$$;

-- Direct updates (the client has UPDATE on profiles). SECURITY INVOKER so current_user is the
-- caller: a security-definer trigger would run as the table owner and could not tell them apart.
-- The last-active-admin rule applies to everyone, including the table owner.
create function public.profiles_guard() returns trigger
language plpgsql set search_path = public as $$
declare v_admins int;
begin
  if new.role is not distinct from old.role and new.is_active is not distinct from old.is_active then
    return new;
  end if;

  if coalesce(current_setting('is_superuser', true), 'off') <> 'on'
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
    case
      when old.role is distinct from new.role then 'profile.role_changed'
      else 'profile.active_changed'
    end,
    'profile', new.id,
    jsonb_build_object('from_role', old.role, 'to_role', new.role, 'from_active', old.is_active, 'to_active', new.is_active)
  );
  return new;
end $$;

create trigger profiles_guard before update on public.profiles
  for each row execute function public.profiles_guard();

-- Admins may insert the audit row the trigger writes. The check stops other roles forging entries.
grant insert on public.audit_logs to authenticated;
grant usage, select on sequence public.audit_logs_id_seq to authenticated;
create policy audit_insert_admin on public.audit_logs for insert to authenticated
  with check (public.is_admin() and actor_id is not distinct from (select auth.uid()));

revoke all on function public.has_role(text), public.is_vendor(), public.is_consumer()
  from public, anon, authenticated;
grant execute on function public.has_role(text), public.is_vendor(), public.is_consumer()
  to authenticated, service_role;
