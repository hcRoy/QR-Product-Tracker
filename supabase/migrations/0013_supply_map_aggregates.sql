-- units_by_location and lane_volumes counted rows inside jsonb_agg.
-- Postgres rejects that as a nested aggregate. Count first, then build the JSON.

create or replace function public.units_by_location() returns jsonb
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

create or replace function public.lane_volumes() returns jsonb
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
