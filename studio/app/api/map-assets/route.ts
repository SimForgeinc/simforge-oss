import { connection, NextResponse, type NextRequest } from "next/server";
import { requireRouteSession } from "@/app/lib/auth/route-session";
import { getMapAssets } from "@/app/lib/map-assets";
import { MapAssetsListResponse } from "@/app/lib/api-schemas";
void MapAssetsListResponse; // referenced in JSDoc for OpenAPI

/**
 * List map assets
 * @description Returns the map assets catalog (S3 or mock fallback). Same data used by the dashboard maps list and map picker.
 * @response 200:MapAssetsListResponse
 * @responseSet common
 * @tag Map assets
 * @openapi
 */
export async function GET(request: NextRequest) {
  const access = await requireRouteSession(request);
  if (!access.ok) return access.response;
  await connection();
  const assets = await getMapAssets();
  return NextResponse.json(assets);
}
