# Scale notes

These notes record what was measured and what was deliberately not done. No query timings are claimed, because this workspace has no Postgres server to run `EXPLAIN` against.

## What the dashboard reads

`scan_daily` stores one row per day in the application time zone: total scans, and how many carried a behavioural flag (`rapid_repeat`, `implausible_travel`, `high_frequency`). A trigger on `scan_events` maintains it, and the migration backfills existing rows.

`dashboard_metrics` reads `scans_total` and `scans_today` from that rollup. `scan_activity_series` reads it too. "Today" is the configured time zone, not UTC, which is why the rollup day is computed with `app_settings.timezone`.

Product, unit, and suspicious-unit counts still read the source tables. Those tables are the catalogue, not the scan log.

## Pagination

Vendor scan history uses a keyset (`scanned_at`, `id`) and returns at most 100 rows per call. Admin shipment, discrepancy, and custody export lists are capped (200, 200, and 5,000). They are not keyset queries. That is acceptable while those lists are shipment headers rather than the scan log.

## Partitioning is deferred

`custody_events` and `scan_events` are not partitioned.

A time partition would have to include the partition key in every unique constraint that must hold globally. Both tables use `unique (unit_id, idempotency_key)` so a retried write cannot create a second event. Putting `occurred_at` or `scanned_at` into that key would let the same idempotency key succeed in two months. A hash partition on `unit_id` would keep the unique constraint, and it was not added because there is no measured plan showing that a single table is too slow.

Revisit partitioning when an `EXPLAIN (ANALYZE, BUFFERS)` on the vendor scan keyset and on custody-by-unit shows a sequential scan or an unacceptable buffer count at the intended volume. Until those numbers exist, a partition would only add operational cost.

## What was not benchmarked

No 100,000-row seed was loaded, and no `EXPLAIN` was captured. The targets in the Phase 2 spec (scan history, vendor "my scans", custody history, shipment lists) are design goals, not measured results.
