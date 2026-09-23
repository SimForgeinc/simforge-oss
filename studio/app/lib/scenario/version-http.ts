import { NextResponse } from "next/server";
import { ScenarioMapResolutionError } from "@simforge-oss/studio-host";

import { GalleryCatalogResolutionError } from "@/app/lib/asset-gallery/store";

import { SCENARIO_PRIVATE_CACHE_HEADERS } from "./http";
import { SimulationClosureUnavailableError } from "./sim-closure.server";
import { SimulationHistoryError } from "./sim-diff";
import { RevisionReplayError, SimulationFailedError } from "./sim-result-store";

const headers = SCENARIO_PRIVATE_CACHE_HEADERS;

/** The explicit error of a Versions-panel operation, or null for an unexpected one (rethrown). */
export function versionErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof SimulationHistoryError) {
    return NextResponse.json({ error: error.code, message: error.message }, { status: error.status, headers });
  }
  if (error instanceof RevisionReplayError) {
    return NextResponse.json({ error: error.code, message: error.message }, { status: error.status, headers });
  }
  if (error instanceof GalleryCatalogResolutionError) {
    return NextResponse.json({ error: error.code, message: error.message, missing: error.missing }, { status: 422, headers });
  }
  if (error instanceof ScenarioMapResolutionError || error instanceof SimulationClosureUnavailableError) {
    return NextResponse.json({ error: error.code, message: error.message }, { status: 409, headers });
  }
  if (error instanceof SimulationFailedError) {
    return NextResponse.json({ error: error.code, message: error.message }, { status: 422, headers });
  }
  return null;
}

type RevisionResult =
  | { kind: "not_found" }
  | { kind: "simulation_pending"; status: unknown }
  | { kind: "simulation_failed"; code: string; message: string; status: unknown }
  | { kind: "conflict"; current: { draftVersion: number } }
  | { kind: "created"; revision: { id: string; export: { id: string; status: string } } };

/** A `createScenarioRevision` outcome as the revisions route answers it. */
export function revisionResultResponse(result: RevisionResult, created = 201): NextResponse {
  switch (result.kind) {
    case "not_found":
      return NextResponse.json({ error: "document_not_found" }, { status: 404, headers });
    case "simulation_pending":
      return NextResponse.json(
        { error: "simulation_pending", retryable: true, simulation: result.status },
        { status: 409, headers: { ...headers, "Retry-After": "2" } },
      );
    case "simulation_failed":
      return NextResponse.json({ error: result.code, message: result.message, simulation: result.status }, { status: 422, headers });
    case "conflict":
      return NextResponse.json(
        { error: "draft_version_conflict", refetch: true, currentDraftVersion: result.current.draftVersion, current: result.current },
        { status: 409, headers },
      );
    case "created":
      return NextResponse.json(
        {
          revisionId: result.revision.id,
          exportId: result.revision.export.id,
          exportStatus: result.revision.export.status,
          revision: result.revision,
        },
        { status: created, headers },
      );
  }
}
