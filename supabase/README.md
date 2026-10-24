# Backend (Phase 1A): schema, security, public tracking boundary

## Layout
- `migrations/0001_schema.sql` tables, constraints, indexes, audit trigger
- `migrations/0002_functions_views.sql` admin RPCs, `public_lookup`, `record_scan`, metrics, map, views
- `migrations/0003_rls_grants.sql` RLS policies and least-privilege grants
- `migrations/0004_scan_place_fields.sql` reverse-geocoded place columns on `scan_events`, updated `record_scan` / `map_points`
- `migrations/0005_product_overview_place.sql` last-scan place labels on `product_overview`
- `migrations/0006_set_scan_place.sql` write-once `set_scan_place()` used to fill place labels after a scan is saved
- `migrations/0007_roles_enum.sql` adds `vendor` and `consumer` to `app_role` (nothing else; new values cannot be used in the same transaction)
- `migrations/0008_roles_users.sql` active flag, `viewer` → `consumer`, role-change guard, last-admin protection
- `migrations/0009_organizations.sql` organizations, membership, claim-code storage, admin user/org RPCs
- `migrations/0010_onboarding.sql` claim redemption, self-registration, staff invites, join codes, bulk import
- `migrations/0011_scan_attribution.sql` scanner on each scan, daily scan rollup, vendor scan/product reads
- `migrations/0012_supply_chain.sql` locations, shipments, custody events, discrepancies
- `migrations/0013_supply_map_aggregates.sql` supply-map reads aggregate in a subquery, then build JSON
- `functions/track-lookup`, `functions/track-scan` public tracking. A bearer token is optional and is verified on the server.
- `functions/onboarding` public registration and claim preview (`verify_jwt` false)
- `functions/claim`, `functions/org-admin`, `functions/custody-action`, `functions/admin-users` require a user JWT
- `tests/` SQL integration tests (RLS, tokens, scans, rules) and `run.sh`; Deno tests live in `functions/_shared/`

## Setup
1. Create a Supabase project. Apply migrations in order (`supabase db push`, or paste each file in the SQL editor).
2. Create your first admin: sign up a user, then in the SQL editor:
   `update public.profiles set role = 'admin' where id = '<auth user id>';`
   (New sign-ups are `consumer`. Admin is never self-service. A vendor role is granted only when an organization is approved or a claim code is redeemed.)
3. Set function secrets: `supabase secrets set ALLOWED_ORIGINS=https://your-domain.com IP_HASH_SECRET=$(openssl rand -hex 32)`
   For place names also set `GEOCODE_CONTACT_EMAIL=you@your-domain.com` and (recommended) `LOCATIONIQ_API_KEY=<free token from locationiq.com>`.
4. Deploy: `supabase functions deploy track-lookup track-scan admin-users onboarding claim org-admin custody-action`
   For vendor registration set `CAPTCHA_SECRET` (Turnstile or hCaptcha; `CAPTCHA_PROVIDER=turnstile` or `hcaptcha`). `CAPTCHA_DEV_BYPASS=on` skips it on a private demo only. `AUTO_CONFIRM_VENDOR_EMAIL=on` lets a new vendor sign in without an email confirmation.
5. Optional retention job (pg_cron): `select cron.schedule('purge-locations', '17 3 * * *', 'select public.purge_old_locations()');`

