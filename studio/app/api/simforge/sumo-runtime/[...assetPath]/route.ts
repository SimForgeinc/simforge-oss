import { authorizeLocalMapAssetUrl, MapAccessError } from "@/app/lib/cloud/access";
import { type NextRequest, NextResponse } from "next/server";
import { AssetUrlServiceError, normalizeAssetKey } from "@/app/lib/assets/asset-url-service";
import { SUMO_RUNTIME_VERSION } from "@simforge-oss/studio-ui/lib/scenario/sumo-runtime";
import { requireScenarioContext } from "@/app/lib/scenario/http";
import { mapAccessErrorResponse, streamCachedObject } from "@/app/lib/cloud/asset-response";
import { MapCacheError } from "@/app/lib/map-cache/service";

type Context = { params: Promise<{ assetPath: string[] }> };

const ASSET_MEDIA_TYPES = {
  "sumo.mjs": "text/javascript",
  "sumo.wasm": "application/wasm",
  "runtime-manifest.json": "application/json",
  "THIRD_PARTY_NOTICES.md": "text/markdown",
} as const;


function resolveRuntimeAsset(assetPath: string[]) {
  const relativePath = normalizeAssetKey(assetPath.join("/"));
  const prefix = `${SUMO_RUNTIME_VERSION}/`;
  if (!relativePath.startsWith(prefix)) {
    throw new AssetUrlServiceError("sumo_runtime_asset_not_found", "SUMO runtime asset not found.", 404);
  }
  const fileName = relativePath.slice(prefix.length);
  const mediaType = ASSET_MEDIA_TYPES[fileName as keyof typeof ASSET_MEDIA_TYPES];
  if (!mediaType) {
    throw new AssetUrlServiceError("sumo_runtime_asset_not_found", "SUMO runtime asset not found.", 404);
  }
  return {
    mediaType,
  };
}

async function serveRuntimeAsset(request: NextRequest, route: Context, headOnly: boolean) {
  try {
    const auth = await requireScenarioContext();
    if (auth.response) return auth.response;

    const { assetPath } = await route.params;
    const asset = resolveRuntimeAsset(assetPath);
    const url = new URL(request.url);
    const canonicalUrl = `${url.pathname}${url.search}`;
    const identity = await authorizeLocalMapAssetUrl(canonicalUrl);
    if (!identity.sha256 || identity.sizeBytes === undefined) throw new Error("sumo_runtime_identity_missing");
    return await streamCachedObject(request, {
      sha256: identity.sha256, byteLength: identity.sizeBytes, mediaType: asset.mediaType,
    }, canonicalUrl, headOnly);
  } catch (error) {
    if (error instanceof MapAccessError || error instanceof MapCacheError) return mapAccessErrorResponse(error);
    if (error instanceof AssetUrlServiceError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    const detail = error as { name?: string; message?: string };
    console.error("SUMO runtime asset delivery failed", {
      name: detail?.name,
      message: detail?.message,
    });
    return NextResponse.json({ error: "sumo_runtime_asset_unavailable" }, { status: 502 });
  }
}

/** The same authorized, verified, revalidating delivery as map members. */
export async function GET(request: NextRequest, route: Context) {
  return serveRuntimeAsset(request, route, false);
}

export async function HEAD(request: NextRequest, route: Context) {
  return serveRuntimeAsset(request, route, true);
}
