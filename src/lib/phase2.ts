import { supabase, SUPABASE_ANON_KEY, SUPABASE_URL } from "./supabase";

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await supabase.rpc(fn, args);
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

export async function callFunction(name: string, body: unknown, accessToken?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, { method: "POST", headers, body: JSON.stringify(body) });
  const json = await r.json().catch(() => null);
  if (!r.ok) throw new Error(json?.error || "request_failed");
  return json;
}

export interface OrgBrief { id: string; name: string; status: string; org_role: string }
export interface VendorScan {
  id: string; scanned_at: string; location_status: string; location_area: string | null; location_city: string | null;
  location_state: string | null; location_country: string | null; flags: string[]; latitude: number | null; longitude: number | null;
  product_name: string; batch_number: string | null; unit_label: string;
}
export interface VendorProduct {
  name: string; manufacturer: string | null; category: string | null; batch_number: string | null;
  expiry_date: string | null; is_expired: boolean; sku?: string | null; units_seen: number; last_scanned_at: string;
}
export interface VendorLocation { id: string; name: string; type: string; city: string | null; org_name: string; geofence_radius_m: number }
export interface VendorShipment {
  id: string; reference: string; status: string; dispatched_at: string | null; origin_name: string; destination_name: string;
  can_dispatch: boolean; can_receive: boolean; units: number;
}
export interface SupplyMetrics {
  units_in_transit: number; open_discrepancies: number; overdue_shipments: number; shipments_open: number; locations: number;
}

export const myOrgs = () => rpc<OrgBrief[]>("my_orgs");
export const myApplication = () => rpc<{ status: string; name?: string; org_id?: string }>("my_application_status");
export const orgOverview = (orgId: string) => rpc<{ id: string; name: string; status: string; is_manager: boolean; members: number; downstream: number }>("org_overview", { p_org: orgId });
export const orgMembers = (orgId: string) => rpc<{ user_id: string; full_name: string | null; org_role: string; status: string }[]>("org_members_list", { p_org: orgId });
export const orgDownstream = (orgId: string) => rpc<{ id: string; name: string; type: string; status: string; city: string | null }[]>("org_downstream_list", { p_org: orgId });
export const orgClaims = (orgId: string) => rpc<{ id: string; kind: string; role: string; expires_at: string; use_count: number; max_uses: number; revoked: boolean }[]>("org_claims_list", { p_org: orgId });
export const createDownstream = (parentId: string, name: string, type: string, email: string, city: string) =>
  rpc<{ org_id: string; code: string }>("org_create_downstream", { p_parent: parentId, p_name: name, p_type: type, p_email: email || null, p_phone: null, p_city: city || null });
export const inviteStaff = (orgId: string, role: string) => rpc<string>("org_invite_staff", { p_org: orgId, p_role: role });
export const createJoinCode = (orgId: string, maxUses: number) => rpc<string>("org_create_join_code", { p_org: orgId, p_max_uses: maxUses });
export const revokeClaim = (claimId: string) => rpc<void>("org_revoke_claim", { p_claim: claimId });
export const setMemberStatus = (orgId: string, userId: string, status: string) => rpc<void>("org_set_member_status", { p_org: orgId, p_user: userId, p_status: status });
export const bulkImport = (orgId: string, rows: unknown[], dryRun: boolean) =>
  rpc<{ job_id: string; dry_run: boolean; error_count: number; rows: { row: number; ok: boolean; error?: string; name?: string; existing?: boolean }[]; codes: { row: number; name: string; email?: string; code: string }[] }>("org_bulk_import", { p_org: orgId, p_rows: rows, p_dry_run: dryRun });

export const vendorScans = (before?: string, beforeId?: string) =>
  rpc<{ rows: VendorScan[] }>("vendor_my_scans", { p_before: before ?? null, p_before_id: beforeId ?? null, p_limit: 25 });
export const vendorProducts = () => rpc<VendorProduct[]>("vendor_my_products", { p_limit: 100 });
export const vendorLocations = () => rpc<VendorLocation[]>("vendor_my_locations");
export const vendorSummary = () => rpc<{ inbound: number; to_dispatch: number }>("vendor_inbound_summary");
export const vendorShipments = () => rpc<VendorShipment[]>("vendor_open_shipments");
export const vendorShipmentDetail = (id: string) => rpc<{ id: string; reference: string; status: string; units: { unit_label: string; product_name: string; unit_state: string; line_status: string }[] }>("vendor_shipment_detail", { p_shipment: id });

