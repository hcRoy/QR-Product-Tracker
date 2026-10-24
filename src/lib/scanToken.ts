import { TOKEN_RE } from "./qr";

/** Pulls a unit token out of a raw code, a tracking URL, or returns null for anything else. */
export function extractToken(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const fromUrl = text.match(/\/track\/([A-Za-z0-9_-]{22})(?=[/?#]|$)/);
  if (fromUrl && TOKEN_RE.test(fromUrl[1])) return fromUrl[1];
  return TOKEN_RE.test(text) ? text : null;
}
