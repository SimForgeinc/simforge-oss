import { NextResponse } from "next/server";
import { z } from "zod";
import { importCloudDataset, transferErrorResponse } from "@/app/lib/cloud/projects";
import { readJson, requireScenarioContext, requireScenarioMutationOrigin } from "@/app/lib/scenario/http";

const ImportSchema = z.strictObject({
  workspaceId: z.string().trim().min(1).max(128),
  datasetId: z.string().trim().min(1).max(128),
});

/**
 * `POST /api/simforge/cloud/datasets/import {workspaceId,datasetId}` -> the
 * local `ScenarioDatasetDto` holding the working copy. 409
 * `cloud_import_conflict` (with `conflicts`) when a document changed on both
 * sides; 422 `cloud_map_unavailable` (with `mapVersionIds`) when a map cannot
 * be prepared under this connection. Nothing is written in either case.
 */
export async function POST(request: Request) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = ImportSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_import", details: parsed.error.flatten() }, { status: 400 });
  }
  try {
    const dataset = await importCloudDataset(auth.context, parsed.data, request.signal);
    return NextResponse.json(dataset, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return transferErrorResponse(error);
  }
}
