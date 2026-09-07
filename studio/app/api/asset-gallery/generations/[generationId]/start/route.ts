import { NextRequest, NextResponse } from "next/server";
import {
  GalleryGenerationIdSchema,
  StartGalleryGenerationInputSchema,
} from "@/app/lib/asset-gallery/generation-contracts";
import {
  getGalleryGeneration,
  loadGalleryGenerationRecord,
  markGalleryGenerationFailed,
  markGalleryGenerationSubmitted,
} from "@/app/lib/asset-gallery/generation-store";
import {
  getGalleryGenerationReferenceImage,
  verifyGalleryGenerationReferenceImage,
} from "@/app/lib/asset-gallery/generation-storage";
import { requireRouteSession } from "@/app/lib/auth/route-session";
import {
  MeshyInsufficientCreditsError,
  MeshyUnavailableError,
  submitMeshyImageTo3d,
} from "@/app/lib/meshy/client";
import type { MeshySubmitInput } from "@/app/lib/meshy/client";
import {
  readJson,
  requireScenarioMutationOrigin,
} from "@/app/lib/scenario/http";

interface GenerationStartRouteContext {
  params: Promise<{ generationId: string }>;
}

export async function POST(request: NextRequest, { params }: GenerationStartRouteContext) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;

  const auth = await requireRouteSession(request);
  if (!auth.ok) return auth.response;

  const id = GalleryGenerationIdSchema.safeParse((await params).generationId);
  if (!id.success) {
    return auth.apply(
      NextResponse.json(
        { error: "invalid_gallery_generation", details: id.error.flatten() },
        { status: 400 },
      ),
    );
  }
  const parsed = StartGalleryGenerationInputSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return auth.apply(
      NextResponse.json(
        { error: "invalid_gallery_generation", details: parsed.error.flatten() },
        { status: 400 },
      ),
    );
  }

  const generation = await loadGalleryGenerationRecord(id.data);
  if (!generation) {
    return auth.apply(
      NextResponse.json({ error: "gallery_generation_not_found" }, { status: 404 }),
    );
  }
  if (generation.createdByUserId !== auth.session.sub) {
    return auth.apply(
      NextResponse.json({ error: "gallery_generation_forbidden" }, { status: 403 }),
    );
  }
  if (generation.state !== "draft") {
    return auth.apply(
      NextResponse.json({ error: "gallery_generation_not_draft" }, { status: 409 }),
    );
  }

  const present = await Promise.all(
    generation.images.map((image) =>
      verifyGalleryGenerationReferenceImage({
        bucket: generation.sourceBucket,
        key: image.key,
        sha256: image.sha256,
        byteLength: image.byteLength,
      }),
    ),
  );
  if (present.some((verified) => !verified)) {
    return auth.apply(
      NextResponse.json(
        { error: "gallery_generation_images_missing" },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      ),
    );
  }

  let images: MeshySubmitInput["images"];
  try {
    images = await Promise.all(
      generation.images.map(async (image) => ({
        data: await getGalleryGenerationReferenceImage(generation.sourceBucket, image.key),
        mediaType: image.mediaType,
      })),
    );
  } catch {
    // HEAD and GET are separate storage operations. Treat a race between them as
    // a missing upload rather than leaking a storage error or starting partial work.
    return auth.apply(
      NextResponse.json(
        { error: "gallery_generation_images_missing" },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      ),
    );
  }

  try {
    const submitted = await submitMeshyImageTo3d({
      images,
      actorClass: generation.actorClass,
      ...(generation.texturePrompt ? { texturePrompt: generation.texturePrompt } : {}),
    });
    await markGalleryGenerationSubmitted(id.data, submitted.taskId, submitted.request);
  } catch (error) {
    if (error instanceof MeshyInsufficientCreditsError) {
      await markGalleryGenerationFailed(id.data, "insufficient_credits", error.message);
    } else if (error instanceof MeshyUnavailableError) {
      return auth.apply(
        NextResponse.json(
          { error: "gallery_generation_unavailable", message: error.message },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        ),
      );
    } else {
      throw error;
    }
  }

  const summary = await getGalleryGeneration(id.data, auth.session.sub);
  return auth.apply(
    NextResponse.json(
      { generation: summary },
      { headers: { "Cache-Control": "no-store" } },
    ),
  );
}
