-- Migration 20260917120000: make variation-transfer receipts replayable and behavior-bearing.
-- Rollback: drop the columns, constraints, and replay index added below; restore the prior
-- acceptance CHECK accepting only pending_validation and rejected.

BEGIN;

ALTER TABLE simforge.variation_transfers
  ADD COLUMN IF NOT EXISTS source_topology_digest TEXT,
  ADD COLUMN IF NOT EXISTS target_topology_digest TEXT,
  ADD COLUMN IF NOT EXISTS source_closure_digest TEXT,
  ADD COLUMN IF NOT EXISTS target_closure_digest TEXT,
  ADD COLUMN IF NOT EXISTS compiler_version TEXT,
  ADD COLUMN IF NOT EXISTS matcher_version TEXT,
  ADD COLUMN IF NOT EXISTS solver_version TEXT,
  ADD COLUMN IF NOT EXISTS param_seed TEXT,
  ADD COLUMN IF NOT EXISTS draw_index INTEGER,
  ADD COLUMN IF NOT EXISTS input_hash TEXT,
  ADD COLUMN IF NOT EXISTS replay_key JSONB,
  ADD COLUMN IF NOT EXISTS replay_token TEXT,
  ADD COLUMN IF NOT EXISTS transfer_verdict TEXT,
  ADD COLUMN IF NOT EXISTS geometry_transfer TEXT,
  ADD COLUMN IF NOT EXISTS behavior_preservation TEXT,
  ADD COLUMN IF NOT EXISTS behavior_metrics JSONB,
  ADD COLUMN IF NOT EXISTS required_checks_passed BOOLEAN,
  ADD COLUMN IF NOT EXISTS identity_provenance TEXT;

DO $$
DECLARE
  doomed TEXT;
BEGIN
  -- PostgreSQL normalizes IN expressions in pg_get_constraintdef(), so identify the old CHECK by
  -- its constrained column rather than trying to match its rendered expression. Deliberately do
  -- not touch the independent structural `verdict` CHECK.
  FOR doomed IN
    SELECT c.conname
      FROM pg_constraint c
     WHERE c.conrelid = 'simforge.variation_transfers'::regclass
       AND c.contype = 'c'
       AND c.conkey IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM unnest(c.conkey) AS k(attnum)
           JOIN pg_attribute a
             ON a.attrelid = c.conrelid AND a.attnum = k.attnum
          WHERE a.attname = 'acceptance'
       )
  LOOP
    EXECUTE format('ALTER TABLE simforge.variation_transfers DROP CONSTRAINT %I', doomed);
  END LOOP;
END $$;

ALTER TABLE simforge.variation_transfers
  ADD CONSTRAINT simforge_variation_transfers_acceptance_check
    CHECK (acceptance IN (
      'pending_materialization', 'pending_validation', 'pending_simulation', 'accepted', 'rejected'
    )),
  ADD CONSTRAINT simforge_variation_transfers_transfer_verdict_check
    CHECK (transfer_verdict IS NULL OR transfer_verdict IN (
      'equivalent', 'adapted-equivalent', 'adapted-different', 'incompatible'
    )),
  ADD CONSTRAINT simforge_variation_transfers_geometry_check
    CHECK (geometry_transfer IS NULL OR geometry_transfer IN ('exact', 'adapted', 'failed')),
  ADD CONSTRAINT simforge_variation_transfers_behavior_check
    CHECK (behavior_preservation IS NULL OR behavior_preservation IN (
      'preserved', 'drift', 'changed', 'unmeasured'
    )),
  ADD CONSTRAINT simforge_variation_transfers_replay_token_check
    CHECK (replay_token IS NULL OR replay_token ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT simforge_variation_transfers_replay_key_check
    CHECK (replay_key IS NULL OR jsonb_typeof(replay_key) = 'object'),
  ADD CONSTRAINT simforge_variation_transfers_behavior_metrics_check
    CHECK (behavior_metrics IS NULL OR jsonb_typeof(behavior_metrics) = 'object');

CREATE INDEX IF NOT EXISTS simforge_variation_transfers_replay_idx
  ON simforge.variation_transfers (workspace_id, replay_token);

-- Known integrity gap: these constraints do not prove that a receipt's source_document_id agrees
-- with its target document's derived_from_document_id. Closing that gap requires a UNIQUE key on
-- simforge.documents(workspace_id, id, derived_from_document_id) and a composite receipt FK; that
-- cross-table lineage constraint is deliberately out of scope for this migration.

COMMIT;
