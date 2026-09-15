import { SCENARIO_DATASET_VISIBILITIES, type ScenarioDatasetDto, type ScenarioDatasetReadinessDto } from "../contracts";
import { endpoint } from "./endpoint";
import { array, boolean, nullable, number, object, oneOf, string, literal } from "./schema";

export const ScenarioDatasetSchema = object<ScenarioDatasetDto>({
  id: string(),
  workspaceId: string(),
  name: string(),
  description: nullable(string()),
  visibility: oneOf(SCENARIO_DATASET_VISIBILITIES),
  isSystemManaged: boolean(),
  systemSlug: nullable(string()),
  isDefault: boolean(),
  itemCount: number(),
  documentCount: number(),
  renderSubmittedCount: number(),
  renderCompletedCount: number(),
  exportCompletedCount: number(),
  createdByUserName: nullable(string()),
  updatedByUserName: nullable(string()),
  createdAt: string(),
  updatedAt: string(),
});

export const ScenarioDatasetReadinessSchema = object<ScenarioDatasetReadinessDto>({
  summary: object({ total: number(), rendered: number(), cosmosed: number(), vlmed: number() }),
  scenarios: array(object({ id: string(), has_render: boolean() })),
});

export type CreateDatasetRequest = { name: string; description?: string | null };
export type UpdateDatasetRequest = { name?: string; description?: string | null };
export type DeleteDatasetResponse = { ok: true; deletedDocumentCount: number };

const DATASETS = "/api/simforge/datasets" as const;
const dataset = ({ datasetId }: { datasetId: string }) => `${DATASETS}/${encodeURIComponent(datasetId)}` as const;

/** `datasets` group, protocol v1. Every dataset endpoint the shared client speaks. */
export const datasetsProtocol = {
  list: endpoint<void, void, void, { datasets: ScenarioDatasetDto[] }>({
    method: "GET",
    path: DATASETS,
    response: object({ datasets: array(ScenarioDatasetSchema) }),
  }),
  create: endpoint<void, void, CreateDatasetRequest, ScenarioDatasetDto>({
    method: "POST",
    path: DATASETS,
    response: ScenarioDatasetSchema,
  }),
  get: endpoint<{ datasetId: string }, void, void, ScenarioDatasetDto>({
    method: "GET",
    path: dataset,
    response: ScenarioDatasetSchema,
  }),
  update: endpoint<{ datasetId: string }, void, UpdateDatasetRequest, ScenarioDatasetDto>({
    method: "PATCH",
    path: dataset,
    response: ScenarioDatasetSchema,
  }),
  delete: endpoint<{ datasetId: string }, void, void, DeleteDatasetResponse>({
    method: "DELETE",
    path: dataset,
    response: object({ ok: literal(true), deletedDocumentCount: number() }),
  }),
  readiness: endpoint<{ datasetId: string }, void, void, ScenarioDatasetReadinessDto>({
    method: "GET",
    path: (params) => `${dataset(params)}/readiness`,
    response: ScenarioDatasetReadinessSchema,
  }),
} as const;
