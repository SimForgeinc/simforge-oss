-- migration-impact: contract
-- migration-window: online
-- Migration 20260922150000: pin a draft's map closure digest and asset catalog.
-- A draft was already bound to one immutable map version (drafts.map_version_id),
-- but a revision commit re-resolved it to "today's compatible publication", and
-- nothing recorded which closure (topology, signals, colliders) or asset catalog
-- the draft was authored and simulated against. These columns pin both; a
-- revision records the pin it froze. docs/engineering/document-pinning.md.
-- Additive: nullable columns and FKs, plus a backfill of the pin each draft
-- resolves to now (the version it is already bound to). Immutable revisions are
-- not backfilled: their pin is unknown, and inventing one would be a lie.
-- The one-time document pin (simulation block + explicit ambient profile) is a
-- separate script, studio/scripts/pin-scenario-documents.ts, because it must
-- recompute content_sha256 with the TypeScript canonical serializer.
-- Rollback: drop the four constraints, then DROP COLUMN map_closure_sha256 and
-- asset_catalog_version_id from simforge.drafts and simforge.revisions (SimCloud
-- ships the same as migrations/.inverse/20260922150000_scenario_document_pinning.sql).

BEGIN;

ALTER TABLE simforge.drafts
  ADD COLUMN IF NOT EXISTS map_closure_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS asset_catalog_version_id TEXT;

ALTER TABLE simforge.revisions
  ADD COLUMN IF NOT EXISTS map_closure_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS asset_catalog_version_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'simforge_drafts_map_closure_sha256_check') THEN
    ALTER TABLE simforge.drafts ADD CONSTRAINT simforge_drafts_map_closure_sha256_check
      CHECK (map_closure_sha256 IS NULL OR map_closure_sha256 ~ '^[a-f0-9]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'simforge_revisions_map_closure_sha256_check') THEN
    ALTER TABLE simforge.revisions ADD CONSTRAINT simforge_revisions_map_closure_sha256_check
      CHECK (map_closure_sha256 IS NULL OR map_closure_sha256 ~ '^[a-f0-9]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'simforge_drafts_asset_catalog_version_fk') THEN
    ALTER TABLE simforge.drafts ADD CONSTRAINT simforge_drafts_asset_catalog_version_fk
      FOREIGN KEY (asset_catalog_version_id) REFERENCES simforge.asset_catalog_versions(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'simforge_revisions_asset_catalog_version_fk') THEN
    ALTER TABLE simforge.revisions ADD CONSTRAINT simforge_revisions_asset_catalog_version_fk
      FOREIGN KEY (asset_catalog_version_id) REFERENCES simforge.asset_catalog_versions(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- Backfill: every draft bound to a published version pins that version's
-- current closure and catalog. A draft whose version is retired or has no
-- available closure stays NULL and is refused at commit with an explicit error.
UPDATE simforge.drafts d
   SET map_closure_sha256 = bs.closure_sha256,
       asset_catalog_version_id = mv.asset_catalog_version_id
  FROM simforge.map_versions mv
  JOIN simforge.browser_asset_sets bs ON bs.id = mv.browser_asset_set_id
   AND bs.map_version_id = mv.id AND bs.asset_set_state = 'available'
 WHERE d.map_version_id = mv.id
   AND mv.retired_at IS NULL
   AND bs.closure_sha256 ~ '^[a-f0-9]{64}$'
   AND d.map_closure_sha256 IS NULL;

COMMIT;
