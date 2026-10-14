-- 0005_product_overview_place.sql : expose last-scan place labels on product_overview.
-- New columns must be appended (CREATE OR REPLACE cannot rename/reorder existing view columns).

create or replace view public.product_overview with (security_invoker = true) as
select p.*,
       coalesce(u.unit_count, 0)    as unit_count,
       coalesce(u.scanned_units, 0) as scanned_units,
       ls.scanned_at                as last_scan_at,
       ls.latitude                  as last_scan_lat,
       ls.longitude                 as last_scan_lon,
       ls.accuracy_m                as last_scan_accuracy_m,
       (p.expiry_date is not null and p.expiry_date < public.local_today()) as is_expired,
       ls.location_area             as last_scan_area,
       ls.location_city             as last_scan_city,
       ls.location_state            as last_scan_state,
       ls.location_country          as last_scan_country
from public.products p
left join lateral (
  select count(*) as unit_count, count(*) filter (where pu.scan_count > 0) as scanned_units
  from public.product_units pu where pu.product_id = p.id
) u on true
left join lateral (
  select e.scanned_at, e.latitude, e.longitude, e.accuracy_m,
         e.location_area, e.location_city, e.location_state, e.location_country
  from public.product_units pu
  join public.scan_events e on e.id = pu.last_scan_id
  where pu.product_id = p.id
  order by pu.last_scan_at desc limit 1
) ls on true;

grant select on public.product_overview to authenticated;
