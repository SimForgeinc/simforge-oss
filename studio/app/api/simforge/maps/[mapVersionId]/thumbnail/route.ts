import { NextResponse } from "next/server";
import { getPresignedGetUrl } from "@/app/lib/s3/s3-presign";
import { assertMapUsable, MapAccessError } from "@/app/lib/cloud/access";
import { mapAccessErrorResponse, streamCachedObject } from "@/app/lib/cloud/asset-response";
import { CloudConnectionError, primeCloudSession } from "@/app/lib/cloud/connection";
import { getRegisteredMap, MAP_CACHE_BUCKET } from "@/app/lib/cloud/map-registry";
import { assertLocalMapAccess, upstreamGet } from "@/app/lib/cloud/maps";
import { getScenarioMapThumbnail } from "@/app/lib/scenario/map-thumbnail-store";
import { requireScenarioContext } from "@/app/lib/scenario/http";
import { objectRedirect } from "@/app/lib/s3/local-object-redirect";
import { discardResponseBody } from "@/app/lib/cloud/drain";

type Context = { params: Promise<{ mapVersionId: string }> };

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

async function thumbnail(request: Request, route: Context, headOnly: boolean) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { mapVersionId } = await route.params;
  try {
    await primeCloudSession();
    const registered = await getRegisteredMap(mapVersionId);
    if (registered) {
      assertMapUsable(registered);
      const stored = await getScenarioMapThumbnail(auth.context, mapVersionId);
      if (!stored) return NextResponse.json({ error: "map_thumbnail_not_found" }, { status: 404, headers: NO_STORE });
      if (stored.bucket === MAP_CACHE_BUCKET) {
        const member = [...registered.browser.entries()].find(([, candidate]) => candidate.sha256 === stored.sha256);
        if (!member) return NextResponse.json({ error: "map_thumbnail_not_found" }, { status: 404, headers: NO_STORE });
        const ensureUrl = `/api/simforge/maps/${encodeURIComponent(mapVersionId)}/browser-assets/${
          member[0].split("/").map(encodeURIComponent).join("/")}`;
        return await streamCachedObject(request, stored, ensureUrl, headOnly);
      }
      const response = objectRedirect(await getPresignedGetUrl(stored.key, stored.bucket, 60 * 60), 307);
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    }
    // Not yet installed: the preview comes from the publishing Cloud under this
    // installation's access (anonymous RFS or the active account), never a
    // caller-supplied location.
    await assertLocalMapAccess(mapVersionId);
    const upstream = await upstreamGet(`/api/simforge/maps/${encodeURIComponent(mapVersionId)}/thumbnail`, request.signal);
    if (!upstream.ok) {
      await discardResponseBody(upstream);
      return NextResponse.json({ error: "map_thumbnail_unavailable" }, { status: upstream.status === 404 ? 404 : 502, headers: NO_STORE });
    }
    const headers = new Headers({
      "content-type": upstream.headers.get("content-type") ?? "image/webp",
      "Cache-Control": "private, max-age=3600",
    });
    const length = upstream.headers.get("content-length");
    if (length) headers.set("content-length", length);
    if (headOnly) {
      await discardResponseBody(upstream);
      return new Response(null, { headers });
    }
    return new Response(upstream.body, { headers });
  } catch (error) {
    if (error instanceof MapAccessError) return mapAccessErrorResponse(error);
    if (error instanceof CloudConnectionError) {
      return NextResponse.json({ error: error.code }, { status: 502, headers: NO_STORE });
    }
    throw error;
  }
}

export async function GET(request: Request, route: Context) {
  return thumbnail(request, route, false);
}

export async function HEAD(request: Request, route: Context) {
  return thumbnail(request, route, true);
}
