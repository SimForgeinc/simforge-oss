import { scenarioListCache } from "./scenarioListCache";

export const SCENARIO_VIEW_STORAGE_KEY = "simforge.scenarioDatasetView.v1";

type PersistedScenarioViewState = {
  selectedDatasetId?: string | null;
  selectedDocumentIdByDataset?: Record<string, string>;
  /** The one open map group per dataset; the column opens exactly one at a time. */
  selectedMapVersionIdByDataset?: Record<string, string>;
};

export function persistScenarioViewState() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      SCENARIO_VIEW_STORAGE_KEY,
      JSON.stringify({
        selectedDatasetId: scenarioListCache.selectedDatasetId,
        selectedDocumentIdByDataset: scenarioListCache.selectedDocumentIdByDataset,
        selectedMapVersionIdByDataset: scenarioListCache.selectedMapVersionIdByDataset,
      }),
    );
  } catch {
    // View restoration is best-effort; ignore storage quota and privacy-mode failures.
  }
}

export function hydrateScenarioViewStateFromStorage() {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(SCENARIO_VIEW_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as PersistedScenarioViewState;
    if ("selectedDatasetId" in parsed) {
      scenarioListCache.selectedDatasetId = parsed.selectedDatasetId ?? null;
    }
    if (parsed.selectedDocumentIdByDataset) {
      scenarioListCache.selectedDocumentIdByDataset = parsed.selectedDocumentIdByDataset;
    }
    if (parsed.selectedMapVersionIdByDataset) {
      scenarioListCache.selectedMapVersionIdByDataset = parsed.selectedMapVersionIdByDataset;
    }
  } catch {
    return;
  }
}

export function rememberScenarioSelection(datasetId: string, documentId: string) {
  scenarioListCache.selectedDatasetId = datasetId;
  scenarioListCache.selectedDocumentIdByDataset = {
    ...scenarioListCache.selectedDocumentIdByDataset,
    [datasetId]: documentId,
  };
  persistScenarioViewState();
}
