export type LocationStatus = "granted" | "denied" | "unavailable" | "timeout" | "unsupported";

export interface GeoReading { latitude: number; longitude: number; accuracyM: number; capturedAt: string }
export type GeoResult = { status: "granted"; reading: GeoReading } | { status: Exclude<LocationStatus, "granted"> };

/** Maps GeolocationPositionError.code (1 denied, 2 unavailable, 3 timeout) to our statuses. */
export function mapGeoError(code: number): Exclude<LocationStatus, "granted"> {
  return code === 1 ? "denied" : code === 3 ? "timeout" : "unavailable";
}

export function getLocation(timeoutMs = 15000): Promise<GeoResult> {
  if (!("geolocation" in navigator) || !window.isSecureContext) return Promise.resolve({ status: "unsupported" });
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({
        status: "granted",
        reading: { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracyM: p.coords.accuracy, capturedAt: new Date(p.timestamp).toISOString() },
      }),
      (e) => resolve({ status: mapGeoError(e.code) }),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    );
  });
}

export interface ScanPayload {
  token: string; idempotencyKey: string; locationStatus: LocationStatus;
  location?: GeoReading; vendorReference?: string;
}

/**
 * Idempotency keys must follow the payload: a network retry of the SAME payload reuses the key
 * (no duplicate event), but a different payload (e.g. denied -> granted) needs a fresh key,
 * otherwise the server would replay the old event and drop the new coordinates.
 */
export function makeKeyTracker(newKey: () => string = () => crypto.randomUUID()) {
  let last: { sig: string; key: string } | null = null;
  return {
    keyFor(sig: string) { if (!last || last.sig !== sig) last = { sig, key: newKey() }; return last.key; },
    reset() { last = null; },
  };
}

export const payloadSig = (p: Omit<ScanPayload, "idempotencyKey">) =>
  JSON.stringify([p.token, p.locationStatus, p.location?.latitude, p.location?.longitude, p.vendorReference ?? ""]);
