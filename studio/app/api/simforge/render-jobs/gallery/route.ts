import { NextResponse } from "next/server";
import { galleryScope } from "@/app/lib/scenario/render/gallery-scope";
import { listGalleryPage } from "@/app/lib/scenario/render/gallery-store";
import { STUDIO_HOST_PROTOCOL, type EndpointResponse } from "@simforge-oss/studio-host";
import {
  requireScenarioContext,
  requireScenarioMutableDocumentContext,
  requireScenarioMutableRevisionContext,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

type GalleryResponse = EndpointResponse<typeof STUDIO_HOST_PROTOCOL.jobs.gallery>;

/**
 * `GET render-jobs/gallery` — protocol `jobs.gallery`.
 *
 * DYNAMIC, never cached. Every field on a tile — `jobState`, `progressPercent`,
 * `attemptCount`, `failureCode`, `artifactCount` — is advanced by the worker
 * control plane while the user watches, so per plan §2.5 this read's freshness
 * requirement is set by a background writer and `use cache` would freeze render
 * progress with nothing able to clear it. `SCENARIO_PRIVATE_CACHE_HEADERS`
 * (`private, no-store`) because the payload is workspace-scoped.
 *
 * A narrowed scope is authorized here rather than in the store: §5.7 FINDING A,
 * a revision or document can live in a dataset shared into this workspace, so
 * reading its renders is a dataset-authorized action and not a workspace
 * predicate. The scope itself and the hidden-count pairing belong to
 * `gallery-store`.
 */
export async function GET(request: Request) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;

  const url = new URL(request.url);
  const scope = galleryScope(url.searchParams);
  if (scope.kind === "revision") {
    const access = await requireScenarioMutableRevisionContext(auth.context, scope.revisionId, "read");
    if (access.response) return access.response;
  } else if (scope.kind === "document") {
    const access = await requireScenarioMutableDocumentContext(auth.context, scope.documentId, "read");
    if (access.response) return access.response;
  }

  // Parsed permissively and clamped in the store; a bad value must not 400 a read-only list.
  const limitParam = url.searchParams.get("limit");
  const page = await listGalleryPage(auth.context, scope, {
    limit: limitParam === null ? undefined : Number(limitParam),
  });
  return NextResponse.json(page satisfies GalleryResponse, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}
