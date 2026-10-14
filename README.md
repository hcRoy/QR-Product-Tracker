# QR Product Tracker (Phase 1)

Register products, generate one unique QR code per physical unit, let vendors scan with a phone browser (no app),
record the reported GPS location, and review everything in an admin dashboard.

Stack: Vite + React + TypeScript, Tailwind, TanStack Query, React Hook Form + Zod, Leaflet/OpenStreetMap,
Supabase (Auth, Postgres + RLS, Edge Functions). Backend details: [`supabase/README.md`](supabase/README.md).

## Local development
1. `npm install`
2. Copy `.env.example` to `.env` and fill `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_PUBLIC_APP_URL`.
   Only public values go here. The service-role key lives only inside Supabase Edge Functions.
3. Set up Supabase per `supabase/README.md` (migrations, first admin, function secrets, deploy functions).
4. `npm run dev`. Phones need HTTPS to share location: use a tunnel or a deployed preview, not plain `http://<lan-ip>`.

## Commands
`npm run typecheck` · `npm test` (frontend unit tests) · `npm run build` · `supabase/tests/run.sh` (SQL + Deno backend tests)

## Deployment
- Build: `npm run build`, deploy `dist/` to any static host over **HTTPS** (Vercel/Netlify/Cloudflare Pages).
  SPA rewrites are included (`vercel.json`, `public/_redirects`): `/track/*` must serve `index.html`.
- Set `VITE_PUBLIC_APP_URL` to the final public domain **before building**; it is baked into every QR code.
  Changing the domain later means reprinting labels (or keeping a redirect on the old domain).
- Supabase Auth, URL configuration: set Site URL to your domain and add it (and any preview URL) to Redirect URLs.
- Edge Function secret `ALLOWED_ORIGINS` must contain the same origin.
- Keep the `Referrer-Policy: no-referrer` header (set in `index.html` and `vercel.json`). Do not add analytics to `/track/*`.

## Admin onboarding
1. Create the user in Supabase Auth (email + password). 2. Promote in SQL:
`update public.profiles set role = 'admin' where id = '<user id>';` 3. Sign in at `/login`.
Disable open sign-ups in Supabase Auth settings unless you want them (new users get no access without promotion).

## QR labels
Product page → Units and QR codes → **QR** (PNG/SVG download, single label print) or **Print labels** (sheet).
Print at 100% scale (no "fit to page"), keep at least 20 mm QR width, and leave the quiet border. Each label carries a
human-readable unit ID (e.g. `B1-00001`) so a damaged code can be matched to its record. If a label is photographed
or leaked, use **Replace token** and reprint: the old code stops working and later scans of it are logged.

## Location troubleshooting (vendors)
- "Denied": allow Location for the site in browser settings (iOS: Settings → Privacy → Location Services → Safari Websites).
- "Unavailable"/"Timeout": enable device location, step outdoors/near a window, retry.
- "Unsupported": the page must be HTTPS; some in-app browsers (social apps) block geolocation. Open in Safari/Chrome.
- If GPS is refused the scan can still be recorded without location (configurable in Settings). It is clearly marked.

## What is implemented
Admin: login, dashboard (metrics, 30-day activity, status split, recent/suspicious scans, empty onboarding state),
products (server-side search/filter/pagination, create/edit/archive/restore), unit QR (PNG, SVG, print, add units, replace/revoke
token with audit reason), product detail with last reported location, scan history (all / suspicious / rejected attempts),
location map (CARTO basemap tiles — not OSM’s blocked public tile servers; filters, accuracy circles, detail panel), CSV reports, settings (rule thresholds, retention, time zone).
Vendor: mobile scan page with consent explanation, optional business reference, permission/timeout/offline/revoked states, safe retry.
Scan locations store GPS plus reverse-geocoded area/city/state/country (Nominatim, server-side at scan time).

## Known limitations and not done
- Not verified against a live Supabase project or on real phones; end-to-end (browser) tests are not written. Smoke-test after deploying.
- UI uses small in-repo Tailwind components, not shadcn/ui. No marker clustering (map caps at 2,000 newest points). Charts are plain SVG.
- Product image upload is not built (column reserved). "Print labels" prints the current 50-unit page.
- The entry bundle (~197 kB gzip) includes the admin app; only the scan page and map are split out.
- GPS can be inaccurate or spoofed and a QR URL can be copied: a scan is a reported location, not proof of authenticity.
- Planned (not in Phase 1): authenticated vendor accounts, verified handovers, inventory confirmation.
