export type AppRole = "admin" | "vendor" | "consumer";

export function homeForRole(role: AppRole): string {
  return role === "vendor" ? "/v" : role === "consumer" ? "/c" : "/";
}

/** Where to send someone after sign-in. Deep links are kept only when that role may open them. */
export function destinationForRole(role: AppRole, from?: string | null): string {
  const path = !from || from === "/login" ? homeForRole(role) : from;
  if (role === "admin") return path.startsWith("/v") || path.startsWith("/c") ? "/" : path;
  if (role === "vendor") return path === "/v" || path.startsWith("/v/") ? path : "/v";
  return path === "/c" || path.startsWith("/c/") ? path : "/c";
}