## Security model
| Actor | Can do |
|---|---|
| anon | Nothing directly. No table or function grants. |
| Public vendor | Calls the two Edge Functions, which use `service_role` to run `public_lookup` / `record_scan`. |
| authenticated consumer | Public scan result only, plus their own vendor application status. No catalogue, prices, or tokens. |
| authenticated vendor | Own scans (owners and managers see their organization's scans) through RPCs. No direct read of products, tokens, or prices. Custody only at an assigned location of an active organization. |
| authenticated admin | Read all tables; insert/update `products`; everything else through audited RPCs. |

- No DELETE policy on any table: products are archived, never deleted. `scan_events` is append-only (trigger blocks UPDATE/DELETE; only `purge_old_locations()` may null out coordinates).
- Admin-only columns are protected from mass assignment (`products_guard` trigger; RPCs use explicit column lists).
- Public payload allow-list (`public_lookup`): name, manufacturer, category, description, batch, mfg/expiry dates, expired flag, package fields, unit label, plus a scan count and first-scan time. **Not exposed:** internal IDs, SKU (unless the viewer is a vendor and `vendor_sees_sku` is on), price, token, creator. Provenance, when enabled, is location type, city, and date only.

## Token lifecycle
- 128-bit CSPRNG (`pgcrypto`), base64url, 22 chars, `UNIQUE` in the database. QR URL: `{VITE_PUBLIC_APP_URL}/track/{token}`.
- One `product_units` row per physical unit; serial numbers are per product. `add_units` appends more.
- **Rotate** (`rotate_unit_token`): same unit identity, new token; the old token moves to `revoked_tokens`, so scans of old labels are logged as attempts linked to that unit.
- **Revoke** (`revoke_unit`): lookups/scans return `revoked` and are logged.
- **Design decision (differs from my earlier plan):** tokens are stored in plaintext, readable by admins only, not hashed. Admins must be able to re-download and reprint a label later, which a hash cannot support. Trade-off: a database leak exposes usable tokens. Mitigations: RLS (admin only), rotation, service-role isolation. Hashing remains possible later if you move to "show once at creation".
- Tokens travel in POST bodies, never URLs of API calls. Logs and `rejected_attempts` keep only a 12-char SHA-256 fingerprint.
  (The browser URL `/track/{token}` is still the QR itself; the frontend must set `Referrer-Policy: no-referrer` and keep analytics off that route.)

## Scan rules (configurable in `app_settings`)
`rapid_repeat` (< `min_rescan_seconds`), `high_frequency` (> `frequency_max_scans` per window), `implausible_travel` (speed between consecutive GPS scans > `max_speed_kmh`, ignoring moves inside combined GPS accuracy), plus informational `low_accuracy` and `expired_product`. "Suspicious" views use only the first three. These are indicators for investigation, not proof of counterfeiting.

## Metric definitions
Boundaries use `app_settings.timezone` (default `Asia/Kolkata`). See the comment above `dashboard_metrics()`.

## Decisions
- SKU: duplicates allowed across batches; same SKU + batch is rejected (case-insensitive).
- `batches` table skipped for Phase 1: `batch_number` on `products` is enough.
- No-GPS scans are recorded by default (`allow_scan_without_gps = true`), clearly marked by `location_status`. Set it to false to require GPS.
- Idempotency: client sends a UUID per scan attempt and reuses it on retry.
- Place names: after a GPS scan is saved, `track-scan` reverse-geocodes in the background (`EdgeRuntime.waitUntil`) and fills `location_area` / `location_city` / `location_state` / `location_country` through the write-once `set_scan_place()`. Provider order: LocationIQ (if `LOCATIONIQ_API_KEY` is set), then public Nominatim. Public Nominatim may throttle or block requests from shared cloud servers, so a LocationIQ key is recommended for production. Failures are logged as `geocode_failed` with reasons such as `nominatim:http_403` (no coordinates in logs) and never affect the scan. Fill older scans with `node --env-file=.env.backfill scripts/backfill-places.mjs`. Place labels survive `purge_old_locations()`.

## Known limitations
- Browser GPS can be inaccurate or spoofed; a QR URL can be copied. A scan means "a device that had this URL reported this location", not authentication of the physical item.
- Rate limiting keys on a hash of `x-forwarded-for`; shared NATs share a bucket. Add a WAF/CDN limit in front for serious abuse.
- `product_overview` computes per-product aggregates with lateral joins; fine for tens of thousands of products, revisit (materialised view) beyond that.
- `app_settings.timezone` is not validated against the tz database on write.
- Product image upload (Storage) is deferred to the UI phase; `image_path` column exists.

## Testing
`tests/run.sh` applies migrations to a scratch Postgres (with minimal Supabase stubs) and runs the SQL and Deno tests.
These tests have not been run against a real Supabase project or the deployed Edge Functions; do a smoke test after deploying.
