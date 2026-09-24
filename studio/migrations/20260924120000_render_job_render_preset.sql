-- migration-impact: expand
-- migration-window: online
-- Migration 20260924120000: a render job records the native render preset it
-- resolved to at submission (`training` or `showcase`). The request itself
-- (preset plus `RenderConfig` overrides) lives in the job's immutable intent
-- as `render`; the intent omits it for the default, so the column is the one
-- place the resolved preset is recorded for every native job.
--
-- EXPAND only: `render_preset` is added nullable with a CHECK added NOT VALID.
-- The previous release neither writes nor reads it, and a row it inserts
-- during the rollout keeps NULL (the detail view shows "not recorded").
-- Non-native jobs keep NULL: a preset is a native renderer setting.
--
-- Idempotent and table-guarded: the hosted platform applies this file from
-- two ledgers (its own migrations and the vendored studio migrations).
--
-- Rollback: migrations/.inverse/20260924120000_render_job_render_preset.sql
-- in simcloud-platform (drops the column; the previous release never reads it).
BEGIN;

ALTER TABLE IF EXISTS simforge.render_jobs
  ADD COLUMN IF NOT EXISTS render_preset TEXT;

DO $$
BEGIN
  -- to_regclass, never a ::regclass cast: a cast of a missing table raises
  -- even behind a false condition.
  IF to_regclass('simforge.render_jobs') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'render_jobs_render_preset_check'
        AND conrelid = to_regclass('simforge.render_jobs')
    )
  THEN
    ALTER TABLE simforge.render_jobs
      ADD CONSTRAINT render_jobs_render_preset_check
      CHECK (render_preset IS NULL OR render_preset IN ('showcase', 'training')) NOT VALID;
  END IF;
END
$$;

COMMIT;
