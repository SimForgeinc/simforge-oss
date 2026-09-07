import { NextRequest, NextResponse } from "next/server";
import { getMapAssetByIdFromDb } from "@/app/lib/db/map-asset-store";
import { refreshMapSearchIndex } from "@/app/lib/maps/search-index/refresh-search-index";
import { requireScenarioMutationOrigin } from "@/app/lib/scenario/http";

type RouteContext = { params: Promise<{ mapAssetId: string }> };

/**
 * Rebuild the `search_index.json` sidecar from the map's current metadata —
 * GeoJSON, XODR, candidate locations, and (if present) enrichment. Does NOT
 * re-run populate-metadata or candidate extraction, so it is safe to call
 * repeatedly. Returns the new object + edge counts so callers can confirm
 * the rebuild landed.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  try {
    const { mapAssetId } = await params;
    if (!mapAssetId?.trim()) {
      return NextResponse.json({ error: "Missing mapAssetId" }, { status: 400 });
    }
    const existing = await getMapAssetByIdFromDb(mapAssetId);
    if (!existing) {
      return NextResponse.json({ error: "Map asset not found" }, { status: 404 });
    }
    const result = await refreshMapSearchIndex(mapAssetId);
    return NextResponse.json({
      map_asset_id: mapAssetId,
      built_at: result.built_at,
      object_count: result.object_count,
      edge_count: result.edge_count,
      size_bytes: result.size_bytes,
      sha256: result.sha256,
      has_enrichment: result.has_enrichment,
    });
  } catch (error) {
    console.error("refresh-search-index error:", error);
    return NextResponse.json(
      {
        error: "Failed to refresh search index",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
