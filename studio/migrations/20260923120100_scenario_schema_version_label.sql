-- migration-impact: contract
-- migration-window: online
-- Migration 20260923120100: normalize the scenario `schema_version` label to the decimal
-- scenarioVersion ("2").
--
-- The label is the stored document's scenarioVersion. Writers took it verbatim from clients, so
-- dev holds both "2" (4,308 drafts) and the long spelling "simforge.scenario.v2" (2 drafts); older
-- tooling also wrote "simforge.scenario/v2". The write path now normalizes it
-- (`writableScenarioSchemaVersionLabel`, @simforge-oss/scenario): both long spellings are stored
-- as "2" and any other label is a 400.
--
-- Data change: drafts and documents labelled "simforge.scenario.v2" or "simforge.scenario/v2" are
-- relabelled "2". Only the label changes: canonical_content, content_sha256 and draft_version are
-- untouched, so no simulation, digest or open editor is affected. simforge.revisions is NOT updated (revisions are
-- immutable); readers normalize its label (`normalizeScenarioSchemaVersionLabel`).
--
-- The check at the end fails the migration if a draft still carries a label other than "2": the
-- application reads the draft label (documentDto) and refuses unknown labels, so such a row needs
-- a human. documents.schema_version is relabelled too but not checked: nothing reads it.
-- Rollback: none needed. The old and new code both read "2"; relabelled rows cannot be told apart
--   afterwards, and restoring a long spelling would only reintroduce the inconsistency.

BEGIN;

UPDATE simforge.drafts
   SET schema_version = '2'
 WHERE schema_version IN ('simforge.scenario.v2', 'simforge.scenario/v2')
   AND canonical_content ->> 'scenarioVersion' = '2';

UPDATE simforge.documents
   SET schema_version = '2'
 WHERE schema_version IN ('simforge.scenario.v2', 'simforge.scenario/v2');

DO $$
DECLARE
  bad_drafts BIGINT;
BEGIN
  SELECT COUNT(*) INTO bad_drafts FROM simforge.drafts WHERE schema_version <> '2';
  IF bad_drafts > 0 THEN
    RAISE EXCEPTION 'scenario schema_version label: % draft(s) still carry a label other than ''2''; inspect them before migrating',
      bad_drafts;
  END IF;
END
$$;

COMMIT;
