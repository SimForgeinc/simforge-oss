import { NextRequest, NextResponse } from "next/server";
import { GalleryGenerationIdSchema } from "@/app/lib/asset-gallery/generation-contracts";
import { advanceGalleryGeneration } from "@/app/lib/asset-gallery/generation-runner";
import { getGalleryGeneration } from "@/app/lib/asset-gallery/generation-store";
import { requireRouteSession } from "@/app/lib/auth/route-session";

interface GenerationRouteContext {
  params: Promise<{ generationId: string }>;
}

export async function GET(request: NextRequest, { params }: GenerationRouteContext) {
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

  await advanceGalleryGeneration(id.data);
  const generation = await getGalleryGeneration(id.data, auth.session.sub);
  if (!generation) {
    return auth.apply(
      NextResponse.json({ error: "gallery_generation_not_found" }, { status: 404 }),
    );
  }
  return auth.apply(
    NextResponse.json(
      { generation },
      { headers: { "Cache-Control": "private, no-store" } },
    ),
  );
}
