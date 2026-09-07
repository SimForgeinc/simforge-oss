import { NextResponse } from "next/server";
import { z } from "zod";
import { transferErrorResponse } from "@/app/lib/cloud/projects";
import { importCloudArtifact } from "@/app/lib/cloud/storage";
import { readJson, requireScenarioContext, requireScenarioMutationOrigin } from "@/app/lib/scenario/http";

const ImportSchema = z.strictObject({
  workspaceId: z.string().trim().min(1).max(128),
  artifactId: z.string().trim().min(1).max(128),
});

/**
 * `POST /api/simforge/cloud/artifacts/import {workspaceId,artifactId}` -> the
 * local `ScenarioArtifactDto` (local download URL). Bytes are hashed while
 * they stream in; 502 `cloud_artifact_digest_mismatch` means nothing was kept.
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
    const artifact = await importCloudArtifact(auth.context, parsed.data, request.signal);
    return NextResponse.json(artifact, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return transferErrorResponse(error);
  }
}
