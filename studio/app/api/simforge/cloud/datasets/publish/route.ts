import { NextResponse } from "next/server";
import { z } from "zod";
import { publishCloudDataset, transferErrorResponse } from "@/app/lib/cloud/projects";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutableContext,
  requireScenarioMutationOrigin,
} from "@/app/lib/scenario/http";

const PublishSchema = z.strictObject({
  datasetId: z.string().trim().min(1).max(128),
  workspaceId: z.string().trim().min(1).max(128),
  remoteDatasetId: z.string().trim().min(1).max(128).optional(),
});

/**
 * `POST /api/simforge/cloud/datasets/publish {datasetId,workspaceId,remoteDatasetId?}`
 * -> `StudioCloudPublishResult`. 409 `cloud_publish_conflict` (with
 * `conflicts`) when SimCloud holds a newer version of a document this copy
 * edited; the server then wrote nothing. Reading the local dataset is what
 * publishing needs locally, so the local gate is `read`; write authority is
 * the workspace's, enforced on the server.
 */
export async function POST(request: Request) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = PublishSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_publish", details: parsed.error.flatten() }, { status: 400 });
  }
  const access = await requireScenarioMutableContext(auth.context, parsed.data.datasetId, "read");
  if (access.response) return access.response;
  try {
    const result = await publishCloudDataset(auth.context, parsed.data, request.signal);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return transferErrorResponse(error);
  }
}
