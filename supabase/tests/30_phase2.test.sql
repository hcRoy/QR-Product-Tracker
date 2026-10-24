-- Steps A2–D: onboarding, vendor isolation, custody state machine.
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
  ('10000000-0000-0000-0000-0000000000a1', '{"full_name":"Admin"}'),
  ('10000000-0000-0000-0000-0000000000b1', '{"full_name":"Applicant"}'),
  ('10000000-0000-0000-0000-0000000000c1', '{"full_name":"Vendor A"}'),
  ('10000000-0000-0000-0000-0000000000c2', '{"full_name":"Staff A"}'),
  ('10000000-0000-0000-0000-0000000000d1', '{"full_name":"Vendor B"}'),
  ('10000000-0000-0000-0000-0000000000e1', '{"full_name":"Claimer"}'),
  ('10000000-0000-0000-0000-0000000000e2', '{"full_name":"Joiner"}');
update public.profiles set role = 'admin' where id = '10000000-0000-0000-0000-0000000000a1';
update public.profiles set role = 'vendor' where id in (
  '10000000-0000-0000-0000-0000000000c1',
  '10000000-0000-0000-0000-0000000000c2',
  '10000000-0000-0000-0000-0000000000d1');

-- 1. Anonymous is denied -------------------------------------------------------------------
do $$
begin
  set local role anon;
  perform t.fails('select * from public.locations', 'anon cannot read locations');
  perform t.fails('select * from public.shipments', 'anon cannot read shipments');
  perform t.fails('select * from public.custody_events', 'anon cannot read custody');
  perform t.fails('select * from public.claim_redemptions', 'anon cannot read claim redemptions');
  perform t.fails($q$select public.redeem_claim('x')$q$, 'anon cannot redeem a claim');
  perform t.fails($q$select public.preview_claim('x', 'ip')$q$, 'anon cannot preview a claim');
  perform t.fails($q$select public.start_vendor_application(gen_random_uuid(), 'N', null, null)$q$, 'anon cannot register');
  perform t.fails($q$select public.vendor_my_scans(null, null, 10)$q$, 'anon cannot list vendor scans');
  perform t.fails($q$select public.record_custody_action('receive', 'aaaaaaaaaaaaaaaaaaaaaa', null, null, gen_random_uuid())$q$, 'anon cannot record custody');
  perform t.fails($q$select public.place_units(gen_random_uuid(), array[gen_random_uuid()])$q$, 'anon cannot place units');
  perform t.fails($q$select public.supply_chain_metrics()$q$, 'anon cannot read supply metrics');
  reset role;
end $$;

-- 2. Registration, approval, claims ---------------------------------------------------------
do $$
declare r jsonb; code text; org_a uuid; child uuid;
begin
  set local role service_role;
  r := public.start_vendor_application('10000000-0000-0000-0000-0000000000b1', 'Applicant Co', '24ABCDE1234F1Z5', null);
  perform t.ok(r ->> 'ok' = 'true' and r ->> 'status' = 'pending', 'self-registration in review mode stays pending');
  reset role;
  perform t.ok((select role = 'consumer' from public.profiles where id = '10000000-0000-0000-0000-0000000000b1'),
               'an applicant stays a consumer until the organization is approved');
  set local role service_role;
  r := public.start_vendor_application('10000000-0000-0000-0000-0000000000b1', 'Applicant Co 2', null, null);
  perform t.ok(r ->> 'ok' = 'false', 'a second live application is refused without a distinct reason');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-0000000000a1', true);
  perform public.admin_set_org_status((select id from public.organizations where name = 'Applicant Co'), 'active', 'approved');
  reset role;
  perform t.ok((select role = 'vendor' from public.profiles where id = '10000000-0000-0000-0000-0000000000b1'),
               'approving an organization makes its owner a vendor');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-0000000000a1', true);
  org_a := public.admin_create_org('Vendor A Org', 'distributor', null, null);
  reset role;
  insert into public.org_members (org_id, user_id, org_role) values
    (org_a, '10000000-0000-0000-0000-0000000000c1', 'owner'),
    (org_a, '10000000-0000-0000-0000-0000000000c2', 'staff');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-0000000000c1', true);
  r := public.org_create_downstream(org_a, 'Downstream Shop', 'retailer', 'shop@example.com', null, 'Surat');
  code := r ->> 'code';
  child := (r ->> 'org_id')::uuid;
  perform t.ok(char_length(code) = 22 and (select status = 'pending' from public.organizations where id = child),
               'a downstream claim is issued once and the organization stays pending until redeemed');
  perform t.ok((select code_hash = encode(extensions.digest(code, 'sha256'), 'hex') from public.claim_codes where org_id = child),
               'the stored claim is the sha256 of the plaintext');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-0000000000e1', true);
  r := public.redeem_claim(code);
  perform t.ok(r ->> 'ok' = 'true' and (select status = 'active' from public.organizations where id = child),
               'redeeming an owner claim activates the organization');
  perform t.ok((select role = 'vendor' from public.profiles where id = '10000000-0000-0000-0000-0000000000e1'),
               'the claimer becomes a vendor');
  r := public.redeem_claim(code);
  perform t.ok(r ->> 'error' = 'claim_invalid', 'a claim code cannot be used twice');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-0000000000c1', true);
  code := public.org_invite_staff(org_a, 'staff');
  perform public.org_revoke_claim((select id from public.claim_codes where org_id = org_a and kind = 'staff' order by created_at desc limit 1));
  reset role;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-0000000000e2', true);
  perform t.ok(public.redeem_claim(code) ->> 'error' = 'claim_invalid', 'a revoked claim cannot be redeemed');
  reset role;

  update public.app_settings set self_registration_mode = 'off';
  set local role service_role;
  perform t.ok(public.start_vendor_application('10000000-0000-0000-0000-0000000000e2', 'Closed Co', null, null) ->> 'error' = 'registration_closed',
               'registration can be turned off');
  reset role;
  update public.app_settings set self_registration_mode = 'review';
