-- Studio runs the post-ingest map pipeline (detector candidate extraction and
-- the search_index.json rebuild) in-process. Record those runs alongside the
-- managed enrichment history under their own job type.
--
-- No BEGIN/COMMIT: a value added to an enum cannot be used inside the
-- transaction that adds it, and the migration runner executes this file as a
-- standalone script.
ALTER TYPE map_asset_enrichment_job_type ADD VALUE IF NOT EXISTS 'local_finalize';
