-- migration-impact: data migration (rewrites stored graphics levels)
-- migration-window: online; touches at most one setup row and any draft that
-- still names a removed graphics level.
--
-- The "roads-only" and "ultra-low-3d" (Low) graphics levels were removed: both
-- required per-release derivatives that no installed map ships, so selecting
-- one could only fail to load. Stored values are rewritten to the nearest
-- surviving level ("minimal", i.e. Balanced) here, at the source of truth,
-- rather than translated behind a compatibility alias at read time. The draft
-- CHECK constraint is then narrowed to the two levels that still exist.
--
-- Rollback: restore the previous CHECK listing all four ids. The rewritten
-- rows are not recoverable and do not need to be: the removed levels have no
-- runtime left to return to.
BEGIN;

UPDATE simforge.local_studio_setup
SET quality = 'minimal', updated_at = NOW()
WHERE quality IN ('roads-only', 'ultra-low-3d');

UPDATE simforge.drafts
SET authoring_quality_id = 'minimal'
WHERE authoring_quality_id IN ('roads-only', 'ultra-low-3d');

ALTER TABLE simforge.drafts
  DROP CONSTRAINT IF EXISTS uniscenario_drafts_authoring_quality_check;

ALTER TABLE simforge.drafts
  ADD CONSTRAINT uniscenario_drafts_authoring_quality_check
  CHECK (authoring_quality_id IS NULL OR authoring_quality_id IN ('minimal', 'high'));

COMMIT;
