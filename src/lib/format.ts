export const fmtDateTime = (s?: string | null) =>
  s ? new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
export const fmtDate = (s?: string | null) =>
  s ? new Date(s + (s.length === 10 ? "T00:00:00" : "")).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";
export const fmtCoords = (lat?: number | null, lon?: number | null) =>
  lat == null || lon == null ? "Not available" : `${Number(lat).toFixed(5)}, ${Number(lon).toFixed(5)}`;
export const fmtMoney = (v?: number | null, cur = "INR") =>
  v == null ? "—" : new Intl.NumberFormat(undefined, { style: "currency", currency: cur }).format(v);
export const FLAG_LABELS: Record<string, string> = {
  rapid_repeat: "Rapid repeat scan", high_frequency: "Unusually frequent", implausible_travel: "Implausible travel",
  low_accuracy: "Low GPS accuracy", expired_product: "Expired product",
};
export const SUSPICIOUS_FLAGS = ["rapid_repeat", "implausible_travel", "high_frequency"];
/** PostgREST filter values must not contain characters that change the filter grammar. */
export const safeSearch = (q: string) => q.replace(/[%,()*\\]/g, " ").trim();
