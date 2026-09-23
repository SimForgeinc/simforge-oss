-- migration-impact: contract
-- migration-window: online
-- Migration 20260923100000: renders replay a revision's ORIGINAL simulation; timelines are keyed by
-- sampler version.
--
-- * `revision_active_simulation` is the one mutable pointer from an immutable revision to the result
--   its renders replay. A commit sets it (reason 'commit'). Nothing moves it implicitly: an engine
--   change never re-points a revision, and re-simulating under a newer engine is an explicit action
--   that adds a `revision_simulations` row; moving the pointer ("use this simulation") is another
--   explicit action (reason 'user'). Backfill: each revision's 'commit' row; a revision that was only
--   ever re-simulated lazily points at its EARLIEST re-simulation with reason 'backfill-resimulated',
--   which the UI labels as re-simulated (its original motion exists only as the legacy OpenSCENARIO
--   export). A revision with no result has no pointer: rendering it fails with
--   `original_simulation_missing` until the user explicitly re-simulates it or asks for the legacy
--   OpenSCENARIO replay.
-- * `sim_timelines` holds render timelines keyed by `timeline_key` =
--   H(traceSha256, heightFieldDigest, catalogDigest, samplerVersion). A sampler bump derives a NEW row
--   from the stored trace; stored results and timelines are never mutated. Identity is
--   `timeline_sha256` = sha256(canonical JSON); `storage_encoding` records how the object is stored
--   ('identity' today; 'gzip' once render workers declare they accept it). Backfilled from the single
--   timeline column on `sim_results`, which stays as the timeline recorded at completion.
-- * `render_jobs.motion_source` records which motion a render replayed: 'original' (the revision's
--   active result), 'resimulated' (an explicitly chosen re-simulation) or 'original-xosc' (the
--   explicit legacy OpenSCENARIO replay for revisions with no stored trace). Null on jobs submitted
--   before this migration. `render_jobs.sim_key` now references `sim_results`.
-- Rollback: DROP TABLE simforge.sim_timelines, simforge.revision_active_simulation;
--   DROP FUNCTION simforge.sim_timelines_immutable();
--   ALTER TABLE simforge.render_jobs DROP CONSTRAINT simforge_render_jobs_sim_result_fk,
--   DROP CONSTRAINT simforge_render_jobs_motion_source_check, DROP COLUMN motion_source.

BEGIN;

CREATE TABLE IF NOT EXISTS simforge.revision_active_simulation (
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL,
  sim_key TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('commit', 'backfill-commit', 'backfill-resimulated', 'user')),
  set_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  set_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, revision_id),
  FOREIGN KEY (revision_id, workspace_id) REFERENCES simforge.revisions(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, sim_key) REFERENCES simforge.sim_results(workspace_id, sim_key)
);

INSERT INTO simforge.revision_active_simulation (workspace_id, revision_id, sim_key, reason, set_at)
SELECT DISTINCT ON (rs.workspace_id, rs.revision_id)
       rs.workspace_id, rs.revision_id, rs.sim_key,
       CASE WHEN rs.origin = 'commit' THEN 'backfill-commit' ELSE 'backfill-resimulated' END,
       rs.created_at
  FROM simforge.revision_simulations rs
 ORDER BY rs.workspace_id, rs.revision_id, (rs.origin = 'commit') DESC, rs.created_at ASC, rs.sim_key ASC