end $$;

-- 3. Two vendors cannot see each other's scans or the catalogue ------------------------------
do $$
declare tok text; org_a uuid; org_b uuid; r jsonb;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-0000000000a1', true);
  org_a := public.admin_create_org('Iso A', 'warehouse', null, null);
  org_b := public.admin_create_org('Iso B', 'warehouse', null, null);
  r := public.create_product_with_units('{"name":"Isolated Tea","batch_number":"ISO","unit_price":"49"}'::jsonb, 1);
  reset role;
  insert into public.org_members (org_id, user_id, org_role) values
    (org_a, '10000000-0000-0000-0000-0000000000c1', 'owner'),
    (org_a, '10000000-0000-0000-0000-0000000000c2', 'staff'),
    (org_b, '10000000-0000-0000-0000-0000000000d1', 'owner');
  select token into tok from public.product_units pu
    join public.products p on p.id = pu.product_id where p.name = 'Isolated Tea';

  set local role service_role;
  perform public.record_scan(tok, gen_random_uuid(), null, null, null, 'denied', null, null, 'iph', 'UA',
    null, null, null, null, '10000000-0000-0000-0000-0000000000c2', 'vendor');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-0000000000d1', true);
  perform t.ok((select count(*) from public.products) = 0, 'vendor B cannot read the product catalogue');
  perform t.ok(jsonb_array_length(public.vendor_my_scans(null, null, 20) -> 'rows') = 0, 'vendor B does not see vendor A scans');
  perform t.ok(jsonb_array_length(public.vendor_my_products(10)) = 0, 'vendor B has no products from those scans');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-0000000000c2', true);
  perform t.ok(jsonb_array_length(public.vendor_my_scans(null, null, 20) -> 'rows') = 1, 'staff see their own scan');
  perform t.ok(not ((public.vendor_my_products(10) -> 0) ? 'unit_price'), 'vendor products omit price');
  perform t.ok(not ((public.vendor_my_products(10) -> 0) ? 'sku'), 'sku is omitted unless the setting allows it');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-0000000000c1', true);
  perform t.ok(jsonb_array_length(public.vendor_my_scans(null, null, 20) -> 'rows') = 1, 'an owner sees scans made by their staff');
  reset role;
end $$;

