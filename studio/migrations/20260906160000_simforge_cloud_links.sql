-- migration-impact: additive
-- migration-window: SimCloud working copies. A local dataset, document or
-- artifact that was imported from, or published to, a SimCloud workspace keeps
-- a link naming the upstream identity and the exact upstream version the local
-- copy last saw (draft version + canonical content digest). Publish fences on
-- that version so a remote edit the desktop has not seen becomes a conflict
-- instead of being overwritten; import fences on the local draft version so an
-- unsaved local edit is never silently replaced. Links carry no credentials and
-- no authored content, and deleting them never touches the local rows.
BEGIN;

CREATE TABLE IF NOT EXISTS simforge.cloud_dataset_links (
  local_dataset_id TEXT PRIMARY KEY REFERENCES simforge.datasets(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  cloud_origin TEXT NOT NULL CHECK (cloud_origin ~ '^https?://'),
  remote_workspace_id TEXT NOT NULL,
  remote_dataset_id TEXT NOT NULL,
  remote_dataset_name TEXT NOT NULL,
  last_imported_at TIMESTAMPTZ,
  last_published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS simforge_cloud_dataset_links_remote_idx
  ON simforge.cloud_dataset_links (workspace_id, cloud_origin, remote_workspace_id, remote_dataset_id);

CREATE TABLE IF NOT EXISTS simforge.cloud_document_links (
  local_document_id TEXT PRIMARY KEY REFERENCES simforge.documents(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  local_dataset_id TEXT NOT NULL REFERENCES simforge.cloud_dataset_links(local_dataset_id) ON DELETE CASCADE,
  remote_document_id TEXT NOT NULL,
  -- Upstream draft version and digest the local copy was last synchronized with.
  remote_draft_version BIGINT NOT NULL CHECK (remote_draft_version > 0),
  remote_content_sha256 TEXT NOT NULL CHECK (remote_content_sha256 ~ '^[a-f0-9]{64}$'),
  remote_latest_revision_id TEXT,
  -- Local draft version at that synchronization; a higher local version means unpublished edits.
  local_draft_version BIGINT NOT NULL CHECK (local_draft_version > 0),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (local_dataset_id, remote_document_id)
);

CREATE TABLE IF NOT EXISTS simforge.cloud_artifact_links (
  id TEXT PRIMARY KEY,
  local_artifact_id TEXT NOT NULL REFERENCES simforge.artifacts(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  cloud_origin TEXT NOT NULL CHECK (cloud_origin ~ '^https?://'),
  remote_workspace_id TEXT NOT NULL,
  remote_artifact_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('import', 'upload')),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One local artifact may be uploaded to several workspaces; within one workspace it is one object.
  UNIQUE (local_artifact_id, cloud_origin, remote_workspace_id),
  UNIQUE (workspace_id, cloud_origin, remote_workspace_id, remote_artifact_id)
);

COMMIT;