ON CONFLICT (workspace_id, revision_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS simforge.sim_timelines (
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  timeline_key TEXT NOT NULL CHECK (timeline_key ~ '^[a-f0-9]{64}$'),
  trace_sha256 TEXT NOT NULL CHECK (trace_sha256 ~ '^[a-f0-9]{64}$'),
  -- Null only on rows backfilled from sim_results, which never recorded it (it is in the document).
  height_field_digest TEXT CHECK (height_field_digest IS NULL OR length(height_field_digest) BETWEEN 1 AND 200),
  catalog_digest TEXT,
  sampler_version TEXT NOT NULL CHECK (length(sampler_version) BETWEEN 1 AND 100),
  timeline_sha256 TEXT NOT NULL CHECK (timeline_sha256 ~ '^[a-f0-9]{64}$'),
  -- Canonical JSON byte length: what the `render.timeline` render input declares.
  byte_length BIGINT NOT NULL CHECK (byte_length > 0),
  storage_bucket TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  storage_encoding TEXT NOT NULL DEFAULT 'identity' CHECK (storage_encoding IN ('identity', 'gzip')),
  stored_byte_length BIGINT NOT NULL CHECK (stored_byte_length > 0),
  stored_sha256 TEXT NOT NULL CHECK (stored_sha256 ~ '^[a-f0-9]{64}$'),
  -- The result the timeline was first derived for (any result with this trace shares it).
  source_sim_key TEXT NOT NULL,
  producer TEXT NOT NULL CHECK (length(producer) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, timeline_key),
  FOREIGN KEY (workspace_id, source_sim_key) REFERENCES simforge.sim_results(workspace_id, sim_key),
  CHECK (storage_encoding <> 'identity' OR (stored_sha256 = timeline_sha256 AND stored_byte_length = byte_length))
);
CREATE INDEX IF NOT EXISTS simforge_sim_timelines_trace_idx
  ON simforge.sim_timelines (workspace_id, trace_sha256, sampler_version);

CREATE OR REPLACE FUNCTION simforge.sim_timelines_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'simforge.sim_timelines rows are immutable (timeline_key %)', OLD.timeline_key;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS simforge_sim_timelines_immutable ON simforge.sim_timelines;
CREATE TRIGGER simforge_sim_timelines_immutable BEFORE UPDATE ON simforge.sim_timelines
  FOR EACH ROW EXECUTE FUNCTION simforge.sim_timelines_immutable();

-- Every timeline recorded so far was built by sampler 1 (`simforge.timeline-sampler/1`), the only
-- sampler that existed when `sim_results.timeline_*` was written. The height-field digest was not
-- recorded there (it is inside the stored document), so backfilled rows leave it null.
INSERT INTO simforge.sim_timelines (
  workspace_id, timeline_key, trace_sha256, height_field_digest, catalog_digest, sampler_version,
  timeline_sha256, byte_length, storage_bucket, storage_key, storage_encoding, stored_byte_length,
  stored_sha256, source_sim_key, producer, created_at
)
SELECT r.workspace_id, r.timeline_key, r.trace_sha256, NULL, NULL,
       'simforge.timeline-sampler/1', r.timeline_sha256, r.timeline_byte_length, r.storage_bucket,
       r.timeline_storage_key, 'identity', r.timeline_byte_length, r.timeline_sha256, r.sim_key,
       'backfill:sim_results', r.created_at
  FROM simforge.sim_results r
 WHERE r.timeline_key IS NOT NULL AND r.timeline_sha256 IS NOT NULL
   AND r.timeline_storage_key IS NOT NULL AND r.timeline_byte_length IS NOT NULL
ON CONFLICT (workspace_id, timeline_key) DO NOTHING;

ALTER TABLE simforge.render_jobs ADD COLUMN IF NOT EXISTS motion_source TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'simforge_render_jobs_motion_source_check') THEN
    ALTER TABLE simforge.render_jobs ADD CONSTRAINT simforge_render_jobs_motion_source_check CHECK (
      motion_source IS NULL OR motion_source IN ('original', 'resimulated', 'original-xosc')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'simforge_render_jobs_sim_result_fk') THEN
    ALTER TABLE simforge.render_jobs ADD CONSTRAINT simforge_render_jobs_sim_result_fk
      FOREIGN KEY (workspace_id, sim_key) REFERENCES simforge.sim_results(workspace_id, sim_key) NOT VALID;
  END IF;
END $$;
ALTER TABLE simforge.render_jobs VALIDATE CONSTRAINT simforge_render_jobs_sim_result_fk;

COMMIT;
