# Backend (Phase 1A): schema, security, public tracking boundary

## Layout
- `migrations/0001_schema.sql` tables, constraints, indexes, audit trigger
- `migrations/0002_functions_views.sql` admin RPCs, `public_lookup`, `record_scan`, metrics, map, views
- `migrations/0003_rls_grants.sql` RLS policies and least-privilege grants
- `functions/track-lookup`, `functions/track-scan` the only public (unauthenticated) endpoints
- `tests/` SQL integration tests (RLS, tokens, scans, rules) and `run.sh`; Deno tests live in `functions/_shared/`

## Setup
1. Create a Supabase project. Apply migrations in order (`supabase db push`, or paste each file in the SQL editor).
2. Create your first admin: sign up a user, then in the SQL editor:
   `update public.profiles set role = 'admin' where id = '<auth user id>';`
   (New sign-ups are always `viewer`; there is no self-service path to admin.)
3. Set function secrets: `supabase secrets set ALLOWED_ORIGINS=https://your-domain.com IP_HASH_SECRET=$(openssl rand -hex 32)`
4. Deploy: `supabase functions deploy track-lookup track-scan` (`config.toml` sets `verify_jwt = false` for both).
5. Optional retention job (pg_cron): `select cron.schedule('purge-locations', '17 3 * * *', 'select public.purge_old_locations()');`

## Security model
| Actor | Can do |
|---|---|
| anon | Nothing directly. No table or function grants. |
| Public vendor | Calls the two Edge Functions, which use `service_role` to run `public_lookup` / `record_scan`. |
| authenticated viewer | Nothing (RLS returns zero rows; RPCs raise `forbidden`). |
| authenticated admin | Read all tables; insert/update `products`; everything else through audited RPCs. |

- No DELETE policy on any table: products are archived, never deleted. `scan_events` is append-only (trigger blocks UPDATE/DELETE; only `purge_old_locations()` may null out coordinates).
- Admin-only columns are protected from mass assignment (`products_guard` trigger; RPCs use explicit column lists).
- Public payload allow-list (`public_lookup`): name, manufacturer, category, description, batch, mfg/expiry dates, expired flag, package fields, unit label. **Not exposed:** internal IDs, SKU, price, token, creator.

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

## Known limitations
- Browser GPS can be inaccurate or spoofed; a QR URL can be copied. A scan means "a device that had this URL reported this location", not authentication of the physical item.
- Rate limiting keys on a hash of `x-forwarded-for`; shared NATs share a bucket. Add a WAF/CDN limit in front for serious abuse.
- `product_overview` computes per-product aggregates with lateral joins; fine for tens of thousands of products, revisit (materialised view) beyond that.
- `app_settings.timezone` is not validated against the tz database on write.
- Product image upload (Storage) is deferred to the UI phase; `image_path` column exists.

## Testing
`tests/run.sh` applies migrations to a scratch Postgres (with minimal Supabase stubs) and runs the SQL and Deno tests.
These tests have not been run against a real Supabase project or the deployed Edge Functions; do a smoke test after deploying.
