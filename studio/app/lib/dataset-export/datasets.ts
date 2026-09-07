import type { AppContext } from "@/app/lib/db/app-context";
import {
  getDatasetById,
  getDatasetPolicy,
  getDefaultDatasetPolicy,
  listDatasetSummarySourcesForWorkspace,
  type DatasetPolicyMetadata,
} from "@/app/lib/db/dataset-store";
import {
  listScenarioDatasets,
  resolveScenarioDatasetAccess,
} from "@/app/lib/scenario/dataset-store";

/**
 * A dataset the broad export domain can package.
 *
 * Studio has two dataset worlds. Scenario datasets (`simforge.datasets`) own
 * the documents, revisions and render jobs the local product actually
 * produces; legacy variation datasets (`public.datasets`) exist for imported
 * CARLA-era scenarios and their raw artifact catalog. Both are exportable, and
 * both are addressed through one `/api/datasets` id space. When the same id
 * exists in both worlds (upstream migrations created scenario datasets with
 * their legacy ids), the scenario dataset wins because it is the live one.
 */
export type ExportableDataset = {
  id: string;
  name: string;
  description: string | null;
  kind: "scenario" | "legacy";
  scope: "workspace" | "global";
  mutability: "editable" | "read_only";
  workspaceId: string;
  policy: DatasetPolicyMetadata;
  /** What the caller may do; `runDerivedWork` gates export queueing. */
  actions: { read: boolean; runDerivedWork: boolean };
};

export type ExportableDatasetSummary = Pick<
  ExportableDataset,
  "id" | "name" | "description" | "kind" | "scope" | "mutability"
>;

export async function listExportableDatasets(
  context: AppContext,
): Promise<ExportableDatasetSummary[]> {
  const [scenarioDatasets, legacyDatasets] = await Promise.all([
    listScenarioDatasets(context),
    listDatasetSummarySourcesForWorkspace(context.workspaceId),
  ]);
  const seen = new Set<string>();
  const result: ExportableDatasetSummary[] = [];
  for (const dataset of scenarioDatasets) {
    seen.add(dataset.id);
    result.push({
      id: dataset.id,
      name: dataset.name,
      description: dataset.description,
      kind: "scenario",
      scope: dataset.visibility === "public" ? "global" : "workspace",
      mutability: dataset.isSystemManaged ? "read_only" : "editable",
    });
  }
  for (const dataset of legacyDatasets) {
    if (seen.has(dataset.id)) continue;
    result.push({
      id: dataset.id,
      name: dataset.name,
      description: dataset.description,
      kind: "legacy",
      scope: dataset.scope,
      mutability: dataset.mutability,
    });
  }
  return result;
}

export async function resolveExportableDataset(
  context: AppContext,
  datasetId: string,
): Promise<ExportableDataset | null> {
  const scenarioAccess = await resolveScenarioDatasetAccess(context, datasetId);
  if (scenarioAccess) {
    if (!scenarioAccess.actions.read) return null;
    const datasets = await listScenarioDatasets(context);
    const dataset = datasets.find((entry) => entry.id === datasetId);
    return {
      id: datasetId,
      name: dataset?.name ?? datasetId,
      description: dataset?.description ?? null,
      kind: "scenario",
      scope: scenarioAccess.visibility === "public" ? "global" : "workspace",
      mutability: scenarioAccess.mutability,
      workspaceId: scenarioAccess.resourceWorkspaceId,
      // Scenario datasets carry no governance policy columns; exports of local
      // authored work are always allowed.
      policy: getDefaultDatasetPolicy(),
      actions: {
        read: scenarioAccess.actions.read,
        // Deriving an export from a readable dataset never mutates it, so a
        // shared read-only dataset can still be packaged locally.
        runDerivedWork: scenarioAccess.actions.read,
      },
    };
  }

  const legacy = await getDatasetById(datasetId);
  if (!legacy) return null;
  const readable =
    legacy.workspaceId === context.workspaceId || legacy.scope === "global" || legacy.isSystem;
  if (!readable) return null;
  const policy =
    (await getDatasetPolicy(legacy.workspaceId, datasetId)) ?? getDefaultDatasetPolicy();
  return {
    id: datasetId,
    name: legacy.name,
    description: legacy.description ?? null,
    kind: "legacy",
    scope: legacy.scope,
    mutability: legacy.mutability,
    workspaceId: legacy.workspaceId,
    policy,
    actions: { read: true, runDerivedWork: true },
  };
}
