/**
 * Runtime provider for (re)building a map's `search_index.json` sidecar.
 *
 * Load current state of all inputs (GeoJSON + XODR from S3, candidates from
 * Aurora, Overture road segments from `map_asset_enrichments` when present),
 * call the pure builder, and upload the result to S3 with a `search_index`
 * artifact row registered on the map asset.
 *
 * The two explicit build points in the upload pipeline (post-metadata and
 * post-enrichment-callback) both funnel through this function. It is idempotent
 * and source-agnostic: if enrichment data has not landed yet, the sidecar is
 * built from static sources and will be rebuilt on the next call.
 *
 * A per-map build mutex serializes concurrent callers so two builds can't race
 * on the same S3 object.
 */

import { createHash } from "node:crypto";
import {
  buildMapSearchIndex,
  type BuildMapSearchIndexInput,
} from "./build-search-index";
import { buildOvertureCrosswalkCandidates } from "./overture-crosswalks";
import {
  uploadAndRegisterSearchIndex,
  type UploadSearchIndexResult,
} from "./upload-search-index";
import { getCandidateLocationsByMapAssetId } from "@/app/lib/db/map-candidate-location-store";
import { getAddressesByMapAssetId } from "@/app/lib/db/map-asset-address-store";
import {
  getMapArtifactLocation,
  getMapArtifactRevision,
  getMapAssetByIdFromDb,
} from "@/app/lib/db/map-asset-store";
import {
  getMapAssetEnrichmentById,
  getMapAssetRoadSegments,
} from "@/app/lib/db/map-asset-enrichment-store";
import { getS3ObjectUtf8 } from "@/app/lib/s3/s3-get-object";
import { extractPerJunctionInfo } from "@/app/lib/maps/metadata/xodr";

// ── Per-map build mutex ─────────────────────────────────────────────────────
// In-process Promise queue per map_asset_id. Two concurrent refreshes for the
// same map run sequentially, so the second sees the state the first wrote.
// Scale caveat: this protects a single Node instance only. Cross-instance
// races are not expected today (7 maps, ~human-triggered), but a Postgres
// advisory lock can be added later if needed.

const inflightBuilds = new Map<string, Promise<RefreshSearchIndexResult>>();

// ── Public API ──────────────────────────────────────────────────────────────

export interface RefreshSearchIndexResult extends UploadSearchIndexResult {
  has_enrichment: boolean;
  built_at: string;
  /** Count of entries in `graph.edges` in the just-built sidecar. */
  edge_count: number;
}

export async function refreshMapSearchIndex(
  mapAssetId: string,
): Promise<RefreshSearchIndexResult> {
  const existing = inflightBuilds.get(mapAssetId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      return await refreshMapSearchIndexInner(mapAssetId);
    } finally {
      inflightBuilds.delete(mapAssetId);
    }
  })();
  inflightBuilds.set(mapAssetId, promise);
  return promise;
}

async function refreshMapSearchIndexInner(
  mapAssetId: string,
): Promise<RefreshSearchIndexResult> {
  const [geojsonArtifact, xodrArtifact, rrdataArtifact] = await Promise.all([
    getMapArtifactRevision(mapAssetId, "geojson"),
    getMapArtifactRevision(mapAssetId, "xodr"),
    getMapArtifactRevision(mapAssetId, "rrdata_xml"),
  ]);

  if (!geojsonArtifact) {
    throw new Error(
      `refreshMapSearchIndex(${mapAssetId}): missing geojson artifact`,
    );
  }
  if (!xodrArtifact) {
    throw new Error(
      `refreshMapSearchIndex(${mapAssetId}): missing xodr artifact`,
    );
  }

  const [geojsonText, xodrText, candidates, enrichment, roadSegments, addresses, asset] =
    await Promise.all([
      getS3ObjectUtf8(geojsonArtifact.bucket, geojsonArtifact.key),
      getS3ObjectUtf8(xodrArtifact.bucket, xodrArtifact.key),
      getCandidateLocationsByMapAssetId(mapAssetId),
      getMapAssetEnrichmentById(mapAssetId),
      getMapAssetRoadSegments(mapAssetId),
      getAddressesByMapAssetId(mapAssetId),
      getMapAssetByIdFromDb(mapAssetId),
    ]);

  const xodrJunctionInfo = extractPerJunctionInfo(xodrText);

  // Backfill crosswalks from Overture where the in-house GeoJSON layer is
  // sparse. Overture features within 15 m
  // of an existing in-house crosswalk_zone are dropped so the in-house data
  // wins on overlap.
  const overtureCrosswalkLayer = enrichment?.overlay_payload?.layers.find(
    (l) => l.layer_id === "crosswalks",
  );
  const overtureCrosswalkCandidates = buildOvertureCrosswalkCandidates(
    mapAssetId,
    overtureCrosswalkLayer,
    candidates,
    xodrJunctionInfo.map((j) => ({
      junctionId: j.xodrJunctionId,
      center: j.centroid,
    })),
  );
  // Sidewalks follow the bus_stop pattern (snapshot candidate → populate
  // script → DB). The DB-loaded `candidates` array already carries any
  // `sidewalk_segment` rows the populate run produced, so the live-synthesis
  // path used by crosswalks isn't needed here. Maps where the populate script
  // hasn't run still surface sidewalks via the overlay_poi backstop in
  // `enrichmentToPoiDocuments`.
  const mergedCandidates = [...candidates, ...overtureCrosswalkCandidates];

  const input: BuildMapSearchIndexInput = {
    mapAssetId,
    geojsonText,
    xodrText,
    xodrJunctionInfo,
    candidates: mergedCandidates,
    roadSegments: roadSegments ?? undefined,
    addresses,
    countryCode: asset?.place_context?.country_code ?? null,
    sourceSignatures: {
      geojson_sha256: geojsonArtifact.sha256 ?? null,
      xodr_sha256: xodrArtifact.sha256 ?? null,
      rrdata_sha256: rrdataArtifact?.sha256 ?? null,
      candidates_revision: candidateRevisionSignature(mergedCandidates),
      enrichment_revision: enrichment?.computed_at ?? null,
    },
  };

  const index = buildMapSearchIndex(input);
  const uploaded = await uploadAndRegisterSearchIndex(mapAssetId, index);

  return {
    ...uploaded,
    has_enrichment: Boolean(enrichment),
    built_at: index.built_at,
    edge_count: index.graph.edges.length,
  };
}