export const recordCustody = (p: { action: string; token: string; locationId: string; idem: string; note?: string; lat?: number; lon?: number; accuracy?: number }) =>
  rpc<{ result: string; reason?: string; replayed?: boolean; geofence?: string }>("record_custody_action", {
    p_action: p.action, p_token: p.token, p_location: p.locationId, p_shipment: null, p_idem: p.idem,
    p_lat: p.lat ?? null, p_lon: p.lon ?? null, p_accuracy: p.accuracy ?? null,
    p_loc_status: p.lat == null ? "denied" : "granted", p_note: p.note ?? null,
  });
export const dispatchShipment = (id: string, idem: string) =>
  rpc<{ result: string; reason?: string }>("dispatch_shipment", { p_shipment: id, p_idem: idem, p_lat: null, p_lon: null, p_accuracy: null, p_loc_status: "denied" });

export const supplyMetrics = () => rpc<SupplyMetrics>("supply_chain_metrics");
export const adminLocations = () => rpc<{ id: string; org_id: string; org_name: string; name: string; type: string; city: string | null; latitude: number | null; longitude: number | null; geofence_radius_m: number; is_active: boolean }[]>("admin_locations");
export const saveLocation = (v: { id?: string; orgId: string; name: string; type: string; code: string; city: string; lat: string; lon: string; radius: string }) =>
  rpc<string>("org_save_location", {
    p_id: v.id || null, p_org: v.orgId, p_name: v.name, p_type: v.type, p_code: v.code || null, p_address: null,
    p_city: v.city || null, p_state: null, p_country: null, p_postal: null,
    p_lat: v.lat === "" ? null : Number(v.lat), p_lon: v.lon === "" ? null : Number(v.lon),
    p_radius: v.radius === "" ? 200 : Number(v.radius), p_active: true,
  });
export const orgLocations = (orgId: string) => rpc<{ id: string; name: string; type: string; city: string | null }[]>("org_locations_list", { p_org: orgId });
export const assignLocation = (locationId: string, userId: string, assign: boolean) => rpc<void>("org_assign_location", { p_location: locationId, p_user: userId, p_assign: assign });
export const locationAssignees = (locationId: string) => rpc<string[]>("location_assignees", { p_location: locationId });
export const adminShipments = (status: string) => rpc<{ id: string; reference: string; status: string; origin_name: string; destination_name: string; origin_id: string; destination_id: string; expected: number; received: number; overdue: boolean; created_at: string }[]>("admin_shipments", { p_status: status || null, p_limit: 50 });
export const shipmentUnits = (id: string) => rpc<{ unit_id: string; unit_label: string; product_name: string; unit_state: string; line_status: string }[]>("admin_shipment_units", { p_shipment: id });
export const placeUnits = (locationId: string, unitIds: string[]) => rpc<{ result: string; reason?: string; count?: number }>("place_units", { p_location: locationId, p_units: unitIds });
export const createShipment = (origin: string, destination: string, idem: string) => rpc<{ shipment_id: string; reference: string; replayed: boolean }>("create_shipment", { p_origin: origin, p_destination: destination, p_note: null, p_idem: idem });
export const addShipmentUnits = (shipmentId: string, unitIds: string[]) => rpc<{ result: string; reason?: string }>("shipment_add_units", { p_shipment: shipmentId, p_units: unitIds });
export const closeShipment = (id: string, note: string) => rpc<{ result: string; missing?: number }>("close_shipment", { p_shipment: id, p_note: note || null });
export const cancelShipment = (id: string) => rpc<{ result: string }>("cancel_shipment", { p_shipment: id, p_note: null });
export const adminDiscrepancies = (status: string) => rpc<{ id: string; kind: string; status: string; created_at: string; note: string | null; unit_label: string | null; product_name: string | null; location_name: string | null }[]>("admin_discrepancies", { p_status: status || null, p_limit: 50 });
export const resolveDiscrepancy = (id: string, note: string) => rpc<void>("resolve_discrepancy", { p_id: id, p_note: note || null });
export const productCustody = (productId: string) => rpc<{ id: string; event_type: string; occurred_at: string; unit_label: string; location_name: string | null; city: string | null; geofence_status: string | null }[]>("product_custody", { p_product: productId });
export const custodyExport = () => rpc<{ occurred_at: string; event_type: string; unit_label: string; product_name: string; location_name: string | null; city: string | null; geofence_status: string | null; note: string | null }[]>("admin_custody_export", { p_from: null, p_to: null });
export const unitsByLocation = () => rpc<{ location_id: string; name: string; city: string | null; latitude: number | null; longitude: number | null; in_stock: number; in_transit: number }[]>("units_by_location");
export const laneVolumes = () => rpc<{ origin_name: string; destination_name: string; origin_lat: number | null; origin_lon: number | null; destination_lat: number | null; destination_lon: number | null; shipments: number }[]>("lane_volumes");
