import { NextResponse } from "next/server";
import { GalleryCatalogResolutionError } from "@/app/lib/asset-gallery/store";
import {
  CreateScenarioRevisionSchema,
  type CreateScenarioRevisionResultDto,
  type ScenarioConflictDto,
} from "@/app/lib/scenario/contracts";
import {
  createScenarioRevision,
  listScenarioRevisions,
} from "@/app/lib/scenario/document-store";
import { ScenarioMapResolutionError, STUDIO_HOST_PROTOCOL, type EndpointResponse } from "@simforge-oss/studio-host";
import { SimulationClosureUnavailableError } from "@/app/lib/scenario/sim-closure.server";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutableDocumentContext,
  scenarioJsonWithEtag,
} from "@/app/lib/scenario/http";

type Context = { params: Promise<{ documentId: string }> };

export async function GET(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { documentId } = await route.params;
  return await scenarioJsonWithEtag(request, {
    revisions: await listScenarioRevisions(auth.context, documentId),
  } satisfies EndpointResponse<typeof STUDIO_HOST_PROTOCOL.documents.listRevisions>);
}

export async function POST(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = CreateScenarioRevisionSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_revision", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { documentId } = await route.params;
  // Cutting a revision advances documents.latest_revision_id, so this is a content mutation.
  const access = await requireScenarioMutableDocumentContext(
    auth.context,
    documentId,
    "mutateContent",
  );
  if (access.response) return access.response;
  let result;
  try {
    result = await createScenarioRevision(auth.context, documentId, parsed.data);
  } catch (error) {
    if (error instanceof GalleryCatalogResolutionError) {
      return NextResponse.json({ error: error.code, message: error.message, missing: error.missing }, { status: 422 });
    }
    if (!(error instanceof ScenarioMapResolutionError) && !(error instanceof SimulationClosureUnavailableError)) throw error;
    return NextResponse.json({ error: error.code, message: error.message }, { status: 409 });
  }
  if (result.kind === "not_found") {
    return NextResponse.json({ error: "document_not_found" }, { status: 404 });
  }
  if (result.kind === "simulation_pending") {
    // Another executor (a CPU runner) holds this draft's simulation: retry the same commit.
    return NextResponse.json(
      { error: "simulation_pending", retryable: true, simulation: result.status },
      { status: 409, headers: { "Retry-After": "2" } },
    );
  }
  if (result.kind === "simulation_failed") {
    return NextResponse.json(
      { error: result.code, message: result.message, simulation: result.status },
      { status: 422 },
    );
  }
  if (result.kind === "conflict") {
    const body: ScenarioConflictDto = {
      error: "draft_version_conflict",
      refetch: true,
      currentDraftVersion: result.current.draftVersion,
      current: result.current,
    };
    return NextResponse.json(body, { status: 409 });
  }
  const body: CreateScenarioRevisionResultDto = {
    revisionId: result.revision.id,
    exportId: result.revision.export.id,
    exportStatus: result.revision.export.status,
    revision: result.revision,
  };
  return NextResponse.json(body, { status: 201 });
}
