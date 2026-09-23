import { NextResponse } from "next/server";
import { SubmitScenarioRenderIntentSchema } from "@/app/lib/scenario/render-wire-contracts";
import { listRenderJobs } from "@/app/lib/scenario/control-plane-store";
import { createRenderIntentJob } from "@/app/lib/scenario/render-intent-store";
import { resolveRevisionReplay, RevisionReplayError, SimulationFailedError } from "@/app/lib/scenario/sim-result-store";
import { SimulationClosureUnavailableError } from "@/app/lib/scenario/sim-closure.server";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutableRevisionContext,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

export async function GET() {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  return NextResponse.json(
    { renderJobs: await listRenderJobs(auth.context) },
    { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
  );
}

export async function POST(request: Request) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const body = await readJson(request);
  const parsed = SubmitScenarioRenderIntentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_render_job", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const access = await requireScenarioMutableRevisionContext(
    auth.context,
    parsed.data.revisionId,
    "read",
  );
  if (access.response) return access.response;
  // Every render replays a STORED simulation of the revision: by default its
  // active (original) result, under whatever engine produced it. Nothing
  // re-simulates here: a revision without a stored result is refused until
  // the user explicitly re-simulates it or asks for the legacy OpenSCENARIO
  // replay, and an engine upgrade never silently changes an old render.
  let replay;
  try {
    replay = await resolveRevisionReplay(auth.context, parsed.data.revisionId, {
      motionSource: parsed.data.motionSource,
      simKey: parsed.data.simKey,
    });
  } catch (error) {
    if (error instanceof RevisionReplayError) {
      return NextResponse.json({ error: error.code, message: error.message, ...error.detail }, { status: error.status });
    }
    if (error instanceof SimulationClosureUnavailableError || error instanceof SimulationFailedError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: 409 });
    }
    throw error;
  }
  let created;
  try {
    created = await createRenderIntentJob(
      auth.context,
      parsed.data,
      replay.kind === "simulation"
        ? {
            simKey: replay.result.simKey,
            traceSha256: replay.result.traceSha256,
            timelineSha256: replay.timeline.timelineSha256,
            timelineSizeBytes: replay.timeline.sizeBytes,
            engineSemVer: replay.result.engineSemVer,
            timelineContactOrigin: replay.timeline.contactOrigin,
          }
        : null,
      replay.motionSource,
    );
  } catch (error) {
    if (error instanceof Error && error.message === "uniscenario_workspace_limit_reached") {
      return NextResponse.json(
        { error: "local_job_limit_reached" },
        { status: 429, headers: { "retry-after": "30" } },
      );
    }
    if (error instanceof Error && error.message.startsWith("uniscenario_render_resource_")) {
      const detail = (error as Error & { detail?: unknown }).detail;
      return NextResponse.json(
        { error: error.message, ...(typeof detail === "string" ? { detail } : {}) },
        { status: 422 },
      );
    }
    if (error instanceof Error && (error.message === "render_timeline_missing" || error.message === "render_motion_source_conflict")) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof Error && error.message === "uniscenario_carla_map_binding_missing") {
      const detail = (error as Error & { detail?: unknown }).detail;
      return NextResponse.json(
        { error: "carla_map_not_bound", ...(typeof detail === "string" ? { detail } : {}) },
        { status: 422 },
      );
    }
    if (error instanceof Error && error.message === "uniscenario_render_intent_idempotency_conflict") {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof Error && error.message.startsWith("native_map_")) {
      // The map's native closure is not registered on this host yet: the
      // intent cannot bind immutable member digests, so the semantic profile
      // must be prepared before a local Bevy render can be submitted.
      return NextResponse.json({ error: "native_map_not_prepared", detail: error.message }, { status: 409 });
    }
    if (error instanceof Error && (
      error.name === "ZodError"
      || error.message.startsWith("pronto_")
      || error.message.startsWith("carla_")
      || error.message.startsWith("native_")
      || error.message.startsWith("render_sensor_")
    )) {
      // The reason names what the engine cannot render (a ZodError's issues
      // are not a reason a user can act on and stay out of the response).
      const reason = error.name === "ZodError" ? undefined : error.message;
      const detail = (error as Error & { detail?: unknown }).detail;
      return NextResponse.json({
        error: "render_intent_invalid",
        ...(reason ? { reason } : {}),
        ...(typeof detail === "string" ? { message: detail } : {}),
      }, { status: 422 });
    }
    throw error;
  }
  return created
    ? NextResponse.json(created, { status: 201 })
    : NextResponse.json({ error: "revision_or_execution_package_not_found" }, { status: 404 });
}
