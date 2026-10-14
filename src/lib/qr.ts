import QRCode from "qrcode";

export const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

/** QR target. The base URL comes from configuration, never hardcoded. */
export function trackingUrl(token: string, base: string = import.meta.env.VITE_PUBLIC_APP_URL ?? window.location.origin): string {
  return `${base.replace(/\/+$/, "")}/track/${token}`;
}

export const qrPngDataUrl = (url: string, width = 512) =>
  QRCode.toDataURL(url, { errorCorrectionLevel: "M", margin: 2, width });
export const qrSvg = (url: string) => QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 2 });

export function downloadDataUrl(dataUrl: string, filename: string) {
  const a = document.createElement("a");
  a.href = dataUrl; a.download = filename; a.click();
}
export function downloadText(text: string, filename: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  downloadDataUrl(url, filename);
  URL.revokeObjectURL(url);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface LabelItem { token: string; label: string; productName: string; batch?: string | null }

/** Opens a print dialog with one 50x30mm-style label per unit (QR + human-readable ID). */
export async function printLabels(items: LabelItem[]) {
  const cells = await Promise.all(items.map(async (i) => `
    <div class="l"><img src="${await qrPngDataUrl(trackingUrl(i.token), 300)}" alt="">
    <div class="t"><b>${esc(i.label)}</b><span>${esc(i.productName)}</span>${i.batch ? `<span>Batch ${esc(i.batch)}</span>` : ""}</div></div>`));
  const w = window.open("", "_blank", "width=900,height=700");
  if (!w) throw new Error("Allow pop-ups to print labels");
  w.document.write(`<!doctype html><title>Labels</title><style>
    body{margin:8mm;font-family:system-ui,sans-serif} .g{display:flex;flex-wrap:wrap;gap:4mm}
    .l{width:60mm;border:1px solid #999;padding:3mm;display:flex;gap:3mm;align-items:center;break-inside:avoid}
    .l img{width:26mm;height:26mm} .t{display:flex;flex-direction:column;font-size:9pt;gap:1mm;word-break:break-word}
    .t b{font-size:11pt;font-family:ui-monospace,monospace}
    @media print{body{margin:0}}</style><div class="g">${cells.join("")}</div>
    <script>window.onload=()=>setTimeout(()=>window.print(),200)</script>`);
  w.document.close();
}
