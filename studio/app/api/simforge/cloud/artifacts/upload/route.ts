import { NextResponse } from "next/server";
import { z } from "zod";
import { transferErrorResponse } from "@/app/lib/cloud/projects";
import { uploadCloudArtifact } from "@/app/lib/cloud/storage";
import { readJson, requireScenarioContext, requireScenarioMutationOrigin } from "@/app/lib/scenario/http";

const UploadSchema = z.strictObject({
  workspaceId: z.string().trim().min(1).max(128),
  artifactId: z.string().trim().min(1).max(128),
});

/**
 * `POST /api/simforge/cloud/artifacts/upload {workspaceId,artifactId}` ->
 * `{workspaceId, artifactId}` naming the SimCloud artifact. Only bytes the
 * workspace lacks are transferred, and the answer is sent only after SimCloud
 * verified the stored digest; a refused completion surfaces as its own code.
 */
export async function POST(request: Request) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = UploadSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_upload", details: parsed.error.flatten() }, { status: 400 });
  }
  try {
    const result = await uploadCloudArtifact(auth.context, parsed.data, request.signal);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return transferErrorResponse(error);
  }
}
