import { NextResponse } from "next/server";
import { MapCacheError } from "@/app/lib/map-cache/service";
import { assertMapUsable, MapAccessError } from "@/app/lib/cloud/access";
import { bundledMap, bundledMemberUrl } from "@/app/lib/cloud/bundled-maps";
import { mapAccessErrorResponse, streamCachedObject } from "@/app/lib/cloud/asset-response";
import { CloudConnectionError, primeCloudSession } from "@/app/lib/cloud/connection";
import { getRegisteredMap } from "@/app/lib/cloud/map-registry";
import { assertLocalMapAccess, upstreamGet } from "@/app/lib/cloud/maps";
import { getScenarioMapThumbnail } from "@/app/lib/scenario/map-thumbnail-store";
import { requireScenarioContext } from "@/app/lib/scenario/http";
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
      // Published closures identify the preview by its stable path. The
      // thumbnail_artifact row is a publication record and may have a
      // different digest/storage copy than the browser closure member.
      const member =
        registered.browser.get("derived/thumbnail.webp") ??
        [...registered.browser.entries()].find(([, candidate]) => candidate.sha256 === stored.sha256)?.[1];
      if (member) {
        const relativePath = registered.browser.get("derived/thumbnail.webp")
          ? "derived/thumbnail.webp"
          : [...registered.browser.entries()].find(([, candidate]) => candidate.sha256 === member.sha256)?.[0];
        if (!relativePath) return NextResponse.json({ error: "map_thumbnail_not_found" }, { status: 404, headers: NO_STORE });
        const ensureUrl = `/api/simforge/maps/${encodeURIComponent(mapVersionId)}/browser-assets/${
          relativePath.split("/").map(encodeURIComponent).join("/")}`;
        const response = await streamCachedObject(
          request,
          member,
          ensureUrl,
          headOnly,
          {
            mapVersionId,
            bucket: member.bucket,
            key: member.key,
            attestDigest: false,
          },
        );
        // Closure members are content-addressed and immutable.
        response.headers.set("Cache-Control", "public, max-age=31536000, immutable");
        return response;
      }
      // If the closure omitted a preview, ask the publishing Cloud for the
      // publication artifact. This keeps old hosted releases usable without
      // manufacturing an object or weakening map authorization.
      const upstream = await upstreamGet(
        `/api/simforge/maps/${encodeURIComponent(mapVersionId)}/thumbnail`,
        request.signal,
      );
      if (upstream.ok) {
        const headers = new Headers(upstream.headers);
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
        if (headOnly) {
          await discardResponseBody(upstream);
          return new Response(null, { status: 200, headers });
        }
        return new Response(upstream.body, { status: upstream.status, headers });
      }
      await discardResponseBody(upstream);
      // Older publications may have only the standalone thumbnail artifact.
      const response = await streamCachedObject(
        request,
        stored,
        `/api/simforge/maps/${encodeURIComponent(mapVersionId)}/thumbnail`,
        headOnly,
        {
          mapVersionId,
          bucket: stored.bucket,
          key: stored.key,
          attestDigest: false,
        },
      );
      response.headers.set("Cache-Control", "public, max-age=31536000, immutable");
      return response;
    }
    // Not yet installed: the preview comes from the publishing Cloud under this
    // installation's access (anonymous RFS or the active account), never a
    // caller-supplied location.
    await assertLocalMapAccess(mapVersionId);
    const upstream = await (async () => {
      // A bundled public map's preview is one member of its browser closure,
      // served by the registry CDN; the Cloud is not consulted.
      const bundled = bundledMap(mapVersionId);
      const preview = bundled?.plans.browser.assets.find((asset) => asset.relativePath === "derived/thumbnail.webp");
      return bundled && preview
        ? fetch(bundledMemberUrl(bundled, preview.sha256), { signal: request.signal })
        : upstreamGet(`/api/simforge/maps/${encodeURIComponent(mapVersionId)}/thumbnail`, request.signal);
    })();
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
    if (error instanceof MapAccessError || error instanceof MapCacheError) return mapAccessErrorResponse(error);
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
