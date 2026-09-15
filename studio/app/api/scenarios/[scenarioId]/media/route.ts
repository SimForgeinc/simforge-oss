import { NextResponse } from "next/server";
import {
  AssetUrlServiceError,
  getBrowserAssetUrl,
} from "@/app/lib/assets/asset-url-service";
import { objectRedirect } from "@/app/lib/s3/local-object-redirect";
import { resolveScenarioMediaArtifact } from "@/app/lib/scenario/control-plane-store";
import { requireScenarioContext } from "@/app/lib/scenario/http";

type RouteContext = { params: Promise<{ scenarioId: string }> };

/**
 * The bytes of one recording artifact of a scenario.
 *
 * `scenarioMediaProxyUrl` hands this URL to the browser for every MP4 a run
 * produced, and a `<video src>` needs a URL that yields bytes — not a JSON
 * envelope like `/api/simforge/artifacts/[artifactId]`, which is addressed by
 * artifact id and cannot be built from the storage key a recording row
 * carries.
 *
 * Delivery follows the sibling media route
 * (`/api/map-assets/[mapAssetId]/media`): presign and redirect, so the object
 * is streamed by the storage layer and no MP4 is ever buffered here. The
 * redirect target is relative for local objects, which keeps the follow-up
 * request on the caller's own origin — see `local-object-redirect.ts`.
 *
 * Scope is the sibling's, tightened: the key is resolved against the artifacts
 * linked to this scenario inside the session's workspace, so an unrelated key
 * is not readable by naming it. Neither sibling implements `Range`, and the
 * local object route answers whole objects only, so none is implemented here.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { scenarioId } = await params;
  const key = new URL(request.url).searchParams.get("key") ?? "";
  if (!key) {
    return NextResponse.json(
      { error: "scenario_media_key_missing" },
      { status: 400 },
    );
  }
  try {
    const artifact = await resolveScenarioMediaArtifact(
      auth.context,
      scenarioId,
      key,
    );
    if (!artifact) {
      return NextResponse.json(
        { error: "scenario_media_not_found" },
        { status: 404 },
      );
    }
    const url = await getBrowserAssetUrl({
      key: artifact.key,
      bucket: artifact.bucket,
    });
    return objectRedirect(url, 302);
  } catch (error) {
    if (error instanceof AssetUrlServiceError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    console.error("scenario media presign error:", error);
    return NextResponse.json(
      { error: "scenario_media_unavailable" },
      { status: 500 },
    );
  }
}
