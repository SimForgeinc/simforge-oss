import { NextRequest, NextResponse } from "next/server";
import {
  CreateGalleryGenerationInputSchema,
  GALLERY_GENERATION_MIN_CREDITS,
  GALLERY_GENERATIONS_PER_HOUR,
  isGalleryGenerationTerminal,
  ListGalleryGenerationsQuerySchema,
} from "@/app/lib/asset-gallery/generation-contracts";
import { advanceGalleryGeneration } from "@/app/lib/asset-gallery/generation-runner";
import {
  countRecentGenerationsByUser,
  createGalleryGeneration,
  listGalleryGenerations,
  failStalledGalleryGenerations,
} from "@/app/lib/asset-gallery/generation-store";
import { requireRouteSession } from "@/app/lib/auth/route-session";
import { getAppContext } from "@/app/lib/db/app-context";
import { fetchMeshyBalance, meshyConfigured, MeshyUnavailableError } from "@/app/lib/meshy/client";
import { ASSET_GENERATION_NOT_CONFIGURED_MESSAGE } from "@/app/lib/ai-providers/contracts";
import {
  readJson,
  requireScenarioMutationOrigin,
} from "@/app/lib/scenario/http";

export async function GET(request: NextRequest) {
  const auth = await requireRouteSession(request);
  if (!auth.ok) return auth.response;

  const parsed = ListGalleryGenerationsQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams.entries()),
  );
  if (!parsed.success) {
    return auth.apply(
      NextResponse.json(
        { error: "invalid_gallery_generation_query", details: parsed.error.flatten() },
        { status: 400 },
      ),
    );
  }

  // This domain has no cron or queue. A list visit both retires abandoned work
  // and supplies execution time so tasks survive the tab that submitted them.
  await failStalledGalleryGenerations(30);
  let generations = await listGalleryGenerations({
    viewerUserId: auth.session.sub,
    limit: parsed.data.limit,
  });
  const unfinished = generations.filter(({ state }) => !isGalleryGenerationTerminal(state));
  if (unfinished.length > 0) {
    // Advancing every visible unfinished row is deliberate: the list is the
    // durable recovery surface when no single-generation poll remains open.
    await Promise.all(unfinished.map(({ generationId }) => advanceGalleryGeneration(generationId)));
    generations = await listGalleryGenerations({
      viewerUserId: auth.session.sub,
      limit: parsed.data.limit,
    });
  }

  return auth.apply(
    NextResponse.json({ generations }, { headers: { "Cache-Control": "private, no-store" } }),
  );
}

export async function POST(request: NextRequest) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;

  const auth = await requireRouteSession(request);
  if (!auth.ok) return auth.response;

  const parsed = CreateGalleryGenerationInputSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return auth.apply(
      NextResponse.json(
        { error: "invalid_gallery_generation", details: parsed.error.flatten() },
        { status: 400 },
      ),
    );
  }

  if ((await countRecentGenerationsByUser(auth.session.sub)) >= GALLERY_GENERATIONS_PER_HOUR) {
    return auth.apply(
      NextResponse.json(
        { error: "gallery_generation_quota_exceeded" },
        { status: 429, headers: { "Retry-After": "3600", "Cache-Control": "no-store" } },
      ),
    );
  }

  // Refuse before uploads when the provider cannot take the work; the message
  // names the real cause (no key, rejected key, low balance, outage).
  let unavailable: string | null = (await meshyConfigured()) ? null : ASSET_GENERATION_NOT_CONFIGURED_MESSAGE;
  if (!unavailable) {
    try {
      if ((await fetchMeshyBalance()) < GALLERY_GENERATION_MIN_CREDITS) {
        unavailable = `Your Meshy account has fewer than ${GALLERY_GENERATION_MIN_CREDITS} credits; top it up before generating.`;
      }
    } catch (error) {
      unavailable =
        error instanceof MeshyUnavailableError
          ? error.message
          : "The Meshy balance could not be verified. Try again shortly.";
    }
  }
  if (unavailable) {
    return auth.apply(
      NextResponse.json(
        { error: "gallery_generation_unavailable", message: unavailable },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      ),
    );
  }

  const context = getAppContext(auth.session);
  const created = await createGalleryGeneration({
    ...parsed.data,
    createdByUserId: context.userId,
    createdByWorkspaceId: context.workspaceId,
  });
  return auth.apply(
    NextResponse.json(created, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    }),
  );
}
