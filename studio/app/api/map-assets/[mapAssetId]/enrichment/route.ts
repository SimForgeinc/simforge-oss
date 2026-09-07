import { NextResponse } from "next/server";
import { getMapAssetEnrichmentManifest } from "@/app/lib/db/map-asset-enrichment-store";
import { mapAssetExistsInDb } from "@/app/lib/db/map-asset-store";

type RouteContext = { params: Promise<{ mapAssetId: string }> };

/**
 * Enrichment manifest for a map asset: snapshot metadata plus same-origin
 * URLs for the overlay GeoJSON and candidate-location payloads. 404 when no
 * enrichment snapshot has been stored for this map (local ingest never writes
 * one; imported maps that carry a snapshot serve it from the local store).
 */
export async function GET(_request: Request, { params }: RouteContext) {
  const { mapAssetId } = await params;
  if (!mapAssetId?.trim()) {
    return NextResponse.json({ error: "Missing mapAssetId" }, { status: 400 });
  }
  if (!(await mapAssetExistsInDb(mapAssetId))) {
    return NextResponse.json({ error: "Map asset not found" }, { status: 404 });
  }
  const manifest = await getMapAssetEnrichmentManifest(mapAssetId);
  if (!manifest) {
    return NextResponse.json({ error: "Enrichment not found" }, { status: 404 });
  }
  return NextResponse.json(manifest, { headers: { "Cache-Control": "private, no-store" } });
}
