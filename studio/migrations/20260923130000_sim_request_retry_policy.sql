-- migration-impact: expand
-- migration-window: online
-- Migration 20260923130000: a failed simulation request records the code it failed under, and
-- explicit user retries are counted.
--
-- A request key names the engine semantics, the engine build and the TypeScript pipeline revision,
-- so a change of those already makes a new request. A fix that lands elsewhere (an OSS release's
-- JavaScript) did not: a request that failed on a since-fixed bug stayed failed forever. The retry
-- policy (docs/engineering/simulation-results.md, "Failed requests") needs two facts per request:
--
--   failed_under_revision  the execution revision of the request's latest failure
--                          (`simulationExecutionRevision()`: pipeline, engine semantics, engine build,
--                          OSS release). A failed request whose revision differs from the resolving
--                          host's is requeued once with a fresh attempt budget; under the same revision
--                          it stays failed. NULL (every failure recorded before this migration, and any
--                          failure an rc.75.1 host records) counts as "an unknown, older revision",
--                          so those requests are retried once by the first rc.76 host that resolves them.
--   manual_retry_count     explicit user retries of the request (bounded by the application, 3); a retry
--                          beyond the bound is refused with `simulation_retry_limit_reached`.
--
-- Expand only: two added columns, one nullable and one with a constant default (metadata-only on
-- PostgreSQL 11+), no rewrite, no change to an existing column, constraint or row. rc.75.1 code
-- (N-1) neither reads nor writes them and keeps working.
-- Rollback: ALTER TABLE simforge.sim_requests DROP COLUMN manual_retry_count,
--   DROP COLUMN failed_under_revision;

BEGIN;

ALTER TABLE simforge.sim_requests
  ADD COLUMN IF NOT EXISTS failed_under_revision TEXT
    CHECK (failed_under_revision IS NULL OR length(failed_under_revision) BETWEEN 1 AND 500),
  ADD COLUMN IF NOT EXISTS manual_retry_count INTEGER NOT NULL DEFAULT 0
    CHECK (manual_retry_count >= 0);

COMMIT;
