export type BulkState = "pending" | "ok" | "error";
export interface BulkItem { token: string; state: BulkState; message?: string }

/** One row per token. A retry replaces that token's row and leaves the others alone. */
export function upsertBulk(items: BulkItem[], token: string, state: BulkState, message?: string): BulkItem[] {
  const row: BulkItem = { token, state, message };
  const i = items.findIndex((x) => x.token === token);
  if (i < 0) return [...items, row];
  return items.map((x, n) => (n === i ? row : x));
}

export function summarizeBulk(items: BulkItem[]) {
  return {
    ok: items.filter((i) => i.state === "ok").length,
    error: items.filter((i) => i.state === "error").length,
    pending: items.filter((i) => i.state === "pending").length,
  };
}
