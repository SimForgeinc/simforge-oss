-- migration-impact: contract
-- migration-window: online
-- Migration 20260923120000: every simulation a revision ever had is kept as an append-only history;
-- a draft remembers the result it last showed.
--
-- Follows 20260923100000 (renders replay `revision_active_simulation`, the one mutable pointer).
--
-- * `revision_simulations` becomes the append-only history of a revision's simulations. Its identity is
--   (workspace_id, revision_id, sim_key) (unique here; it becomes the primary key in the contract
--   migration that also drops `origin`). New columns:
--     reason              commit | engine_upgrade | resimulate | import | backfill (replaces `origin`)
--     created_by_user_id  who asked for it (null for commits by deleted users and for backfill)
--     previous_sim_key    the entry it was compared against (the revision's active result at the time)
--     motion_diff         `simforge.simulation-diff/v1`: per-tick motion, events and signals plus the
--                         strict-trajectory-v1 verdict (packages/openscenario trace-diff) vs previous_sim_key
--   Expand window: rc.73 writers insert `origin` only and conflict on (revision, engine_sem_ver); a BEFORE
--   INSERT trigger derives `reason` from `origin` (and `origin` from `reason` for new writers), and the
--   (revision, engine_sem_ver) primary key stays until the contract migration.
--   A BEFORE UPDATE OR DELETE trigger makes rows append-only. It allows exactly: a revision or workspace
--   cascade (the parent row is already gone), `created_by_user_id` becoming NULL (account deletion), and
--   the one-time fill of a NULL `motion_diff` (diffs of backfilled rows are computed after the fact).
-- * `drafts.last_sim_key` / `last_sim_draft_version`: the authoritative result the draft last showed, and
--   the draft version it was computed for. The editor's engine-change banner compares it with the
--   current engine's result, and "Keep the old motion" freezes it into a revision. Backfilled from the
--   newest succeeded request for the draft's exact content and map version.
-- * `sim_motion_diffs`: a memo of motion comparisons between two results (pure cache, cascades with
--   either result).
-- * `revisions.created_for` (render | save | engine_upgrade | import | map_move: the state saved
--   before a draft moved to another map version), `label`, `engine_sem_ver` and
--   `oss_release`: what the Versions panel shows. Existing revisions were all cut at render submit.
--   Adding columns does not fire the revision immutability trigger.
-- * Indexes for the reachability GC (draft-cache results after 90 days, requests after 30 days,
--   verification events after 90 days).
-- Rollback: migrations/.inverse/20260923120000_simulation_history.sql in SimCloud (drops the triggers,
--   functions, sim_motion_diffs, the new columns and indexes; the `revision_simulations.origin` column
--   is still written, so rc.73 code keeps working).

BEGIN;

-- ── revision_simulations: append-only history ────────────────────────────────────────────────

ALTER TABLE simforge.revision_simulations ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE simforge.revision_simulations
  ADD COLUMN IF NOT EXISTS created_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL;
ALTER TABLE simforge.revision_simulations ADD COLUMN IF NOT EXISTS previous_sim_key TEXT;
ALTER TABLE simforge.revision_simulations ADD COLUMN IF NOT EXISTS motion_diff JSONB;

-- Every row so far: 'commit' rows were authored; 'lazy' rows are implicit re-simulations under a newer
-- engine, which the history labels as backfilled.
UPDATE simforge.revision_simulations
   SET reason = CASE origin WHEN 'commit' THEN 'commit' ELSE 'backfill' END
 WHERE reason IS NULL;

-- Each backfilled row is compared against the row before it (by creation time) on the same revision.
UPDATE simforge.revision_simulations rs
   SET previous_sim_key = ordered.previous_sim_key
  FROM (
    SELECT workspace_id, revision_id, sim_key,
           LAG(sim_key) OVER (PARTITION BY workspace_id, revision_id ORDER BY created_at, sim_key) AS previous_sim_key
      FROM simforge.revision_simulations
  ) ordered
 WHERE rs.workspace_id = ordered.workspace_id AND rs.revision_id = ordered.revision_id
   AND rs.sim_key = ordered.sim_key AND ordered.previous_sim_key IS NOT NULL
   AND rs.previous_sim_key IS NULL;

ALTER TABLE simforge.revision_simulations ALTER COLUMN reason SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'simforge_revision_simulations_reason_check') THEN
    ALTER TABLE simforge.revision_simulations ADD CONSTRAINT simforge_revision_simulations_reason_check
      CHECK (reason IN ('commit', 'engine_upgrade', 'resimulate', 'import', 'backfill'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'simforge_revision_simulations_previous_check') THEN
    ALTER TABLE simforge.revision_simulations ADD CONSTRAINT simforge_revision_simulations_previous_check
      CHECK (previous_sim_key IS NULL OR (previous_sim_key ~ '^[a-f0-9]{64}$' AND previous_sim_key <> sim_key));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'simforge_revision_simulations_diff_check') THEN
    ALTER TABLE simforge.revision_simulations ADD CONSTRAINT simforge_revision_simulations_diff_check
      CHECK (motion_diff IS NULL OR (previous_sim_key IS NOT NULL AND jsonb_typeof(motion_diff) = 'object'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'simforge_revision_simulations_previous_fk') THEN
    ALTER TABLE simforge.revision_simulations ADD CONSTRAINT simforge_revision_simulations_previous_fk
      FOREIGN KEY (workspace_id, previous_sim_key) REFERENCES simforge.sim_results(workspace_id, sim_key) NOT VALID;
  END IF;
END $$;
ALTER TABLE simforge.revision_simulations VALIDATE CONSTRAINT simforge_revision_simulations_previous_fk;

-- The history identity. The (revision, engine_sem_ver) primary key stays for the expand window.
CREATE UNIQUE INDEX IF NOT EXISTS simforge_revision_simulations_history_key
  ON simforge.revision_simulations (workspace_id, revision_id, sim_key);
-- Reachability: "is this result referenced by any history row?"
CREATE INDEX IF NOT EXISTS simforge_revision_simulations_sim_key_idx
  ON simforge.revision_simulations (workspace_id, sim_key);

-- Expand window: old writers name only `origin`, new writers only `reason`.
CREATE OR REPLACE FUNCTION simforge.revision_simulations_reason_compat() RETURNS trigger AS $$
BEGIN
  IF NEW.reason IS NULL THEN
    NEW.reason := CASE NEW.origin WHEN 'commit' THEN 'commit' ELSE 'resimulate' END;
  END IF;
  IF NEW.origin IS NULL THEN
    NEW.origin := CASE NEW.reason WHEN 'commit' THEN 'commit' ELSE 'lazy' END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS simforge_revision_simulations_reason_compat ON simforge.revision_simulations;
CREATE TRIGGER simforge_revision_simulations_reason_compat BEFORE INSERT ON simforge.revision_simulations
  FOR EACH ROW EXECUTE FUNCTION simforge.revision_simulations_reason_compat();

CREATE OR REPLACE FUNCTION simforge.revision_simulations_append_only() RETURNS trigger AS $$
DECLARE
  old_row JSONB;
  new_row JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A revision or workspace cascade: the parent is already gone when the RI action runs.
    IF NOT EXISTS (SELECT 1 FROM simforge.revisions r WHERE r.id = OLD.revision_id AND r.workspace_id = OLD.workspace_id)
       OR NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = OLD.workspace_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION USING
      ERRCODE = 'restrict_violation',
      MESSAGE = 'simforge_revision_simulation_append_only',
      DETAIL = format('revision %s keeps its simulation %s: history rows are never deleted', OLD.revision_id, OLD.sim_key),
      HINT = 'Move the revision''s active simulation instead (revision_active_simulation).';
  END IF;
  old_row := to_jsonb(OLD);
  new_row := to_jsonb(NEW);
  IF new_row = old_row THEN
    RETURN NEW;
  END IF;
  IF NEW.created_by_user_id IS NULL
     AND (new_row - 'created_by_user_id') = (old_row - 'created_by_user_id') THEN
    RETURN NEW;
  END IF;
  IF OLD.motion_diff IS NULL AND NEW.motion_diff IS NOT NULL
     AND (new_row - 'motion_diff') = (old_row - 'motion_diff') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = 'restrict_violation',
    MESSAGE = 'simforge_revision_simulation_append_only',
    DETAIL = format('revision %s simulation %s is history and cannot change', OLD.revision_id, OLD.sim_key),
    HINT = 'Append a new row (re-simulate) or move revision_active_simulation.';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS simforge_revision_simulations_append_only ON simforge.revision_simulations;
CREATE TRIGGER simforge_revision_simulations_append_only BEFORE UPDATE OR DELETE ON simforge.revision_simulations
  FOR EACH ROW EXECUTE FUNCTION simforge.revision_simulations_append_only();

-- ── drafts: the result the draft last showed ─────────────────────────────────────────────────

ALTER TABLE simforge.drafts ADD COLUMN IF NOT EXISTS last_sim_key TEXT;
ALTER TABLE simforge.drafts ADD COLUMN IF NOT EXISTS last_sim_draft_version BIGINT;
ALTER TABLE simforge.drafts ADD COLUMN IF NOT EXISTS last_sim_at TIMESTAMPTZ;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'simforge_drafts_last_sim_check') THEN
    ALTER TABLE simforge.drafts ADD CONSTRAINT simforge_drafts_last_sim_check CHECK (
      (last_sim_key IS NULL AND last_sim_draft_version IS NULL AND last_sim_at IS NULL)
      OR (last_sim_key ~ '^[a-f0-9]{64}$' AND last_sim_draft_version > 0 AND last_sim_at IS NOT NULL)
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'simforge_drafts_last_sim_fk') THEN
    ALTER TABLE simforge.drafts ADD CONSTRAINT simforge_drafts_last_sim_fk
      FOREIGN KEY (workspace_id, last_sim_key) REFERENCES simforge.sim_results(workspace_id, sim_key) NOT VALID;
  END IF;
