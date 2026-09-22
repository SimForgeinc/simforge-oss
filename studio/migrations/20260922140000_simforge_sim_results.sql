-- migration-impact: additive (four new tables, three nullable render_jobs columns)
-- migration-window: online
-- Migration 20260922140000: content-addressed, worker-authoritative simulation results.
--
-- A simulation is a pure function `trace = simulate(resolvedInput, mapClosure, engineSemantics)`,
-- computed once by the host (inline in the API, or on a CPU runner) and replayed by every consumer.
--
-- * `sim_results` is the memo: one immutable row per `sim_key` =
--   H(resolvedInputDigest, mapClosureDigest, engineSemVer, solverVer, traceSchema). The trace lives at
--   `<workspace>/sim/sha256/<traceSha256>.trace.json.gz`. Build digests are provenance (`engine_build`),
--   never key material. A succeeded row never changes its trace: old revisions keep their original
--   traces after an engine change (decision 6); a re-simulation is a new key.
-- * `sim_requests` is the work item AND the in-flight join: one row per request key =
--   H(content sha, map version, map closure, catalog, engineSemVer, compiler). The first caller inserts
--   it (`ON CONFLICT DO NOTHING`) and executes under a fenced lease; every concurrent caller waits on
--   that row. Inline execution and the CPU runner claim the same row the same way, and an expired
--   lease is re-claimable, so a host that dies mid-run never strands the request.
-- * `revision_simulations` binds an immutable revision to the result it renders, per engineSemVer.
--   `origin = 'lazy'` marks a revision committed before (or under a different engine than) its result:
--   the UI shows it as re-simulated.
-- * `sim_verification_events` records the editor's local-trace comparison (a mismatch is a determinism bug).
-- Rollback: DROP TABLE simforge.sim_verification_events, simforge.revision_simulations,
--   simforge.sim_requests, simforge.sim_results; ALTER TABLE simforge.render_jobs DROP COLUMN sim_key,
--   DROP COLUMN trace_sha256, DROP COLUMN timeline_sha256.

BEGIN;