/**
 * Precomputed-inputs variant: avoids a second round of S3 + DB reads when the
 * caller already fetched artifacts (e.g. the `complete` endpoint parsed the
 * GeoJSON and XODR text to compute stats). Skips artifact existence checks —
 * caller must pass the matching sha256s.
 */
export interface RefreshSearchIndexWithTextsInput {
  mapAssetId: string;
  geojsonText: string;
  xodrText: string;
  rrdataXmlText?: string | null;
  geojsonSha256?: string | null;
  xodrSha256?: string | null;
  rrdataSha256?: string | null;
}

export async function refreshMapSearchIndexWithTexts(
  args: RefreshSearchIndexWithTextsInput,
): Promise<RefreshSearchIndexResult> {
  const existing = inflightBuilds.get(args.mapAssetId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const [candidates, enrichment, roadSegments, addresses, asset] = await Promise.all([
        getCandidateLocationsByMapAssetId(args.mapAssetId),
        getMapAssetEnrichmentById(args.mapAssetId),
        getMapAssetRoadSegments(args.mapAssetId),
        getAddressesByMapAssetId(args.mapAssetId),
        getMapAssetByIdFromDb(args.mapAssetId),
      ]);

      const xodrJunctionInfo = extractPerJunctionInfo(args.xodrText);

      const overtureCrosswalkLayer = enrichment?.overlay_payload?.layers.find(
        (l) => l.layer_id === "crosswalks",
      );
      const overtureCrosswalkCandidates = buildOvertureCrosswalkCandidates(
        args.mapAssetId,
        overtureCrosswalkLayer,
        candidates,
        xodrJunctionInfo.map((j) => ({
          junctionId: j.xodrJunctionId,
          center: j.centroid,
        })),
      );
      const mergedCandidates = [
        ...candidates,
        ...overtureCrosswalkCandidates,
      ];

      const input: BuildMapSearchIndexInput = {
        mapAssetId: args.mapAssetId,
        geojsonText: args.geojsonText,
        xodrText: args.xodrText,
        xodrJunctionInfo,
        candidates: mergedCandidates,
        roadSegments: roadSegments ?? undefined,
        addresses,
        countryCode: asset?.place_context?.country_code ?? null,
        sourceSignatures: {
          geojson_sha256: args.geojsonSha256 ?? null,
          xodr_sha256: args.xodrSha256 ?? null,
          rrdata_sha256: args.rrdataSha256 ?? null,
          candidates_revision: candidateRevisionSignature(mergedCandidates),
          enrichment_revision: enrichment?.computed_at ?? null,
        },
      };

      const index = buildMapSearchIndex(input);
      const uploaded = await uploadAndRegisterSearchIndex(
        args.mapAssetId,
        index,
      );
      return {
        ...uploaded,
        has_enrichment: Boolean(enrichment),
        built_at: index.built_at,
        edge_count: index.graph.edges.length,
      };
    } finally {
      inflightBuilds.delete(args.mapAssetId);
    }
  })();
  inflightBuilds.set(args.mapAssetId, promise);
  return promise;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function candidateRevisionSignature(
  candidates: Array<{ id: string; updated_at?: string | null | undefined }>,
): string {
  // Cheap signature: count + max(updated_at). Changes whenever a row is added,
  // removed, or re-upserted with a new timestamp. Covers the common mutation
  // patterns without forcing a full-content hash.
  let max = "";
  for (const c of candidates) {
    const ts = typeof c.updated_at === "string" ? c.updated_at : "";
    if (ts && ts > max) max = ts;
  }
  const h = createHash("sha256")
    .update(`${candidates.length}:${max}`)
    .digest("hex")
    .slice(0, 16);
  return h;
}

/**
 * Convenience: is there already a stored search_index artifact for this map?
 * Callers that want "rebuild only if missing" can branch on this.
 */
export async function hasStoredSearchIndex(
  mapAssetId: string,
): Promise<boolean> {
  const loc = await getMapArtifactLocation(mapAssetId, "search_index");
  return loc != null;
}
