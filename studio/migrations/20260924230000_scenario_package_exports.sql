-- migration-impact: contract
-- migration-window: online
-- Migration 20260924230000: "Export for CLI" (docs/engineering/scenario-package.md).
--
-- simforge.scenario_package_exports records every scenario-package export: the
-- package id and manifest (identity), the form, and for the full form the
-- background job's state and the stored container. Containers are disposable
-- caches (R7): a row whose object has expired is re-exported, never repaired.
--
-- simforge.installation_identity holds `provenance.installationId`: one random
-- UUID per installation (database), generated on the first export. It is
-- never derived from a host, bucket or tenant.
--
-- Two new tables only; the previous release neither reads nor writes them. Declared
-- `contract` because the classifier rates a CREATE TABLE with foreign keys as contract.
-- Idempotent: the hosted platform applies this file from two ledgers.
--
-- Rollback: migrations/.inverse/20260924230000_scenario_package_exports.sql
-- in simcloud-platform (drops both tables; nothing else references them).
BEGIN;

CREATE TABLE IF NOT EXISTS simforge.installation_identity (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  installation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS simforge.scenario_package_exports (
  id TEXT PRIMARY KEY CHECK (id ~ '^uspkg_[A-Za-z0-9]{8,64}$'),
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL,
  form TEXT NOT NULL CHECK (form IN ('thin', 'full')),
  -- Full form only: whether the map's texture members are embedded.
  textures TEXT CHECK (textures IS NULL OR textures IN ('include', 'exclude')),
  export_state TEXT NOT NULL CHECK (export_state IN ('queued', 'building', 'succeeded', 'failed')),
  package_id TEXT NOT NULL CHECK (package_id ~ '^[a-f0-9]{64}$'),
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  manifest JSONB NOT NULL,
  -- What the export dialog shows (title, revision, engine, map, actors, sizes).
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  receipt JSONB,
  estimated_byte_length BIGINT,
  storage_bucket TEXT,
  storage_key TEXT,
  byte_length BIGINT,
  sha256 TEXT CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  error_code TEXT,
  error_detail TEXT,
  created_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  FOREIGN KEY (revision_id, workspace_id) REFERENCES simforge.revisions(id, workspace_id) ON DELETE CASCADE,
  CHECK (export_state <> 'succeeded' OR (storage_key IS NOT NULL AND byte_length IS NOT NULL AND sha256 IS NOT NULL)),
  CHECK (export_state <> 'failed' OR error_code IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS simforge_scenario_package_exports_revision_idx
  ON simforge.scenario_package_exports (workspace_id, revision_id, created_at DESC);

COMMIT;
