-- migration-impact: additive (one new table)
-- migration-window: online
-- Migration 20260920120000: durable CPU worker liveness.
-- Worker presence used to live in the host process's memory, which says nothing on a hosted
-- deployment: every Lambda instance had its own map, so a worker that polled instance A was
-- invisible to the capabilities read served by instance B, and a host restart reported an
-- attached worker as gone. Presence is one row per worker, rewritten by every claim poll;
-- liveness is a time window over `last_seen_at`, so no history and no expiry job are needed.
-- This table is required on both the local and the hosted host: not local-only.
-- Rollback: DROP TABLE simforge.cpu_worker_presence.

BEGIN;

CREATE TABLE IF NOT EXISTS simforge.cpu_worker_presence (
  worker_id TEXT PRIMARY KEY,
  -- The engines the worker offered on its last poll, as a JSON array of strings.
  engines JSONB NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL
);

COMMIT;
