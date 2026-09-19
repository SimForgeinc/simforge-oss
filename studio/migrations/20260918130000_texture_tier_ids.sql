-- migration-impact: data migration (renames browser graphics tiers)
-- migration-window: online; setup and draft rows only
-- Rollback requires restoring the old CHECK and reversing low/medium ids.
BEGIN;
ALTER TABLE simforge.drafts
  DROP CONSTRAINT IF EXISTS uniscenario_drafts_authoring_quality_check;
UPDATE simforge.local_studio_setup
SET quality = CASE quality WHEN 'minimal' THEN 'low' WHEN 'high' THEN 'medium' END,
    updated_at = NOW()
WHERE quality IN ('minimal', 'high');
UPDATE simforge.drafts
SET authoring_quality_id = CASE authoring_quality_id WHEN 'minimal' THEN 'low' WHEN 'high' THEN 'medium' END
WHERE authoring_quality_id IN ('minimal', 'high');
ALTER TABLE simforge.drafts
  ADD CONSTRAINT uniscenario_drafts_authoring_quality_check
  CHECK (authoring_quality_id IS NULL OR authoring_quality_id IN ('low', 'medium'));
COMMIT;
