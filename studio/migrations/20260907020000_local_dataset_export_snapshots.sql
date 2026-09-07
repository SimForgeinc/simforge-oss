-- Local dataset export lineage.
--
-- The broad dataset-export domain (review bundles, native archives, ODVG) runs
-- in-process in Studio. A snapshot is the immutable record of which artifacts an
-- export saw, so every job keeps its provenance even after the dataset changes.
--
-- Locally a dataset may be a scenario dataset (simforge.datasets) or a legacy
-- variation dataset (public.datasets); the snapshot therefore references the
-- dataset by id only and the application validates the owner.
BEGIN;

ALTER TABLE public.dataset_snapshots
  DROP CONSTRAINT IF EXISTS dataset_snapshots_dataset_id_fkey;

DO $$ BEGIN
  ALTER TABLE public.dataset_snapshots
    ADD CONSTRAINT dataset_snapshots_id_workspace_key UNIQUE (id, workspace_id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

-- Copied from upstream .archive/0044_canonical_artifacts_and_dataset_snapshots.sql.
CREATE TABLE IF NOT EXISTS public.dataset_snapshot_items (
  dataset_snapshot_id TEXT NOT NULL REFERENCES public.dataset_snapshots(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES public.artifacts(id) ON DELETE CASCADE,
  sample_key TEXT,
  sequence_id TEXT,
  split TEXT NOT NULL DEFAULT 'unsplit',
  role TEXT NOT NULL DEFAULT 'source',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (dataset_snapshot_id, artifact_id, role),
  CONSTRAINT dataset_snapshot_items_split_check CHECK (split IN ('train', 'val', 'test', 'unsplit')),
  CONSTRAINT dataset_snapshot_items_role_check
    CHECK (role IN ('source', 'label', 'calibration', 'metadata', 'manifest', 'publication'))
);
CREATE INDEX IF NOT EXISTS idx_dataset_snapshot_items_artifact
  ON public.dataset_snapshot_items (artifact_id);

-- Copied from upstream 20260809021000_uniscenario_dataset_snapshot_artifacts.sql,
-- addressed at the canonical simforge schema.
CREATE TABLE IF NOT EXISTS simforge.dataset_snapshot_artifact_links (
  dataset_snapshot_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL,
  render_job_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (dataset_snapshot_id, artifact_id),
  CONSTRAINT simforge_snapshot_artifact_snapshot_fk
    FOREIGN KEY (dataset_snapshot_id, workspace_id)
    REFERENCES public.dataset_snapshots(id, workspace_id)
    ON DELETE RESTRICT,
  CONSTRAINT simforge_snapshot_artifact_artifact_fk
    FOREIGN KEY (artifact_id, workspace_id)
    REFERENCES simforge.artifacts(id, workspace_id)
    ON DELETE RESTRICT,
  CONSTRAINT simforge_snapshot_artifact_render_job_fk
    FOREIGN KEY (render_job_id, workspace_id)
    REFERENCES simforge.render_jobs(id, workspace_id)
    ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS simforge_dataset_snapshot_artifacts_workspace_idx
  ON simforge.dataset_snapshot_artifact_links
  (workspace_id, dataset_snapshot_id, created_at, artifact_id);

CREATE OR REPLACE FUNCTION simforge.prevent_dataset_snapshot_artifact_link_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'dataset snapshot artifact links are immutable after creation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS simforge_dataset_snapshot_artifact_links_immutable
  ON simforge.dataset_snapshot_artifact_links;
CREATE TRIGGER simforge_dataset_snapshot_artifact_links_immutable
  BEFORE UPDATE OR DELETE ON simforge.dataset_snapshot_artifact_links
  FOR EACH ROW EXECUTE FUNCTION simforge.prevent_dataset_snapshot_artifact_link_mutation();

COMMIT;
