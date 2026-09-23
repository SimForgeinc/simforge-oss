-- Migration 20260820160000: record who removed a gallery asset, and when
-- migration-impact: contract
-- Rollback: ALTER TABLE asset_gallery.assets DROP CONSTRAINT asset_gallery_assets_removed_check,
--   DROP COLUMN removed_by_user_id, DROP COLUMN removed_at.
--
-- This migration also created a table for a hosted-only gallery feature. That
-- table now belongs to the hosted deployment's own migrations, so a fresh local
-- database no longer gets it. A database that already has it keeps it and its
-- rows untouched: nothing here drops data.

-- Deletion is open to any signed-in user, so record who did it. Soft delete
-- already keeps the row; without this the gallery could not answer "who removed
-- this and when", which is the minimum an open moderation policy needs.
ALTER TABLE asset_gallery.assets ADD COLUMN IF NOT EXISTS removed_by_user_id TEXT;
ALTER TABLE asset_gallery.assets ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;

-- Assets soft-deleted before this migration have no removal timestamp, and the
-- constraint below would reject them. `updated_at` is when the delete ran, so it
-- is the honest backfill; the actor is genuinely unknown and stays NULL.
UPDATE asset_gallery.assets
SET removed_at = updated_at
WHERE status = 'removed' AND removed_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'asset_gallery_assets_removed_check'
  ) THEN
    ALTER TABLE asset_gallery.assets
      ADD CONSTRAINT asset_gallery_assets_removed_check CHECK (
        status <> 'removed' OR removed_at IS NOT NULL
      );
  END IF;
END
$$;
