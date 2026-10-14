import { supabase } from "./supabase";
import { SUSPICIOUS_FLAGS, safeSearch } from "./format";
import type { ProductFormValues } from "./schemas";
import { toProductPayload } from "./schemas";

export interface ProductRow {
  id: string; name: string; sku: string | null; description: string | null; category: string | null;
  batch_number: string | null; manufacturing_date: string | null; expiry_date: string | null;
  unit_price: number | null; currency: string; package_quantity: number | null; unit_of_measure: string | null;
  package_type: string | null; package_description: string | null; manufacturer: string | null;
  status: "active" | "archived"; created_at: string; updated_at: string;
  unit_count: number; scanned_units: number; is_expired: boolean;
  last_scan_at: string | null; last_scan_lat: number | null; last_scan_lon: number | null; last_scan_accuracy_m: number | null;
}
export interface UnitRow {
  id: string; serial: number; token: string; status: "active" | "revoked";
  scan_count: number; last_scan_at: string | null; revoked_reason: string | null;
}
export interface ScanRow {
  id: string; scanned_at: string; latitude: number | null; longitude: number | null; accuracy_m: number | null;
  location_status: string; flags: string[]; vendor_reference: string | null;
  product_units: { serial: number; product_id: string; products: { name: string; batch_number: string | null } };
}
export interface Metrics {
  products_total: number; products_active: number; products_scanned: number; products_never_scanned: number;
  units_total: number; units_scanned: number; units_never_scanned: number; scans_total: number; scans_today: number;
  expired_products: number; expiring_soon: number; units_suspicious_30d: number; timezone: string;
}
export interface MapPoint {
  scan_id: string; unit_id: string; product_id: string; product_name: string; batch_number: string | null;
  unit_label: string; scanned_at: string; latitude: number; longitude: number; accuracy_m: number | null; flags: string[];
}
export interface Settings {
  timezone: string; allow_scan_without_gps: boolean; max_accuracy_m: number; min_rescan_seconds: number;
  frequency_window_seconds: number; frequency_max_scans: number; max_speed_kmh: number;
  location_retention_days: number; expiring_soon_days: number;
}

function check<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}
const iso = (d: Date) => d.toISOString().slice(0, 10);

// ---------------- products ----------------
export interface ProductQuery {
  page: number; pageSize: number; search: string; status: string; category: string; expiry: string; scanState: string;
}
export async function listProducts(q: ProductQuery) {
  let query = supabase.from("product_overview").select("*", { count: "exact" });
  const s = safeSearch(q.search);
  if (s) query = query.or(`name.ilike.%${s}%,sku.ilike.%${s}%,batch_number.ilike.%${s}%`);
  if (q.status) query = query.eq("status", q.status);
  if (q.category) query = query.eq("category", q.category);
  if (q.expiry === "expired") query = query.eq("is_expired", true);
  if (q.expiry === "soon") {
    const now = new Date(), end = new Date(Date.now() + 30 * 864e5);
    query = query.gte("expiry_date", iso(now)).lte("expiry_date", iso(end));
  }
  if (q.scanState === "never") query = query.eq("scanned_units", 0);
  if (q.scanState === "scanned") query = query.gt("scanned_units", 0);
  const from = (q.page - 1) * q.pageSize;
  const res = await query.order("created_at", { ascending: false }).range(from, from + q.pageSize - 1);
  return { rows: check({ data: res.data as ProductRow[] | null, error: res.error }), total: res.count ?? 0 };
}
export async function listCategories() {
  const rows = check(await supabase.from("products").select("category").not("category", "is", null).limit(1000));
  return [...new Set((rows as { category: string }[]).map((r) => r.category))].sort();
}
export async function getProduct(id: string) {
  return check(await supabase.from("product_overview").select("*").eq("id", id).single()) as ProductRow;
}
export async function createProduct(v: ProductFormValues) {
  const r = check(await supabase.rpc("create_product_with_units", { p: toProductPayload(v), unit_count: Number(v.unit_count) }));
  return r as { product_id: string; unit_count: number };
}
export async function updateProduct(id: string, v: ProductFormValues) {
  check(await supabase.from("products").update(toProductPayload(v)).eq("id", id).select("id").single());
}
export async function setProductStatus(id: string, status: "active" | "archived") {
  check(await supabase.from("products").update({ status }).eq("id", id).select("id").single());
}