CREATE TABLE IF NOT EXISTS simforge.sim_results (
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  sim_key TEXT NOT NULL CHECK (sim_key ~ '^[a-f0-9]{64}$'),
  trace_sha256 TEXT NOT NULL CHECK (trace_sha256 ~ '^[a-f0-9]{64}$'),
  authored_trace_sha256 TEXT NOT NULL CHECK (authored_trace_sha256 ~ '^[a-f0-9]{64}$'),
  engine_sem_ver TEXT NOT NULL CHECK (length(engine_sem_ver) BETWEEN 1 AND 64),
  solver_ver TEXT NOT NULL CHECK (length(solver_ver) BETWEEN 1 AND 64),
  trace_schema TEXT NOT NULL CHECK (length(trace_schema) BETWEEN 1 AND 64),
  resolved_input_digest TEXT NOT NULL CHECK (resolved_input_digest ~ '^[a-f0-9]{64}$'),
  map_closure_digest TEXT NOT NULL CHECK (map_closure_digest ~ '^[a-f0-9]{64}$'),
  traffic_step_key TEXT CHECK (traffic_step_key IS NULL OR traffic_step_key ~ '^[a-f0-9]{64}$'),
  traffic_provider TEXT NOT NULL CHECK (traffic_provider IN ('off', 'native', 'sumo')),
  map_version_id TEXT NOT NULL,
  engine_build JSONB NOT NULL DEFAULT '{}'::jsonb,
  producer TEXT NOT NULL CHECK (length(producer) BETWEEN 1 AND 200),
  storage_bucket TEXT NOT NULL,
  trace_storage_key TEXT NOT NULL,
  trace_byte_length BIGINT NOT NULL CHECK (trace_byte_length > 0),
  trace_gzip_sha256 TEXT NOT NULL CHECK (trace_gzip_sha256 ~ '^[a-f0-9]{64}$'),
  -- The resolution record the export consumes instead of re-resolving (resolved input, ambient ids,
  -- materialization manifest): nothing downstream re-materializes traffic.
  resolution_storage_key TEXT NOT NULL,
  resolution_byte_length BIGINT NOT NULL CHECK (resolution_byte_length > 0),
  resolution_sha256 TEXT NOT NULL CHECK (resolution_sha256 ~ '^[a-f0-9]{64}$'),
  -- Server-derived materialized traffic bound to revisions (null only for SUMO without a worker step).
  traffic_artifact_id TEXT,
  ambient_provenance JSONB,
  -- Render timeline (WS-B contract), filled once when the timeline step has run.
  timeline_key TEXT CHECK (timeline_key IS NULL OR timeline_key ~ '^[a-f0-9]{64}$'),
  timeline_sha256 TEXT CHECK (timeline_sha256 IS NULL OR timeline_sha256 ~ '^[a-f0-9]{64}$'),
  timeline_storage_key TEXT,
  timeline_byte_length BIGINT,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, sim_key),
  FOREIGN KEY (traffic_artifact_id, workspace_id) REFERENCES simforge.artifacts(id, workspace_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS simforge_sim_results_trace_idx ON simforge.sim_results (workspace_id, trace_sha256);

-- A succeeded result is immutable except for the one-time timeline fill.
CREATE OR REPLACE FUNCTION simforge.sim_results_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.sim_key <> OLD.sim_key OR NEW.trace_sha256 <> OLD.trace_sha256
     OR NEW.authored_trace_sha256 <> OLD.authored_trace_sha256
     OR NEW.trace_storage_key <> OLD.trace_storage_key OR NEW.trace_gzip_sha256 <> OLD.trace_gzip_sha256
     OR NEW.resolution_sha256 <> OLD.resolution_sha256 OR NEW.engine_sem_ver <> OLD.engine_sem_ver
     OR NEW.resolved_input_digest <> OLD.resolved_input_digest OR NEW.map_closure_digest <> OLD.map_closure_digest
     OR (OLD.timeline_sha256 IS NOT NULL AND NEW.timeline_sha256 IS DISTINCT FROM OLD.timeline_sha256) THEN
    RAISE EXCEPTION 'simforge.sim_results rows are immutable (sim_key %)', OLD.sim_key;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS simforge_sim_results_immutable ON simforge.sim_results;
CREATE TRIGGER simforge_sim_results_immutable BEFORE UPDATE ON simforge.sim_results
  FOR EACH ROW EXECUTE FUNCTION simforge.sim_results_immutable();

CREATE TABLE IF NOT EXISTS simforge.sim_requests (
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL CHECK (request_key ~ '^[a-f0-9]{64}$'),
  request_state TEXT NOT NULL CHECK (request_state IN ('queued', 'running', 'succeeded', 'failed')),
  -- What to simulate: immutable content by digest on an immutable map version.
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  canonical_content JSONB NOT NULL,
  map_version_id TEXT NOT NULL,
  catalog_sha256 TEXT NOT NULL CHECK (catalog_sha256 ~ '^[a-f0-9]{64}$'),
  engine_sem_ver TEXT NOT NULL,
  sim_key TEXT CHECK (sim_key IS NULL OR sim_key ~ '^[a-f0-9]{64}$'),
  lease_owner TEXT,
  fence_token_sha256 TEXT,
  lease_expires_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  failure_code TEXT,
  failure_detail JSONB,
  requested_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, request_key),
  -- Map versions are global publications (20260807010000), not workspace rows.
  FOREIGN KEY (map_version_id) REFERENCES simforge.map_versions(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, sim_key) REFERENCES simforge.sim_results(workspace_id, sim_key) ON DELETE RESTRICT,
  CHECK ((request_state = 'succeeded') = (sim_key IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS simforge_sim_requests_claimable_idx
  ON simforge.sim_requests (request_state, lease_expires_at, created_at)
  WHERE request_state IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS simforge.revision_simulations (
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL,
  engine_sem_ver TEXT NOT NULL,
  sim_key TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('commit', 'lazy')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, revision_id, engine_sem_ver),
  FOREIGN KEY (revision_id, workspace_id) REFERENCES simforge.revisions(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, sim_key) REFERENCES simforge.sim_results(workspace_id, sim_key) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS simforge.sim_verification_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  sim_key TEXT NOT NULL,
  document_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('verified', 'mismatch')),
  local_trace_sha256 TEXT NOT NULL CHECK (local_trace_sha256 ~ '^[a-f0-9]{64}$'),
  authoritative_trace_sha256 TEXT NOT NULL CHECK (authoritative_trace_sha256 ~ '^[a-f0-9]{64}$'),
  local_runtime JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (workspace_id, sim_key) REFERENCES simforge.sim_results(workspace_id, sim_key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS simforge_sim_verification_mismatch_idx
  ON simforge.sim_verification_events (created_at DESC) WHERE outcome = 'mismatch';

ALTER TABLE simforge.render_jobs ADD COLUMN IF NOT EXISTS sim_key TEXT;
ALTER TABLE simforge.render_jobs ADD COLUMN IF NOT EXISTS trace_sha256 TEXT;
ALTER TABLE simforge.render_jobs ADD COLUMN IF NOT EXISTS timeline_sha256 TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'simforge_render_jobs_sim_identity_check') THEN
    ALTER TABLE simforge.render_jobs ADD CONSTRAINT simforge_render_jobs_sim_identity_check CHECK (
      (sim_key IS NULL OR sim_key ~ '^[a-f0-9]{64}$')
      AND (trace_sha256 IS NULL OR trace_sha256 ~ '^[a-f0-9]{64}$')
      AND (timeline_sha256 IS NULL OR timeline_sha256 ~ '^[a-f0-9]{64}$')
      AND ((sim_key IS NULL) = (trace_sha256 IS NULL))
    );
  END IF;
END $$;

COMMIT;
