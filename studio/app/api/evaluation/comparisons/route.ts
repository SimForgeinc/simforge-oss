import { NextResponse } from "next/server";
import { z } from "zod";

import {
  launchComparison,
  readComputeCapabilities,
  type ComparisonLaunchRequest,
} from "@/app/lib/evaluation/comparison-launch";
import {
  COMPARISON_SCHEMA,
  listComparisons,
  writeComparison,
} from "@/app/lib/evaluation/comparison-store";
import {
  requireScenarioContext,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

const LaunchSchema = z
  .object({
    campaignId: z.string().min(1).max(128),
    kind: z.enum(["closedloop-episode", "openloop"]),
    spec: z.string().min(1),
    seeds: z.array(z.number().int().nonnegative()).min(1).max(64),
    steps: z.number().int().positive().max(100_000),
    decisionHz: z.number().int().positive().default(10),
    mode: z.enum(["offline-simtime", "realtime"]).default("offline-simtime"),
    deadlineMs: z.number().positive().nullable().default(null),
    frameSource: z.string().min(1).nullable().default(null),
    columns: z
      .array(
        z.object({
          modelVersionId: z.string().min(1),
          target: z.enum(["local", "cloud"]),
          rigProfile: z.string().min(1),
          quant: z.string().min(1),
          label: z.string().min(1).max(120).optional(),
        }),
      )
      // One column is a run, not a comparison; the launcher requires two.
      .min(2)
      .max(8),
  })
  .superRefine((value, ctx) => {
    if (value.mode === "realtime" && value.deadlineMs === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deadlineMs"],
        message: "realtime mode requires an explicit deadlineMs",
      });
    }
    if (value.mode === "offline-simtime" && value.deadlineMs !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deadlineMs"],
        message:
          "offline-simtime has no deadline: the barrier is the loop. Use mode \"realtime\" to enforce one.",
      });
    }
  });

/**
 * Launch a comparison: N model configurations over one scenario/seed set.
 *
 * Submits through the existing run paths — the desktop lease and the compute
 * jobs API — so a comparison run is an ordinary run, scored and read exactly
 * like any other. The response reports the columns that were SUBMITTED and,
 * separately, the ones refused with the reason: a configuration that cannot
 * execute on the requested target never becomes a column.
 */
export async function POST(request: Request) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = LaunchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_launch_request",
        detail: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  const launchRequest: ComparisonLaunchRequest = parsed.data;
  const wantsCloud = launchRequest.columns.some((column) => column.target === "cloud");
  const origin = new URL(request.url).origin;
  const capabilities = wantsCloud
    ? await readComputeCapabilities(fetch, origin)
    : ({ ok: false, reason: "no cloud column requested" } as const);

  const result = await launchComparison(auth.context, launchRequest, {
    capabilities: capabilities.ok ? capabilities.capabilities : null,
    capabilitiesReason: capabilities.ok ? null : capabilities.reason,
    submitComputeJob: async (jobBody) => {
      const response = await fetch(`${origin}/api/simforge/compute/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(jobBody),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`compute job rejected (HTTP ${String(response.status)}): ${text.slice(0, 300)}`);
      }
      let job: { id?: string; jobId?: string };
      try {
        job = JSON.parse(text) as { id?: string; jobId?: string };
      } catch {
        throw new Error("compute job accepted but returned no JSON id");
      }
      const id = job.jobId ?? job.id;
      if (!id) throw new Error("compute job accepted but returned no job id");
      return id;
    },
  });

  // Nothing submitted: report the refusals and record nothing. An empty
  // comparison is not a comparison, and writing one would show a person a table
  // with no columns as though it were a result.
  if (result.launched.length === 0) {
    return NextResponse.json(
      { error: "no_column_could_run", refused: result.refused },
      { status: 409, headers: SCENARIO_PRIVATE_CACHE_HEADERS },
    );
  }

  const comparisonId = `cmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await writeComparison({
    schema: COMPARISON_SCHEMA,
    comparisonId,
    campaignId: launchRequest.campaignId,
    kind: launchRequest.kind,
    createdAt: new Date().toISOString(),
    shared: {
      spec: launchRequest.spec,
      seeds: launchRequest.seeds,
      steps: launchRequest.steps,
      decisionHz: launchRequest.decisionHz,
      mode: launchRequest.mode,
      deadlineMs: launchRequest.deadlineMs,
      frameSource: launchRequest.frameSource,
    },
    columns: result.launched.map((column) => ({
      label: column.label,
      target: column.target,
      modelVersionId: column.modelVersionId,
      identity: column.identity,
      runIds: column.runIds,
    })),
    refused: result.refused,
  });

  return NextResponse.json(
    { comparisonId, ...result },
    { status: 202, headers: SCENARIO_PRIVATE_CACHE_HEADERS },
  );
}

/** Comparisons recorded for one campaign: `?campaignId=<id>`. */
export async function GET(request: Request) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const campaignId = new URL(request.url).searchParams.get("campaignId");
  if (!campaignId) {
    return NextResponse.json(
      { error: "campaign_id_required", detail: { parameter: "campaignId" } },
      { status: 400 },
    );
  }
  return NextResponse.json(
    { comparisons: await listComparisons(campaignId) },
    { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
  );
}
