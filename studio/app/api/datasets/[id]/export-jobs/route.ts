import { NextResponse } from "next/server";
import { z } from "zod";
import {
  DATASET_EXPORT_RECIPES,
  DatasetExportRequestedOutputsSchema,
  DatasetExportScopeSchema,
  ExportFormatSchema,
  assertDatasetExportRecipeQueueable,
  defaultDatasetExportRequestedOutputs,
  defaultDatasetExportSourceFilter,
  isDatasetExportRecipeQueueable,
  mergeDatasetExportSourceFilters,
  resolveDatasetExportRecipe,
} from "@simforge-oss/studio-shared";
import { resolveExportableDataset } from "@/app/lib/dataset-export/datasets";
import {
  LOCAL_UNSUPPORTED_RECIPE_MESSAGE,
  isLocalDatasetExportRecipe,
  resumeDatasetExports,
  scheduleDatasetExport,
} from "@/app/lib/dataset-export/runner";
import {
  createDatasetExportJobV2,
  listDatasetExportJobsV2,
} from "@/app/lib/db/dataset-export-v2-store";
import { queryOne } from "@/app/lib/db/data-api";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutationOrigin,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";
import { LOCAL_ARTIFACT_BUCKET } from "@/app/lib/s3/s3-config";

type RouteContext = { params: Promise<{ id: string }> };

const UiFilterSchema = z.object({
  scenarioId: z.string().optional(),
  sensorCategory: z.string().optional(),
  outputModality: z.string().optional(),
  artifactClass: z.string().optional(),
  search: z.string().optional(),
});

const ExportJobRequestSchema = z.object({
  format: ExportFormatSchema,
  recipe: z.string().optional(),
  source: z.string().optional(),
  datasetSnapshotId: z.string().trim().min(1).optional(),
  dataset_snapshot_id: z.string().trim().min(1).optional(),
  sourceFilter: DatasetExportScopeSchema.nullish(),
  requestedOutputs: DatasetExportRequestedOutputsSchema.optional(),
  filters: UiFilterSchema.optional(),
});

/** Recipe ids this installation can queue; the panel hides the rest. */
const LOCAL_RECIPE_IDS = DATASET_EXPORT_RECIPES.filter(
  (recipe) => isDatasetExportRecipeQueueable(recipe) && isLocalDatasetExportRecipe(recipe.id),
).map((recipe) => recipe.id);

function buildSourceFilter(payload: z.infer<typeof ExportJobRequestSchema>) {
  if (payload.sourceFilter) return payload.sourceFilter;
  if (!payload.filters) return null;
  const single = (value: string | undefined) => (value && value !== "all" ? [value] : undefined);
  return {
    scenarioIds: single(payload.filters.scenarioId),
    sensorCategories: single(payload.filters.sensorCategory),
    outputModalities: single(payload.filters.outputModality),
    artifactClasses: single(payload.filters.artifactClass),
    search: payload.filters.search?.trim() || undefined,
  };
}

export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { id: datasetId } = await context.params;
  const dataset = await resolveExportableDataset(auth.context, datasetId);
  if (!dataset) return NextResponse.json({ error: "Dataset not found" }, { status: 404 });

  // Listing doubles as the resume signal: a job left queued or running by a
  // previous process gets picked up as soon as anyone looks at it.
  await resumeDatasetExports(dataset.workspaceId, datasetId);
  const jobs = await listDatasetExportJobsV2(dataset.workspaceId, datasetId);
  return NextResponse.json(
    { jobs, source: "artifact_postprocess", recipes: LOCAL_RECIPE_IDS },
    { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
  );
}

export async function POST(request: Request, context: RouteContext) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { id: datasetId } = await context.params;
  const dataset = await resolveExportableDataset(auth.context, datasetId);
  if (!dataset) return NextResponse.json({ error: "Dataset not found" }, { status: 404 });
  if (!dataset.actions.runDerivedWork) {
    return NextResponse.json(
      { error: "You cannot export this dataset.", code: "dataset_export_forbidden" },
      { status: 403 },
    );
  }

  const parsed = ExportJobRequestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const { policy } = dataset;
  const governanceBlockers = [...policy.gates.exportBlockers, ...policy.gates.snapshotBlockers];
  if (!policy.gates.exportReady || !policy.gates.snapshotReady) {
    return NextResponse.json(
      {
        error: governanceBlockers[0] ?? "Dataset governance policy blocks export.",
        blockers: governanceBlockers,
        policy,
      },
      { status: 422 },
    );
  }

  try {
    const recipeDefinition = resolveDatasetExportRecipe(parsed.data.format, parsed.data.recipe);
    const recipe = parsed.data.recipe ?? recipeDefinition.id;
    assertDatasetExportRecipeQueueable(recipeDefinition);
    if (!isLocalDatasetExportRecipe(recipeDefinition.id)) {
      return NextResponse.json(
        { error: LOCAL_UNSUPPORTED_RECIPE_MESSAGE, code: "recipe_unavailable_locally" },
        { status: 422 },
      );
    }
    const datasetSnapshotId = parsed.data.datasetSnapshotId ?? parsed.data.dataset_snapshot_id ?? null;
    if (datasetSnapshotId) {
      const snapshot = await queryOne<{ id: string }>(
        `SELECT id FROM public.dataset_snapshots
          WHERE id = :id AND dataset_id = :dataset_id AND workspace_id = :workspace_id LIMIT 1`,
        { id: datasetSnapshotId, dataset_id: datasetId, workspace_id: dataset.workspaceId },
      );
      if (!snapshot) {
        return NextResponse.json(
          { error: "Dataset snapshot does not belong to this dataset." },
          { status: 422 },
        );
      }
    }
    const rawSourceFilter = mergeDatasetExportSourceFilters(
      defaultDatasetExportSourceFilter(parsed.data.format, recipe),
      buildSourceFilter(parsed.data),
    );
    const sourceFilter = DatasetExportScopeSchema.parse({
      ...(rawSourceFilter ?? {}),
      storageScopes: [LOCAL_ARTIFACT_BUCKET],
    });
    const requestedOutputs =
      parsed.data.requestedOutputs ??
      DatasetExportRequestedOutputsSchema.parse(
        defaultDatasetExportRequestedOutputs(parsed.data.format, recipe),
      );
    const job = await createDatasetExportJobV2({
      workspaceId: dataset.workspaceId,
      datasetId,
      datasetSnapshotId,
      format: parsed.data.format,
      recipe,
      scopeJson: sourceFilter,
      requestedOutputs,
      createdByUserId: auth.context.userId,
    });
    void scheduleDatasetExport(dataset.workspaceId, job.id);

    return NextResponse.json(
      {
        accepted: true,
        exportId: job.id,
        datasetSnapshotId: job.datasetSnapshotId ?? datasetSnapshotId ?? null,
        format: job.format,
        recipe,
        source: "artifact_postprocess",
        status: job.status,
        phase: job.phase,
      },
      { status: 202 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to queue export job" },
      { status: 422 },
    );
  }
}