-- 4. Custody state machine ---------------------------------------------------------------------
do $$
declare
  prod uuid; u1 uuid; u2 uuid; tok1 text; tok2 text; org uuid;
  wh uuid; shop uuid; ship uuid; idem uuid := gen_random_uuid(); r jsonb;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-0000000000a1', true);
  prod := (public.create_product_with_units('{"name":"Chain Tea","batch_number":"CH"}'::jsonb, 2) ->> 'product_id')::uuid;
  org := public.admin_create_org('Chain Org', 'distributor', null, null);
  wh := public.org_save_location(null, org, 'Warehouse', 'warehouse', 'WH', null, 'Surat', 'Gujarat', 'India', null, 21.1702, 72.8311, 200, true);
  shop := public.org_save_location(null, org, 'Shop', 'retailer', 'SH', null, 'Ahmedabad', 'Gujarat', 'India', null, 23.0225, 72.5714, 200, true);
  select id, token into u1, tok1 from public.product_units where product_id = prod and serial = 1;
  select id, token into u2, tok2 from public.product_units where product_id = prod and serial = 2;
  r := public.place_units(wh, array[u1, u2]);
  perform t.ok(r ->> 'result' = 'accepted' and (select unit_state = 'in_stock' and current_location_id = wh from public.product_units where id = u1),
               'admin can place registered units into stock');
  ship := (public.create_shipment(wh, shop, null, idem) ->> 'shipment_id')::uuid;
  perform t.ok((public.create_shipment(wh, shop, null, idem) ->> 'replayed')::boolean, 'creating a shipment again with the same key replays');
  r := public.shipment_add_units(ship, array[u1, u2]);
  perform t.ok(r ->> 'result' = 'accepted', 'units at the origin can be added to a draft shipment');
  r := public.create_shipment(wh, shop, null, gen_random_uuid());
  perform t.ok(public.shipment_add_units((r ->> 'shipment_id')::uuid, array[u1]) ->> 'reason' = 'already_in_shipment',
               'a unit cannot sit in two open shipments');
  perform public.cancel_shipment((r ->> 'shipment_id')::uuid, 'not needed');
  r := public.dispatch_shipment(ship, gen_random_uuid(), null, null, null, 'denied');
  perform t.ok(r ->> 'result' = 'accepted' and (select unit_state = 'in_transit' from public.product_units where id = u1),
               'dispatch moves the units to in transit');
  r := public.record_custody_action('receive', tok1, wh, null, gen_random_uuid(), null, null, null, 'denied', null);
  perform t.ok(r ->> 'reason' = 'wrong_destination' and (select unit_state = 'in_transit' from public.product_units where id = u1),
               'receiving at the wrong location records a discrepancy and does not complete the unit');
  perform t.ok((select count(*) from public.discrepancies where kind = 'wrong_destination' and unit_id = u1) = 1, 'wrong-destination discrepancy is open');
  idem := gen_random_uuid();
  r := public.record_custody_action('receive', tok1, shop, null, idem, 28.6, 77.2, 30, 'granted', null);
  perform t.ok(r ->> 'result' = 'accepted' and r ->> 'geofence' = 'outside', 'a far reading is flagged when geofence mode is flag');
  perform t.ok((select unit_state = 'in_stock' and current_location_id = shop from public.product_units where id = u1),
               'the unit is stocked at the destination');
  perform t.ok((select count(*) from public.discrepancies where kind = 'geofence_mismatch' and unit_id = u1) = 1, 'outside geofence opens a discrepancy');
  r := public.record_custody_action('receive', tok1, shop, null, idem, 28.6, 77.2, 30, 'granted', null);
  perform t.ok((r ->> 'replayed')::boolean and (select count(*) from public.custody_events where unit_id = u1 and event_type = 'received') = 1,
               'a retried receive does not create a second custody event');
  r := public.record_custody_action('sell', tok1, shop, null, gen_random_uuid(), null, null, null, 'denied', null);
  perform t.ok(r ->> 'result' = 'accepted' and (select unit_state = 'sold' from public.product_units where id = u1),
               'a unit in stock at a retailer can be sold');
  r := public.close_shipment(ship, 'left behind');
  perform t.ok((r ->> 'missing')::int = 1 and (select unit_state = 'lost_or_damaged' from public.product_units where id = u2),
               'closing a shipment marks the unreceived unit missing');
  perform t.ok((select count(*) from public.discrepancies where kind = 'missing_on_close' and unit_id = u2) = 1, 'missing-on-close discrepancy is opened');
  perform t.ok(public.record_custody_action('sell', tok2, shop, null, gen_random_uuid()) ->> 'reason' = 'illegal_transition',
               'a lost unit cannot be sold');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-0000000000c1', true);
  perform t.ok((select count(*) from public.shipments) = 0, 'a vendor has no direct select on shipments');
  perform t.ok((select count(*) from public.locations) = 0, 'a vendor has no direct select on locations');
  perform t.fails($q$select public.place_units(gen_random_uuid(), array[gen_random_uuid()])$q$, 'a vendor cannot place units');
  reset role;
end $$;

rollback;
