-- Step A: roles, last-admin protection, organization tenant isolation.
-- Self-contained: begins its own transaction and rolls it back.
\set ON_ERROR_STOP on
begin;

create schema if not exists t;
create or replace function t.ok(c boolean, msg text) returns void language plpgsql as $$
begin
  if c is not true then raise exception 'FAIL: %', msg; end if;
  raise notice 'PASS: %', msg;
end $$;
create or replace function t.fails(q text, msg text) returns void language plpgsql as $$
begin
  begin execute q; exception when others then raise notice 'PASS: % [%]', msg, sqlerrm; return; end;
  raise exception 'FAIL: % (statement succeeded but should have failed)', msg;
end $$;

insert into auth.users (id, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000a1', '{"full_name":"Admin"}'),
  ('00000000-0000-0000-0000-0000000000b2', '{"full_name":"Consumer"}'),
  ('00000000-0000-0000-0000-0000000000c3', '{"full_name":"Second Admin"}'),
  ('00000000-0000-0000-0000-0000000000d4', '{"full_name":"Org A Owner"}'),
  ('00000000-0000-0000-0000-0000000000e5', '{"full_name":"Org A Staff"}'),
  ('00000000-0000-0000-0000-0000000000f6', '{"full_name":"Org B Owner"}');
update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000a1';
update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000c3';

-- 1. Defaults and migration ------------------------------------------------------------------------
do $$
declare v_id uuid := '00000000-0000-0000-0000-000000000111';
begin
  perform t.ok((select role = 'consumer' and is_active from public.profiles where id = '00000000-0000-0000-0000-0000000000b2'),
               'a new sign-up is an active consumer');
  insert into auth.users (id) values (v_id);
  perform t.ok((select role = 'consumer' from public.profiles where id = v_id), 'handle_new_user assigns consumer');
  perform t.ok(not public.is_admin() and not public.is_vendor(), 'helpers are false without a session user');
end $$;

-- 2. Self-escalation, last admin, inactive admin ---------------------------------------------------
do $$
declare n int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b2', true);
  update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000b2';
  get diagnostics n = row_count;
  perform t.ok(n = 0, 'a consumer cannot change their own role');
  update public.profiles set is_active = false where id = '00000000-0000-0000-0000-0000000000b2';
  get diagnostics n = row_count;
  perform t.ok(n = 0, 'a consumer cannot change is_active');
  perform t.fails($q$select public.admin_set_role('00000000-0000-0000-0000-0000000000b2', 'admin')$q$,
                  'a consumer cannot call admin_set_role');
  perform t.fails($q$select public.admin_search_users(1, null, null)$q$, 'a consumer cannot search users');
  perform t.ok((select count(*) from public.products) = 0, 'a consumer sees no products');
  perform t.ok(not public.is_admin() and public.is_consumer(), 'is_consumer is true and is_admin is false');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  perform public.admin_set_role('00000000-0000-0000-0000-0000000000c3', 'consumer');
  perform t.ok((select role = 'consumer' from public.profiles where id = '00000000-0000-0000-0000-0000000000c3'),
               'an admin can be demoted while another active admin remains');
  perform t.ok(exists (select 1 from public.audit_logs where action = 'profile.role_changed'
                       and entity_id = '00000000-0000-0000-0000-0000000000c3'), 'role change is audited');
  perform public.admin_set_role('00000000-0000-0000-0000-0000000000c3', 'admin');
  perform public.admin_set_active('00000000-0000-0000-0000-0000000000c3', false);
  perform t.ok(not (select is_active from public.profiles where id = '00000000-0000-0000-0000-0000000000c3'),
               'deactivating one of two admins is stored');
  perform t.fails($q$select public.admin_set_role('00000000-0000-0000-0000-0000000000a1', 'consumer')$q$,
                  'the last active admin cannot be demoted');
  perform t.fails($q$select public.admin_set_active('00000000-0000-0000-0000-0000000000a1', false)$q$,
                  'the last active admin cannot be deactivated');
  perform t.ok((select role = 'admin' and is_active from public.profiles
                where id = '00000000-0000-0000-0000-0000000000a1'), 'last admin is unchanged after rejected attempts');
  reset role;
  perform t.fails($q$update public.profiles set role = 'consumer' where id = '00000000-0000-0000-0000-0000000000a1'$q$,
                  'even the table owner cannot demote the last active admin');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
  perform t.fails($q$select public.create_product_with_units('{"name":"Nope"}', 1)$q$,
                  'a deactivated admin is no longer is_admin()');
  perform t.ok(not public.is_admin(), 'is_admin requires is_active');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  perform public.admin_set_role('00000000-0000-0000-0000-0000000000b2', 'vendor');
  reset role;
  perform t.ok((select role = 'vendor' from public.profiles where id = '00000000-0000-0000-0000-0000000000b2'),
               'admin can promote a user to vendor');
end $$;

-- 3. Vendor still has no catalogue access (attribution arrives in Step B) -------------------------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b2', true);
  perform t.ok(public.is_vendor(), 'promoted user is a vendor');
  perform t.ok((select count(*) from public.products) = 0, 'a vendor cannot read products');
  perform t.ok((select count(*) from public.product_units) = 0, 'a vendor cannot read tokens');
  perform t.fails($q$select public.dashboard_metrics()$q$, 'a vendor cannot read admin metrics');
  reset role;
end $$;

-- 4. Organizations: tenant isolation --------------------------------------------------------------
do $$
declare a uuid; b uuid; n int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  a := public.admin_create_org('Alpha Traders', 'distributor', null, '24abcde1234f1z5');
  b := public.admin_create_org('Beta Stores', 'retailer', a, null);
  perform t.ok(a is not null and b is not null, 'admin can create an organization and a child');
  perform t.ok((select parent_org_id = a and status = 'active' and created_via = 'admin' from public.organizations where id = b),
               'child organization points at its parent and is active');
  perform t.fails($q$select public.admin_create_org('Alpha Again', 'distributor', null, '24-ABCDE-1234-F1Z5')$q$,
                  'a second live organization with the same tax id is rejected');
  perform public.admin_set_org_status(b, 'rejected', 'duplicate application');
  perform t.ok((select status = 'rejected' from public.organizations where id = b), 'admin can reject an organization');
  perform t.ok(public.admin_create_org('Beta Reapplied', 'retailer', a, null) is not null,
               'rejecting one organization does not block creating another');
  reset role;
  -- A rejected row is outside the live-tax unique index, so the id can be reused.
  update public.organizations set tax_id_normalized = '24ABCDE1234F1Z5' where id = b;
  perform t.ok((select count(*) from public.organizations where tax_id_normalized = '24ABCDE1234F1Z5') = 2,
               'a rejected organization may share a tax id with an active one');
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  perform public.admin_bulk_set_org_status(array[b], 'suspended', 'bulk');
  perform t.ok((select status = 'suspended' from public.organizations where id = b), 'bulk status update applies');
  perform t.fails($q$select public.admin_bulk_set_org_status(array[]::uuid[], 'active', null)$q$,
                  'an empty bulk update is rejected');
  reset role;

  reset role;
  insert into public.org_members (org_id, user_id, org_role) values
    (a, '00000000-0000-0000-0000-0000000000d4', 'owner'),
    (a, '00000000-0000-0000-0000-0000000000e5', 'staff'),
    (b, '00000000-0000-0000-0000-0000000000f6', 'owner');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d4', true);
  perform t.ok((select count(*) from public.organizations) = 1, 'an owner sees only their own organization');
  perform t.ok((select count(*) from public.org_members) = 2, 'an owner sees their organization''s members');
  perform t.ok(public.is_org_manager(a) and not public.is_org_manager(b), 'manager helper is true only for the own active org');
  perform t.fails($q$insert into public.organizations (name, created_via) values ('Sneaky', 'admin')$q$,
                  'a member cannot insert an organization directly');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e5', true);
  perform t.ok((select count(*) from public.org_members) = 1, 'staff see only their own membership, not the whole team');
  perform t.ok(not public.is_org_manager(a), 'staff are not organization managers');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f6', true);
  perform t.ok((select count(*) from public.organizations where name = 'Alpha Traders') = 0,
               'organization B cannot see organization A');
  perform t.ok(not public.is_org_manager(b), 'a manager of a suspended organization cannot manage it');
  reset role;

  reset role;
  -- Restore B so the suspended-member path is distinct, then suspend the membership.
  update public.organizations set status = 'active' where id = b;
  update public.org_members set status = 'suspended'
   where org_id = a and user_id = '00000000-0000-0000-0000-0000000000d4';
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d4', true);
  select count(*) into n from public.organizations;
  perform t.ok(n = 0, 'a suspended member sees no organization data');
  perform t.ok(not public.is_org_manager(a), 'a suspended member is not a manager');
  reset role;
end $$;

-- 5. Anonymous is denied on every new function and table ------------------------------------------
do $$
begin
  set local role anon;
  perform t.fails('select * from public.organizations', 'anon cannot read organizations');
  perform t.fails('select * from public.org_members', 'anon cannot read memberships');
  perform t.fails('select * from public.claim_codes', 'anon cannot read claim codes');
  perform t.fails($q$select public.admin_search_users(1, null, null)$q$, 'anon cannot search users');
  perform t.fails($q$select public.admin_search_orgs(1, null, null)$q$, 'anon cannot search organizations');
  perform t.fails($q$select public.admin_set_role(gen_random_uuid(), 'admin')$q$, 'anon cannot set roles');
  perform t.fails($q$select public.admin_set_active(gen_random_uuid(), false)$q$, 'anon cannot deactivate users');
  perform t.fails($q$select public.admin_create_org('X', 'other', null, null)$q$, 'anon cannot create organizations');
  perform t.fails($q$select public.admin_set_org_status(gen_random_uuid(), 'active', null)$q$, 'anon cannot change organization status');
  perform t.fails($q$select public.admin_bulk_set_org_status(array[gen_random_uuid()], 'active', null)$q$, 'anon cannot bulk-update organizations');
  perform t.fails('select public.my_org_ids()', 'anon cannot list organization ids');
  perform t.fails($q$select public.is_org_manager(gen_random_uuid())$q$, 'anon cannot call is_org_manager');
  perform t.fails('select public.is_vendor()', 'anon cannot call is_vendor');
  perform t.fails('select public.is_consumer()', 'anon cannot call is_consumer');
  perform t.fails($q$select public.has_role('admin')$q$, 'anon cannot call has_role');
  reset role;
end $$;

rollback;