END $$;

-- The newest succeeded authoritative result for each draft's exact content on its pinned map version.
UPDATE simforge.drafts d
   SET last_sim_key = latest.sim_key,
       last_sim_draft_version = d.draft_version,
       last_sim_at = latest.completed_at
  FROM (
    SELECT DISTINCT ON (q.workspace_id, q.content_sha256, q.map_version_id)
           q.workspace_id, q.content_sha256, q.map_version_id, q.sim_key,
           COALESCE(q.completed_at, q.updated_at) AS completed_at
      FROM simforge.sim_requests q
     WHERE q.request_state = 'succeeded' AND q.sim_key IS NOT NULL
     ORDER BY q.workspace_id, q.content_sha256, q.map_version_id, COALESCE(q.completed_at, q.updated_at) DESC, q.sim_key
  ) latest
 WHERE d.workspace_id = latest.workspace_id AND d.content_sha256 = latest.content_sha256
   AND d.map_version_id = latest.map_version_id AND d.last_sim_key IS NULL;

ALTER TABLE simforge.drafts VALIDATE CONSTRAINT simforge_drafts_last_sim_check;
ALTER TABLE simforge.drafts VALIDATE CONSTRAINT simforge_drafts_last_sim_fk;
CREATE INDEX IF NOT EXISTS simforge_drafts_last_sim_key_idx
  ON simforge.drafts (workspace_id, last_sim_key) WHERE last_sim_key IS NOT NULL;

