-- migration-impact: expand
-- migration-window: online
-- Migration 20260923090100: scenario revisions are immutable.
--
-- A revision is the version a render, an evaluation or an export was made from. Until now that
-- was a convention: repair scripts rewrote canonical_content and ambient/traffic columns in
-- place, silently changing what old renders claim they rendered. This trigger rejects every
-- row change of simforge.revisions except three that do not change what the revision is:
--
--   1. a no-op (every column identical; idempotent upserts of copied rows);
--   2. created_by_user_id becoming NULL with nothing else changed (the ba_user
--      ON DELETE SET NULL action run by account deletion);
--   3. the one-time fill of the materialized-traffic group (materialized_traffic_artifact_id,
--      _sha256, _size_bytes, _source_input_digest) while all four are NULL and nothing else
--      changes: environment copies insert the revision first and bind its traffic artifact
--      after the artifact row exists (the two rows reference each other).
--
-- A content repair creates a new revision (next revision_number) instead. Deletes (document and
-- workspace cascades) are unaffected; workspace deletion has its own guard (20260923090000).
-- A future migration that must backfill a new column disables the trigger explicitly for its
-- statement (ALTER TABLE ... DISABLE TRIGGER / ENABLE TRIGGER), in review.
--
-- Adds one function and one trigger; changes no existing object or row.
-- Rollback: DROP TRIGGER simforge_revisions_immutable ON simforge.revisions;
--   DROP FUNCTION simforge.revisions_immutable();
--   (migrations/.inverse/20260923090100_revision_immutability.sql in SimCloud.)

BEGIN;

CREATE FUNCTION simforge.revisions_immutable() RETURNS trigger
LANGUAGE plpgsql AS $immutable$
DECLARE
  traffic_group CONSTANT TEXT[] := ARRAY[
    'materialized_traffic_artifact_id', 'materialized_traffic_sha256',
    'materialized_traffic_size_bytes', 'materialized_traffic_source_input_digest'];
  -- Generated columns (summary_*) are not computed yet in a BEFORE trigger's NEW; they derive
  -- from canonical_content, which is compared.
  derived CONSTANT TEXT[] := ARRAY(
    SELECT attname::text FROM pg_attribute
     WHERE attrelid = TG_RELID AND attgenerated <> '' AND attnum > 0 AND NOT attisdropped);
  old_row JSONB := to_jsonb(OLD) - derived;
  new_row JSONB := to_jsonb(NEW) - derived;
BEGIN
  IF new_row = old_row THEN
    RETURN NEW;
  END IF;
  IF NEW.created_by_user_id IS NULL
     AND (new_row - 'created_by_user_id') = (old_row - 'created_by_user_id') THEN
    RETURN NEW;
  END IF;
  IF OLD.materialized_traffic_artifact_id IS NULL AND OLD.materialized_traffic_sha256 IS NULL
     AND OLD.materialized_traffic_size_bytes IS NULL AND OLD.materialized_traffic_source_input_digest IS NULL
     AND (new_row - traffic_group) = (old_row - traffic_group) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = 'restrict_violation',
    MESSAGE = 'simforge_revision_immutable',
    DETAIL = format('revision %s (document %s, number %s) is immutable', OLD.id, OLD.document_id, OLD.revision_number),
    HINT = 'Create a new revision (next revision_number) with the repaired content instead of rewriting this one.';
END;
$immutable$;

CREATE TRIGGER simforge_revisions_immutable
  BEFORE UPDATE ON simforge.revisions
  FOR EACH ROW EXECUTE FUNCTION simforge.revisions_immutable();

COMMIT;
