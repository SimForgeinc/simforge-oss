import { NextResponse } from "next/server";
import { SubmitScenarioRenderIntentSchema } from "@/app/lib/scenario/render-wire-contracts";
import { listRenderJobs } from "@/app/lib/scenario/control-plane-store";
import { createRenderIntentJob } from "@/app/lib/scenario/render-intent-store";
import { resolveRevisionSimulation } from "@/app/lib/scenario/sim-result-store";
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
  // Every render replays the revision's authoritative simulation. A revision
  // committed before this pipeline (or under another engine) is simulated now,
  // once; ten renders of one revision share that one result.
  let simulation;
  try {
    simulation = await resolveRevisionSimulation(auth.context, parsed.data.revisionId, { waitMs: 20_000 });
  } catch (error) {
    if (!(error instanceof SimulationClosureUnavailableError)) throw error;
    return NextResponse.json({ error: error.code, message: error.message }, { status: 409 });
  }
  if (!simulation) return NextResponse.json({ error: "revision_not_found" }, { status: 404 });
  if (simulation.state === "failed") {
    return NextResponse.json({ error: simulation.failureCode, message: simulation.message }, { status: 422 });
  }
  if (simulation.state !== "succeeded") {
    return NextResponse.json(
      { error: "simulation_pending", retryable: true, simulation },
      { status: 409, headers: { "Retry-After": "2" } },
    );
  }
  let created;
  try {
    created = await createRenderIntentJob(auth.context, parsed.data, {
      simKey: simulation.result.simKey,
      traceSha256: simulation.result.traceSha256,
      timelineSha256: simulation.result.timelineSha256,
      timelineSizeBytes: simulation.result.timelineSizeBytes,
    });
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
      return NextResponse.json({ error: "render_intent_invalid" }, { status: 422 });
    }
    throw error;
  }
  return created
    ? NextResponse.json(created, { status: 201 })
    : NextResponse.json({ error: "revision_or_execution_package_not_found" }, { status: 404 });
}
