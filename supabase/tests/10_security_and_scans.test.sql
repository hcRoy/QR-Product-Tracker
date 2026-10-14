-- Integration tests: RLS, public boundary, tokens, scan rules, metrics.
-- Run: psql -v ON_ERROR_STOP=1 -d <db> -f 10_security_and_scans.test.sql   (rolls back at the end)
-- Any failed assertion raises an exception and aborts the run.
\set ON_ERROR_STOP on
begin;

create schema t;
create function t.ok(c boolean, msg text) returns void language plpgsql as $$
begin
  if c is not true then raise exception 'FAIL: %', msg; end if;
  raise notice 'PASS: %', msg;
end $$;
create function t.fails(q text, msg text) returns void language plpgsql as $$
begin
  begin execute q; exception when others then raise notice 'PASS: % [%]', msg, sqlerrm; return; end;
  raise exception 'FAIL: % (statement succeeded but should have failed)', msg;
end $$;
grant usage on schema t to public;
grant execute on all functions in schema t to public;

insert into auth.users (id, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000a1', '{"full_name":"Admin"}'),
  ('00000000-0000-0000-0000-0000000000b2', '{"full_name":"Viewer"}');
update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000a1';

-- 0. RLS enabled everywhere ---------------------------------------------------
do $$ begin
  perform t.ok((select bool_and(relrowsecurity) from pg_class
                where relnamespace = 'public'::regnamespace and relkind = 'r'),
               'RLS is enabled on every public table');
end $$;

-- 1. Admin creates products & units -------------------------------------------
do $$
declare r jsonb;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  r := public.create_product_with_units(
    '{"name":"Test Tea","sku":"TEA-1","batch_number":"B1","manufacturing_date":"2026-01-01",
      "expiry_date":"2030-01-01","unit_price":"120.50","package_quantity":"10",
      "package_type":"Box","created_by":"00000000-0000-0000-0000-0000000000b2","status":"archived"}'::jsonb, 5);
  perform t.ok((r ->> 'unit_count')::int = 5, 'admin can create a product with 5 units');
  perform t.ok((select count(distinct token) from public.product_units) = 5, 'every unit has a distinct token');
  perform t.ok((select bool_and(token ~ '^[A-Za-z0-9_-]{22}$') from public.product_units), 'tokens are 22-char base64url');
  perform t.ok((select status = 'active' and created_by = '00000000-0000-0000-0000-0000000000a1'
                  from public.products where sku = 'TEA-1'),
               'client-supplied status/created_by are ignored (no mass assignment)');
  perform t.ok((select count(*) from public.audit_logs where action = 'product.created') = 1, 'creation is audit-logged');
  reset role;
end $$;

-- 2. Validation rejects bad data ------------------------------------------------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  perform t.fails($q$select public.create_product_with_units('{"name":"X","manufacturing_date":"2026-05-01","expiry_date":"2026-01-01"}', 1)$q$, 'expiry before manufacturing rejected');
  perform t.fails($q$select public.create_product_with_units('{"name":"X","unit_price":"-1"}', 1)$q$, 'negative price rejected');
  perform t.fails($q$select public.create_product_with_units('{"name":"   "}', 1)$q$, 'blank name rejected');
  perform t.fails($q$select public.create_product_with_units('{"name":"X","currency":"inr"}', 1)$q$, 'invalid currency rejected');
  perform t.fails($q$select public.create_product_with_units('{"name":"X","package_quantity":"0"}', 1)$q$, 'zero quantity rejected');
  perform t.fails($q$select public.create_product_with_units('{"name":"X"}', 0)$q$, 'unit_count 0 rejected');
  perform t.fails($q$select public.create_product_with_units('{"name":"Dup","sku":"tea-1","batch_number":"b1"}', 1)$q$, 'duplicate SKU+batch rejected (case-insensitive)');
  perform t.ok((select count(*) from public.products) = 1, 'failed creations left no partial rows');
  reset role;
end $$;

-- 3. Non-admin (viewer) is denied ---------------------------------------------------
do $$
declare n int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b2', true);
  perform t.ok((select count(*) from public.products) = 0, 'viewer sees no products');
  perform t.ok((select count(*) from public.product_units) = 0, 'viewer sees no units/tokens');
  perform t.ok((select count(*) from public.product_overview) = 0, 'viewer sees nothing via product_overview');
  perform t.ok((select count(*) from public.map_points()) = 0, 'viewer gets no map points');
  perform t.fails($q$select public.create_product_with_units('{"name":"Nope"}', 1)$q$, 'viewer cannot create products via RPC');
  perform t.fails($q$insert into public.products (name) values ('Nope')$q$, 'viewer cannot insert products directly');
  perform t.fails($q$select public.dashboard_metrics()$q$, 'viewer cannot read dashboard metrics');
  perform t.fails($q$select public.rotate_unit_token(gen_random_uuid())$q$, 'viewer cannot rotate tokens');
  update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000b2';
  get diagnostics n = row_count;
  perform t.ok(n = 0, 'viewer cannot self-promote to admin');
  perform t.fails($q$select public.record_scan('aaaaaaaaaaaaaaaaaaaaaa', gen_random_uuid(), null, null, null, 'denied', null, null, null, null)$q$, 'viewer cannot call record_scan');
  reset role;
end $$;

-- 4. Anonymous is denied --------------------------------------------------------------
do $$
begin
  set local role anon;
  perform t.fails('select * from public.products', 'anon cannot read products');
  perform t.fails('select * from public.scan_events', 'anon cannot read scan history');
  perform t.fails('select * from public.product_units', 'anon cannot read tokens');
  perform t.fails($q$select public.public_lookup('aaaaaaaaaaaaaaaaaaaaaa', null)$q$, 'anon cannot call public_lookup directly');
  perform t.fails($q$select public.record_scan('aaaaaaaaaaaaaaaaaaaaaa', gen_random_uuid(), null, null, null, 'denied', null, null, null, null)$q$, 'anon cannot call record_scan directly');
  reset role;
end $$;

-- 5. Public lookup exposes only approved fields ------------------------------------
do $$
declare tok text; r jsonb; keys text[];
begin
  select token into tok from public.product_units where serial = 1;
  set local role service_role;
  r := public.public_lookup(tok, 'iph');
  perform t.ok(r ->> 'status' = 'ok', 'valid token resolves');
  perform t.ok(r -> 'product' ->> 'name' = 'Test Tea', 'token resolves to the correct product');
  select array_agg(k order by k) into keys from jsonb_object_keys(r -> 'product') k;
  perform t.ok(keys = array['batch_number','category','description','expiry_date','is_expired','manufacturer',
                            'manufacturing_date','name','package_description','package_quantity','package_type',
                            'unit_label','unit_of_measure'],
               'public payload contains exactly the approved keys');
  perform t.ok(position('120.5' in r::text) = 0 and position('TEA-1' in r::text) = 0 and position(tok in r::text) = 0,
               'price, SKU and token are not in the public payload');
  perform t.ok(r -> 'product' ->> 'unit_label' = 'B1-00001', 'human-readable unit label is returned');
  perform t.ok(public.public_lookup('not-a-token', 'iph') ->> 'status' = 'invalid', 'malformed token -> invalid');
  perform t.ok(public.public_lookup('ZZZZZZZZZZZZZZZZZZZZZZ', 'iph') ->> 'status' = 'invalid', 'unknown token -> invalid');
  reset role;
end $$;

-- 6. Scan recording, GPS handling, idempotency, rules (unit 1) ------------------------------
do $$
declare tok text; r jsonb; idem uuid := gen_random_uuid(); fl text[]; unknown text := 'QQQQQQQQQQQQQQQQQQQQQQ';
begin
  select token into tok from public.product_units where serial = 1;
  set local role service_role;

  r := public.record_scan(tok, idem, 21.170240, 72.831062, 25, 'granted', now(), ' WH-7 ', 'iph', 'UA',
                          'Adajan', 'Surat', 'Gujarat', 'India');
  perform t.ok(r ->> 'result' = 'accepted' and (r ->> 'location_recorded')::boolean, 'scan with GPS accepted');
  perform t.ok((select count(*) from public.scan_events) = 1, 'scan row created');
  perform t.ok((select latitude = 21.170240 and vendor_reference = 'WH-7' and flags = '{}' from public.scan_events),
               'coordinates stored, vendor reference trimmed, no flags on first scan');
  perform t.ok((select location_area = 'Adajan' and location_city = 'Surat'
                         and location_state = 'Gujarat' and location_country = 'India' from public.scan_events),
               'reverse-geocoded place fields stored with GPS scan');
  perform t.ok((select scan_count = 1 and last_scan_id is not null from public.product_units where serial = 1),
               'unit scan summary updated');

  r := public.record_scan(tok, idem, 21.170240, 72.831062, 25, 'granted', now(), null, 'iph', 'UA');
  perform t.ok((r ->> 'replayed')::boolean and (select count(*) from public.scan_events) = 1,
               'retry with same idempotency key does not create a duplicate');

  r := public.record_scan(tok, gen_random_uuid(), null, null, null, 'denied', null, null, 'iph', 'UA',
                          'Should', 'Be', 'Cleared', 'Away');
  perform t.ok(r ->> 'result' = 'accepted' and not (r ->> 'location_recorded')::boolean, 'scan without GPS is accepted and marked as no-location');
  perform t.ok((select latitude is null and location_status = 'denied' and 'rapid_repeat' = any(flags)
                         and location_area is null and location_city is null
                         and location_state is null and location_country is null
                  from public.scan_events where id = (r ->> 'scan_id')::uuid),
               'no-GPS scan has null coordinates, null place fields, and rapid_repeat flag');

  r := public.record_scan(tok, gen_random_uuid(), 95, 72.8, 10, 'granted', now(), null, 'iph', 'UA');
  perform t.ok(r ->> 'reason' = 'invalid_input', 'latitude 95 rejected');
  r := public.record_scan(tok, gen_random_uuid(), 21.1, 200, 10, 'granted', now(), null, 'iph', 'UA');
  perform t.ok(r ->> 'reason' = 'invalid_input', 'longitude 200 rejected');
  r := public.record_scan(tok, gen_random_uuid(), 21.1, 72.8, -5, 'granted', now(), null, 'iph', 'UA');
  perform t.ok(r ->> 'reason' = 'invalid_input', 'negative accuracy rejected');
  r := public.record_scan(tok, gen_random_uuid(), 21.1, 72.8, null, 'granted', now(), null, 'iph', 'UA');
  perform t.ok(r ->> 'reason' = 'invalid_input', 'granted without accuracy rejected');
  r := public.record_scan(tok, gen_random_uuid(), 21.1, 72.8, 10, 'denied', null, null, 'iph', 'UA');
  perform t.ok((select latitude is null from public.scan_events where id = (r ->> 'scan_id')::uuid),
               'coordinates sent with a non-granted status are discarded, not stored');
  perform t.ok((select count(*) from public.scan_events) = 3, 'rejected inputs created no events');

  r := public.record_scan('bad', gen_random_uuid(), null, null, null, 'denied', null, null, 'iph', 'UA');
  perform t.ok(r ->> 'reason' = 'invalid_input', 'malformed token rejected');
  r := public.record_scan(unknown, gen_random_uuid(), null, null, null, 'denied', null, null, 'iph', 'UA');
  perform t.ok(r ->> 'reason' = 'invalid_token', 'unknown token rejected');
  perform t.ok(exists (select 1 from public.rejected_attempts where reason = 'unknown_or_replaced_token')
               and not exists (select 1 from public.rejected_attempts where token_fingerprint = unknown),
               'invalid attempt logged by fingerprint only (raw token never stored)');

  r := public.record_scan(tok, gen_random_uuid(), 28.613900, 77.209000, 20, 'granted', now(), null, 'iph', 'UA');
  select flags into fl from public.scan_events where id = (r ->> 'scan_id')::uuid;
  perform t.ok('implausible_travel' = any(fl), 'Surat -> Delhi seconds later is flagged implausible_travel');
  reset role;
end $$;

-- 7. High frequency (unit 2) ----------------------------------------------------------------
do $$
declare tok text; r jsonb; i int;
begin
  select token into tok from public.product_units where serial = 2;
  set local role service_role;
  for i in 1..11 loop
    r := public.record_scan(tok, gen_random_uuid(), null, null, null, 'unavailable', null, null, 'iph', 'UA');
  end loop;
  perform t.ok((select 'high_frequency' = any(flags) from public.scan_events where id = (r ->> 'scan_id')::uuid),
               'the 11th scan within the window is flagged high_frequency');
  reset role;
end $$;

-- 8. Revoke and rotate -----------------------------------------------------------------
do $$
declare u3 uuid; tok3 text; u4 uuid; old4 text; new4 text; r jsonb;
begin
  select id, token into u3, tok3 from public.product_units where serial = 3;
  select id, token into u4, old4 from public.product_units where serial = 4;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  perform public.revoke_unit(u3, 'lost in transit');
  new4 := public.rotate_unit_token(u4, 'label photographed publicly');
  reset role;

  set local role service_role;
  perform t.ok(public.public_lookup(tok3, 'iph') ->> 'status' = 'revoked', 'revoked token -> revoked on lookup');
  r := public.record_scan(tok3, gen_random_uuid(), null, null, null, 'denied', null, null, 'iph', 'UA');
  perform t.ok(r ->> 'reason' = 'revoked', 'scan against revoked token rejected');
  perform t.ok(new4 <> old4, 'rotation issues a different token');
  r := public.record_scan(old4, gen_random_uuid(), null, null, null, 'denied', null, null, 'iph', 'UA');
  perform t.ok(r ->> 'reason' = 'invalid_token', 'old token rejected after rotation');
  perform t.ok(exists (select 1 from public.rejected_attempts where unit_id = u4), 'old-token attempt is linked to its unit for investigation');
  r := public.record_scan(new4, gen_random_uuid(), null, null, null, 'denied', null, null, 'iph', 'UA');
  perform t.ok(r ->> 'result' = 'accepted', 'new token accepted; same unit identity retained');
  perform t.ok((select count(*) from public.product_units where id = u4) = 1, 'rotation did not create a second identity');
  reset role;
  perform t.ok((select count(*) from public.audit_logs where action in ('unit.revoked', 'unit.token_rotated')) = 2, 'revoke and rotate are audit-logged');
end $$;

-- 9. Archived and expired products ------------------------------------------------------------
do $$
declare a jsonb; e jsonb; ta text; te text; r jsonb;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  a := public.create_product_with_units('{"name":"Archived Item","sku":"ARC-1"}', 1);
  e := public.create_product_with_units('{"name":"Expired Item","sku":"EXP-1","manufacturing_date":"2019-01-01","expiry_date":"2020-01-01"}', 1);
  update public.products set status = 'archived' where id = (a ->> 'product_id')::uuid;
  perform t.ok(exists (select 1 from public.audit_logs where action = 'product.archived'), 'archiving is audit-logged');
  perform t.ok((select is_expired from public.product_overview where sku = 'EXP-1'), 'expired product identified in overview');
  perform t.ok(not (select is_expired from public.product_overview where sku = 'TEA-1'), 'non-expired product not flagged');
  reset role;
  select token into ta from public.product_units where product_id = (a ->> 'product_id')::uuid;
  select token into te from public.product_units where product_id = (e ->> 'product_id')::uuid;
  set local role service_role;
  perform t.ok(public.public_lookup(ta, 'iph') ->> 'status' = 'unavailable', 'archived product -> unavailable');
  r := public.record_scan(ta, gen_random_uuid(), null, null, null, 'denied', null, null, 'iph', 'UA');
  perform t.ok(r ->> 'reason' = 'unavailable', 'scan against archived product rejected');
  r := public.record_scan(te, gen_random_uuid(), 21.17, 72.83, 15, 'granted', now(), null, 'iph', 'UA');
  perform t.ok((select 'expired_product' = any(flags) from public.scan_events where id = (r ->> 'scan_id')::uuid),
               'scanning an expired product is flagged');
  reset role;
end $$;

-- 10. Dashboard metrics, suspicious view, map ------------------------------------------------------
do $$
declare m jsonb;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  m := public.dashboard_metrics();
  perform t.ok((m ->> 'products_total')::int = 3 and (m ->> 'products_active')::int = 2, 'metrics: product counts');
  perform t.ok((m ->> 'expired_products')::int = 1, 'metrics: expired products');
  perform t.ok((m ->> 'units_total')::int = 7, 'metrics: units total');
  perform t.ok((m ->> 'products_scanned')::int = 2 and (m ->> 'products_never_scanned')::int = 1, 'metrics: scanned / never-scanned products');
  perform t.ok((m ->> 'scans_total')::int = (select count(*) from public.scan_events), 'metrics: scans_total matches table');
  perform t.ok((m ->> 'scans_today')::int = (m ->> 'scans_total')::int, 'metrics: scans_today counts today in configured timezone');
  perform t.ok((m ->> 'units_suspicious_30d')::int = 2, 'metrics: two units carry behavioural flags');
  perform t.ok((select count(*) from public.suspicious_scans) >= 3, 'suspicious_scans view lists flagged events');
  perform t.ok((select sum(scans) from public.scan_activity_series(7)) = (m ->> 'scans_total')::int, 'activity series totals match');
  perform t.ok((select count(*) from public.map_points()) = (select count(*) from public.scan_events where latitude is not null)
               and (select bool_and(latitude between -90 and 90 and longitude between -180 and 180) from public.map_points()),
               'map returns only scans that have valid coordinates');
  perform t.ok((select count(*) from public.map_points(p_flagged => true)) = 1, 'map flagged filter works');
  reset role;
end $$;

-- 11. Pagination and search ------------------------------------------------------------------------
do $$
declare i int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  for i in 1..25 loop
    perform public.create_product_with_units(jsonb_build_object('name', 'Pg Item ' || lpad(i::text, 2, '0'), 'sku', 'PG-' || i), 1);
  end loop;
  perform t.ok((select count(*) from public.product_overview where name like 'Pg Item%') = 25, 'filter by name');
  perform t.ok((select count(*) from (select 1 from public.product_overview where name like 'Pg Item%'
                order by name limit 10 offset 20) x) = 5, 'last page has the remaining 5 rows');
  perform t.ok((select count(*) from public.product_overview where sku ilike '%pg-1%') = 11, 'search by SKU substring');
  perform t.ok((select count(*) from public.product_overview where status = 'archived') = 1, 'filter by status');
  reset role;
end $$;

-- 12. Immutability, retention, rate limiting ---------------------------------------------------------
do $$
declare n int; rid uuid;
begin
  perform t.fails('update public.scan_events set flags = ''{}''', 'scan_events cannot be updated (even by owner)');
  perform t.fails('delete from public.scan_events', 'scan_events cannot be deleted');
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  perform t.fails('update public.scan_events set latitude = 0', 'admin has no write access to scan_events');
  perform t.fails('select public.purge_old_locations()', 'admin cannot call the purge job directly');
  reset role;

  select id into rid from public.scan_events where location_city = 'Surat' and latitude is not null limit 1;
  perform set_config('app.scan_maintenance', 'on', true);
  update public.scan_events set scanned_at = now() - interval '400 days' where id = rid;
  perform set_config('app.scan_maintenance', 'off', true);
  set local role service_role;
  n := public.purge_old_locations();
  reset role;
  perform t.ok(n = 1, 'purge removed coordinates from exactly the expired event');
  perform t.ok((select latitude is null and location_purged_at is not null and location_status = 'granted'
                         and location_city = 'Surat' and location_country = 'India'
                  from public.scan_events where id = rid),
               'purged event keeps its record and place labels but loses coordinates');

  set local role service_role;
  perform t.ok(public.check_rate_limit('k1', 3, 60) and public.check_rate_limit('k1', 3, 60)
               and public.check_rate_limit('k1', 3, 60), 'rate limiter allows up to the limit');
  perform t.ok(not public.check_rate_limit('k1', 3, 60), 'rate limiter blocks the 4th request');
  perform t.ok(public.check_rate_limit('k2', 3, 60), 'rate limits are per key');
  reset role;
end $$;

rollback;
