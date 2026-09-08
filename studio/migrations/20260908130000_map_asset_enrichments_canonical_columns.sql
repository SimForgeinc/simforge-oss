-- Bring the local `map_asset_enrichments` table up to the row shape every
-- reader and writer in `app/lib/db/map-asset-enrichment-store.ts` expects.
--
-- The 0000 baseline created a three-column stub (map_asset_id, summary_json,
-- updated_at). The store, copied unchanged from upstream, selects and upserts
-- the canonical row that upstream migrations 0015, 0059 and 20260511120000
-- defined: provider / provider_release / computed_at / warnings_json /
-- road_segments_json plus the four S3 pointer columns. On a freshly
-- initialised data root every consumer of that store therefore failed with
-- `column "provider" does not exist` — map AI search, the enrichment routes,
-- the search-index rebuild and the editor bundle among them — before any row
-- could ever be written.
--
-- No local install can hold a row yet: the only writer is the store's upsert,
-- which named these columns and so could never succeed against the stub. The
-- NOT NULL columns are added exactly as upstream declares them.

ALTER TABLE public.map_asset_enrichments
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL,
  ADD COLUMN IF NOT EXISTS provider_release TEXT NOT NULL,
  ADD COLUMN IF NOT EXISTS computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS warnings_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS road_segments_json JSONB,
  ADD COLUMN IF NOT EXISTS overlay_geojson_s3_bucket TEXT,
  ADD COLUMN IF NOT EXISTS overlay_geojson_s3_key TEXT,
  ADD COLUMN IF NOT EXISTS candidate_locations_s3_bucket TEXT,
  ADD COLUMN IF NOT EXISTS candidate_locations_s3_key TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_map_asset_enrichments_provider_release
  ON public.map_asset_enrichments (provider, provider_release, computed_at DESC);