-- ── sim_motion_diffs: memo of motion comparisons ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS simforge.sim_motion_diffs (
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  base_sim_key TEXT NOT NULL,
  candidate_sim_key TEXT NOT NULL,
  profile TEXT NOT NULL CHECK (length(profile) BETWEEN 1 AND 100),
  diff JSONB NOT NULL CHECK (jsonb_typeof(diff) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, base_sim_key, candidate_sim_key, profile),
  FOREIGN KEY (workspace_id, base_sim_key) REFERENCES simforge.sim_results(workspace_id, sim_key) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, candidate_sim_key) REFERENCES simforge.sim_results(workspace_id, sim_key) ON DELETE CASCADE,
  CHECK (base_sim_key <> candidate_sim_key)
);
CREATE INDEX IF NOT EXISTS simforge_sim_motion_diffs_candidate_idx
  ON simforge.sim_motion_diffs (workspace_id, candidate_sim_key);

-- ── revisions: what the Versions panel shows ─────────────────────────────────────────────────

ALTER TABLE simforge.revisions ADD COLUMN IF NOT EXISTS created_for TEXT NOT NULL DEFAULT 'render';
ALTER TABLE simforge.revisions ADD COLUMN IF NOT EXISTS label TEXT;
ALTER TABLE simforge.revisions ADD COLUMN IF NOT EXISTS engine_sem_ver TEXT;
ALTER TABLE simforge.revisions ADD COLUMN IF NOT EXISTS oss_release TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'simforge_revisions_created_for_check') THEN
    ALTER TABLE simforge.revisions ADD CONSTRAINT simforge_revisions_created_for_check
      CHECK (created_for IN ('render', 'save', 'engine_upgrade', 'import', 'map_move')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'simforge_revisions_label_check') THEN
    ALTER TABLE simforge.revisions ADD CONSTRAINT simforge_revisions_label_check
      CHECK (label IS NULL OR length(btrim(label)) BETWEEN 1 AND 120) NOT VALID;
  END IF;
END $$;
ALTER TABLE simforge.revisions VALIDATE CONSTRAINT simforge_revisions_created_for_check;
ALTER TABLE simforge.revisions VALIDATE CONSTRAINT simforge_revisions_label_check;

-- ── Retention indexes ────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS simforge_sim_results_created_idx ON simforge.sim_results (created_at);
CREATE INDEX IF NOT EXISTS simforge_sim_requests_completed_idx
  ON simforge.sim_requests (completed_at) WHERE request_state IN ('succeeded', 'failed');
CREATE INDEX IF NOT EXISTS simforge_sim_requests_sim_key_idx
  ON simforge.sim_requests (workspace_id, sim_key) WHERE sim_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS simforge_sim_verification_events_created_idx
  ON simforge.sim_verification_events (created_at);
CREATE INDEX IF NOT EXISTS simforge_render_jobs_sim_key_idx
  ON simforge.render_jobs (workspace_id, sim_key) WHERE sim_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS simforge_revision_active_simulation_sim_key_idx
  ON simforge.revision_active_simulation (workspace_id, sim_key);

COMMIT;
