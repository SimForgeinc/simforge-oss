-- migration-impact: expand
-- migration-window: online
-- Migration 20260923140000: hifi previews render with one of the native
-- renderer's two presets (`showcase`, `training`) instead of a render profile
-- (`cinematic`, `sensor`). EXPAND half of an expand/contract pair: it only
-- adds, so the previous release (rc.75.1: writes and reads `profile` only)
-- keeps working against this schema.
--
-- * `preset` is added nullable, with a CHECK (showcase|training) added
--   NOT VALID: it holds for every row written from now on and is not
--   checked against existing rows (which have preset NULL, allowed anyway).
-- * `profile` stays, with its NOT NULL and its CHECK (cinematic|sensor)
--   unchanged. The new app writes BOTH columns (profile = the preset's old
--   name) and reads `preset`.
-- * No backfill here. A row with preset NULL (every row written before this
--   release, and any row rc.75.1 inserts during the rollout) is mapped by the
--   app with the single old-name mapping (sensor -> training, cinematic ->
--   showcase) and logged as `hifi_preview.legacy_profile_row`: a migration
--   shim with a test (studio/app/lib/hifi-preview/store.ts), not a fallback.
-- * CONTRACT half, the next release once this one is on every environment:
--   backfill preset from profile, VALIDATE the CHECK, preset NOT NULL, drop
--   `profile` and the shim. It is written already, outside the runner's
--   directory: migrations/.next-release/hifi_preview_drop_profile.sql.
--
-- Idempotent and table-guarded: the hosted platform applies this file from
-- two ledgers (its own migrations and the vendored studio migrations), and
-- the table exists only where the studio schema was applied.
--
-- Rollback: migrations/.inverse/20260923140000_hifi_preview_render_preset_expand.sql
-- in simcloud-platform (drops `preset`; rc.75.1 never reads it).
BEGIN;

ALTER TABLE IF EXISTS simforge.hifi_preview_requests
  ADD COLUMN IF NOT EXISTS preset TEXT;

DO $$
BEGIN
  -- to_regclass, never a ::regclass cast: a cast of a missing table raises
  -- even behind a false condition.
  IF to_regclass('simforge.hifi_preview_requests') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'hifi_preview_requests_preset_check'
        AND conrelid = to_regclass('simforge.hifi_preview_requests')
    )
  THEN
    ALTER TABLE simforge.hifi_preview_requests
      ADD CONSTRAINT hifi_preview_requests_preset_check
      CHECK (preset IS NULL OR preset IN ('showcase', 'training')) NOT VALID;
  END IF;
END
$$;

COMMIT;
