"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { Database, LoaderCircle } from "lucide-react";
import { useSetPageTitle } from "@simforge-oss/studio-ui/components/TopBarSlot";
import { PageHeader } from "@simforge-oss/studio-ui/components/ui/page-header";
import { EmptyState } from "@simforge-oss/studio-ui/components/ui/empty-state";
import { DatasetExportPanel } from "./DatasetExportPanel";
import { styles } from "./dataset-export.stylex";

type DatasetSummary = {
  id: string;
  name: string;
  description?: string | null;
  mutability?: string | null;
  scope?: string | null;
};

export function DatasetExportWorkspace() {
  useSetPageTitle("Dataset Export");
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const selectedDataset = useMemo(
    () => datasets.find((dataset) => dataset.id === selectedDatasetId) ?? null,
    [datasets, selectedDatasetId],
  );

  const loadDatasets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/datasets", { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as {
        datasets?: DatasetSummary[];
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? "Failed to load datasets.");
      const nextDatasets = body.datasets ?? [];
      setDatasets(nextDatasets);
      setSelectedDatasetId((current) => {
        if (current && nextDatasets.some((dataset) => dataset.id === current)) {
          return current;
        }
        return nextDatasets[0]?.id ?? null;
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load datasets.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDatasets();
  }, [loadDatasets]);

  return (
    <div {...stylex.props(styles.shell)}>
      <PageHeader
        eyebrow="Dataset operations"
        title="Dataset Export"
        description="Select a dataset, review its contents, and prepare a downloadable export."
        actions={
          <button type="button" onClick={() => void loadDatasets()} disabled={loading} {...stylex.props(styles.workspaceButton)}>
            <LoaderCircle {...stylex.props(styles.iconSmall, loading && styles.iconSpin)} /> Refresh datasets
          </button>
        }
      />
      <div {...stylex.props(styles.workspace)}>
        <aside {...stylex.props(styles.sidebar)}>
          <div {...stylex.props(styles.sidebarHeader)}>
            <span {...stylex.props(styles.textMuted)}>Datasets</span>
            <span {...stylex.props(styles.count)}>{datasets.length}</span>
          </div>
          <div {...stylex.props(styles.datasetScroll)}>
            {loading && datasets.length === 0 ? (
              <div {...stylex.props(styles.loading)} role="status" aria-live="polite">
                <LoaderCircle {...stylex.props(styles.iconMedium, styles.iconSpin)} aria-hidden="true" /> Loading datasets…
              </div>
            ) : error ? (
              <div {...stylex.props(styles.error)}>{error}</div>
            ) : datasets.length === 0 ? (
              <div {...stylex.props(styles.datasetEmpty)}>No datasets.</div>
            ) : (
              <div {...stylex.props(styles.datasetList)}>
                {datasets.map((dataset) => {
                  const active = dataset.id === selectedDatasetId;
                  return (
                    <button key={dataset.id} type="button" onClick={() => setSelectedDatasetId(dataset.id)} {...stylex.props(styles.datasetButton, active && styles.datasetActive)}>
                      <Database {...stylex.props(styles.datasetIcon, active && styles.datasetIconActive)} />
                      <span {...stylex.props(styles.datasetText)}>
                        <span {...stylex.props(styles.datasetName)}>{dataset.name}</span>
                        {dataset.description ? <span {...stylex.props(styles.datasetDescription)}>{dataset.description}</span> : <span {...stylex.props(styles.datasetId)}>{dataset.id}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </aside>
        <main {...stylex.props(styles.main)}>
          {selectedDatasetId && selectedDataset ? (
            <div {...stylex.props(styles.selectedWrap)}>
              <section {...stylex.props(styles.selected)}>
                <div {...stylex.props(styles.selectedLabel)}>Selected dataset</div>
                <div {...stylex.props(styles.selectedName)}>{selectedDataset.name}</div>
                {selectedDataset.description ? <p {...stylex.props(styles.selectedDescription)}>{selectedDataset.description}</p> : null}
              </section>
              <DatasetExportPanel datasetId={selectedDatasetId} />
            </div>
          ) : (
            <EmptyState
              icon={<Database {...stylex.props(styles.iconEmpty)} />}
              title="Select a dataset"
              description="Choose a dataset from the list to review its export options."
              xstyle={styles.emptyState}
            />
          )}
        </main>
      </div>
    </div>
  );
}
