import { getPresignedGetUrl } from "@/app/lib/s3/s3-presign";
import { NextResponse } from "next/server";
import { normalizeAssetKey } from "@/app/lib/assets/asset-url-service";
import { assertMapUsable } from "@/app/lib/cloud/access";
import { primeCloudSession } from "@/app/lib/cloud/connection";
import { getRegisteredMap, MAP_CACHE_BUCKET } from "@/app/lib/cloud/map-registry";
import { getScenarioMapBrowserAssets } from "@/app/lib/scenario/document-store";
import {
  requireScenarioContext,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

const MAX_REQUESTS = 2048;
const SIGNED_URL_TTL_SECONDS = 60 * 60;
const PUBLIC_MAP_ORIGIN = (process.env.SIMFORGE_MAPS_PUBLIC_URL?.trim() || "").replace(/\/+$/, "");

function publicBlobUrl(sha256: string): string | null {
  if (!PUBLIC_MAP_ORIGIN || !/^[a-f0-9]{64}$/i.test(sha256)) return null;
  return `${PUBLIC_MAP_ORIGIN}/blobs/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

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
  // Sign independently: a closure commonly contains hundreds of objects and
  // each presign may involve an object-store client/credential check. Keeping
  // this fan-out concurrent makes the one authorization hop proportional to
  // the batch, rather than to its member count.
  const signed = (await Promise.all(assets.map(async (asset) => {
    const registered = await getRegisteredMap(asset.mapVersionId);
    if (!registered) return null;
    try {
      assertMapUsable(registered);
    } catch {
      // Account maps without an active session are simply not deliverable now.
      return null;
    }
    // Cache-resident members are delivered by the first-party route itself,
    // which streams the verified object; installed members keep the object-store
    // URL and therefore never proxy large bodies through this function.
    const url = publicBlobUrl(asset.sha256)
      ?? (asset.bucket === MAP_CACHE_BUCKET
        ? `/api/simforge/maps/${encodeURIComponent(asset.mapVersionId)}/browser-assets/${
          asset.relativePath.split("/").map(encodeURIComponent).join("/")}`
        : await getPresignedGetUrl(asset.key, asset.bucket, SIGNED_URL_TTL_SECONDS));
    return { mapVersionId: asset.mapVersionId, relativePath: asset.relativePath, url };
  }))).filter((asset): asset is { mapVersionId: string; relativePath: string; url: string } => asset !== null);
  return NextResponse.json(
    { assets: signed },
    { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
  );
}
