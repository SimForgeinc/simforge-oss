-- Bench runs use the existing local model-run ledger. The bench owns policy
-- lifecycle; scripted/Jev must not masquerade as registered checkpoints.
ALTER TABLE simforge.model_runs DROP CONSTRAINT model_runs_kind_check;
ALTER TABLE simforge.model_runs ADD CONSTRAINT model_runs_kind_check
  CHECK (kind IN ('openloop', 'policy_episode', 'artifact', 'drive_bench'));
ALTER TABLE simforge.model_runs ALTER COLUMN model_version_id DROP NOT NULL;
ALTER TABLE simforge.model_runs ALTER COLUMN endpoint_id DROP NOT NULL;
ALTER TABLE simforge.model_runs ADD CONSTRAINT model_runs_registry_shape_check CHECK (
  (kind = 'drive_bench' AND model_version_id IS NULL AND endpoint_id IS NULL)
  OR (kind <> 'drive_bench' AND model_version_id IS NOT NULL AND endpoint_id IS NOT NULL)
);
ALTER TABLE simforge.model_run_attempts ALTER COLUMN resolved_descriptor_json DROP NOT NULL;
