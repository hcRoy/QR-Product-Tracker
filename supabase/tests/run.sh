#!/usr/bin/env bash
# Local backend test run against a throwaway Postgres (needs a reachable server and Deno).
# Usage: PGURL=postgres://postgres@localhost:5432 ./run.sh
set -euo pipefail
cd "$(dirname "$0")"
PGURL="${PGURL:-postgres://postgres@localhost:5432}"
psql "$PGURL/postgres" -qc 'drop database if exists qrt_test' -c 'create database qrt_test'
for f in 00_supabase_stubs.sql ../migrations/0001_schema.sql ../migrations/0002_functions_views.sql ../migrations/0003_rls_grants.sql ../migrations/0004_scan_place_fields.sql ../migrations/0005_product_overview_place.sql ../migrations/0006_set_scan_place.sql ../migrations/0007_roles_enum.sql ../migrations/0008_roles_users.sql ../migrations/0009_organizations.sql ../migrations/0010_onboarding.sql ../migrations/0011_scan_attribution.sql ../migrations/0012_supply_chain.sql ../migrations/0013_supply_map_aggregates.sql; do
  psql "$PGURL/qrt_test" -q -v ON_ERROR_STOP=1 -f "$f"
done
psql "$PGURL/qrt_test" -v ON_ERROR_STOP=1 -f 10_security_and_scans.test.sql 2>&1 | grep -E 'PASS|FAIL|ERROR'
psql "$PGURL/qrt_test" -v ON_ERROR_STOP=1 -f 20_roles_and_orgs.test.sql 2>&1 | grep -E 'PASS|FAIL|ERROR'
psql "$PGURL/qrt_test" -v ON_ERROR_STOP=1 -f 30_phase2.test.sql 2>&1 | grep -E 'PASS|FAIL|ERROR'
(cd ../functions && deno test --allow-env _shared/schemas_test.ts _shared/geocode_test.ts _shared/admin_schema_test.ts _shared/captcha_test.ts _shared/phase2_schema_test.ts)
