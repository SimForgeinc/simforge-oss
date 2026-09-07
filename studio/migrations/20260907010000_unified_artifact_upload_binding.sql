-- Keep one byte-length authority for checksum-bound artifact reservations.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM simforge.artifact_uploads
    WHERE expected_byte_length IS NOT NULL AND expected_size_bytes IS NOT NULL
      AND expected_byte_length <> expected_size_bytes
  ) THEN
    RAISE EXCEPTION 'artifact_upload_size_conflict';
  END IF;
END
$$;

UPDATE simforge.artifact_uploads
SET expected_size_bytes = expected_byte_length
WHERE expected_size_bytes IS NULL AND expected_byte_length IS NOT NULL;

-- Current readers and writers use simforge; the old SELECT * view pins the retired column.
DROP VIEW IF EXISTS uniscenario.artifact_uploads;

ALTER TABLE simforge.artifact_uploads
  DROP CONSTRAINT IF EXISTS uniscenario_artifact_uploads_binding_complete_check,
  DROP CONSTRAINT IF EXISTS uniscenario_artifact_uploads_expected_byte_length_check,
  ADD CONSTRAINT uniscenario_artifact_uploads_binding_complete_check
    CHECK ((expected_sha256 IS NULL) = (expected_size_bytes IS NULL)
       AND (expected_sha256 IS NULL) = (bound_at IS NULL)),
  DROP COLUMN expected_byte_length;

COMMIT;