// ---------------- units ----------------
export async function listUnits(productId: string, page: number, pageSize = 50) {
  const from = (page - 1) * pageSize;
  const res = await supabase.from("product_units").select("id,serial,token,status,scan_count,last_scan_at,revoked_reason", { count: "exact" })
    .eq("product_id", productId).order("serial").range(from, from + pageSize - 1);
  return { rows: check({ data: res.data as UnitRow[] | null, error: res.error }), total: res.count ?? 0 };
}
export const addUnits = async (productId: string, count: number) => check(await supabase.rpc("add_units", { p_product: productId, p_count: count }));
export const rotateToken = async (unitId: string, reason: string) => check(await supabase.rpc("rotate_unit_token", { p_unit: unitId, p_reason: reason || null }));
export const revokeUnit = async (unitId: string, reason: string) => check(await supabase.rpc("revoke_unit", { p_unit: unitId, p_reason: reason || null }));

// ---------------- scans ----------------
const SCAN_SELECT = "id,scanned_at,latitude,longitude,accuracy_m,location_status,flags,vendor_reference,product_units!inner(serial,product_id,products(name,batch_number))";
export interface ScanQuery { page: number; pageSize: number; productId?: string; flaggedOnly?: boolean; from?: string; to?: string }
export async function listScans(q: ScanQuery) {
  let query = supabase.from("scan_events").select(SCAN_SELECT, { count: "exact" });
  if (q.productId) query = query.eq("product_units.product_id", q.productId);
  if (q.flaggedOnly) query = query.overlaps("flags", SUSPICIOUS_FLAGS);
  if (q.from) query = query.gte("scanned_at", new Date(q.from).toISOString());
  if (q.to) query = query.lt("scanned_at", new Date(new Date(q.to).getTime() + 864e5).toISOString());
  const from = (q.page - 1) * q.pageSize;
  const res = await query.order("scanned_at", { ascending: false }).range(from, from + q.pageSize - 1);
  return { rows: check({ data: res.data as unknown as ScanRow[] | null, error: res.error }), total: res.count ?? 0 };
}
export async function listRejected(page: number, pageSize = 25) {
  const from = (page - 1) * pageSize;
  const res = await supabase.from("rejected_attempts").select("id,token_fingerprint,reason,created_at,unit_id", { count: "exact" })
    .order("created_at", { ascending: false }).range(from, from + pageSize - 1);
  return { rows: check({ data: res.data as { id: number; token_fingerprint: string; reason: string; created_at: string; unit_id: string | null }[] | null, error: res.error }), total: res.count ?? 0 };
}

// ---------------- dashboard / map / settings ----------------
export const getMetrics = async () => check(await supabase.rpc("dashboard_metrics")) as Metrics;
export const getActivity = async (days = 30) =>
  check(await supabase.rpc("scan_activity_series", { p_days: days })) as { day: string; scans: number; flagged: number }[];
export async function getMapPoints(f: { productId?: string; batch?: string; from?: string; to?: string; flagged?: boolean }) {
  return check(await supabase.rpc("map_points", {
    p_product: f.productId || null, p_batch: f.batch || null,
    p_from: f.from ? new Date(f.from).toISOString() : null,
    p_to: f.to ? new Date(new Date(f.to).getTime() + 864e5).toISOString() : null,
    p_flagged: !!f.flagged, p_limit: 2000,
  })) as MapPoint[];
}
export const getSettings = async () => check(await supabase.from("app_settings").select("*").single()) as Settings;
export async function saveSettings(s: Settings) {
  check(await supabase.from("app_settings").update(s).eq("id", true).select("id").single());
}
export async function exportProducts() {
  const rows = check(await supabase.from("product_overview").select("*").order("created_at", { ascending: false }).limit(5000)) as ProductRow[];
  return rows;
}
