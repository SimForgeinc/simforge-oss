import { getPresignedGetUrl } from "@/app/lib/s3/s3-presign";
import { NextResponse } from "next/server";
import { normalizeAssetKey } from "@/app/lib/assets/asset-url-service";
import { assertMapUsable } from "@/app/lib/cloud/access";
import { primeCloudSession } from "@/app/lib/cloud/connection";
import { getRegisteredMap, MAP_CACHE_BUCKET } from "@/app/lib/cloud/map-registry";
import { getScenarioMapBrowserAssets } from "@/app/lib/scenario/document-store";
import {
  requireScenarioContext,
  requireScenarioMutationOrigin,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

const MAX_REQUESTS = 128;
const SIGNED_URL_TTL_SECONDS = 60 * 60;

type DownloadRequest = {
  mapVersionId: string;
  relativePath: string;
};

function parseRequests(value: unknown): DownloadRequest[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REQUESTS) {
    return null;
  }
  try {
    return value.map((candidate) => {
      if (!candidate || typeof candidate !== "object") throw new Error("invalid");
      const mapVersionId = (candidate as { mapVersionId?: unknown }).mapVersionId;
      const relativePath = (candidate as { relativePath?: unknown }).relativePath;
      if (typeof mapVersionId !== "string" || !mapVersionId.trim()) throw new Error("invalid");
      if (typeof relativePath !== "string") throw new Error("invalid");
      return {
        mapVersionId: mapVersionId.trim(),
        relativePath: normalizeAssetKey(relativePath),
      };
    });
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const body = await request.json().catch(() => null) as { assets?: unknown } | null;
  const requests = parseRequests(body?.assets);
  if (!requests) {
    return NextResponse.json(
      { error: "invalid_cache_download_request" },
      { status: 400 },
    );
  }
  await primeCloudSession();
  const assets = await getScenarioMapBrowserAssets(auth.context, requests);
  const signed = [];
  for (const asset of assets) {
    const registered = await getRegisteredMap(asset.mapVersionId);
    if (!registered) continue;
    try {
      assertMapUsable(registered);
    } catch {
      // Account maps without an active session are simply not deliverable now.
      continue;
    }
    // Cache-resident members are delivered by the first-party route itself, which
    // streams the verified object; installed members keep the object-store URL.
    const url = asset.bucket === MAP_CACHE_BUCKET
      ? `/api/simforge/maps/${encodeURIComponent(asset.mapVersionId)}/browser-assets/${
        asset.relativePath.split("/").map(encodeURIComponent).join("/")}`
      : await getPresignedGetUrl(asset.key, asset.bucket, SIGNED_URL_TTL_SECONDS);
    signed.push({ mapVersionId: asset.mapVersionId, relativePath: asset.relativePath, url });
  }
  return NextResponse.json(
    { assets: signed },
    { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
  );
}
