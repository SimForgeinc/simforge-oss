"use client";

/**
 * Development harness for `ScenarioCoverageMap`: the coverage map full-screen
 * with the real installed maps and the real scenario counts, a readout of the
 * selected map, and buttons that drive the `focus` prop the way the datasets
 * list drives it when a scenario is opened for editing.
 *
 * Not a product surface. It exists so the coverage map can be verified on its
 * own while the datasets list is being rewritten around it, and is deleted
 * once that lands.
 */

import * as stylex from "@stylexjs/stylex";
import { useEffect, useMemo, useState } from "react";
import { useStudioHost } from "@simforge-oss/studio-ui/host";
import { ScenarioCoverageMap } from "@simforge-oss/studio-ui/scenario/coverage/ScenarioCoverageMap";
import {
  groupDocumentsByMap,
  type ScenarioMapGroup,
} from "@simforge-oss/studio-ui/scenario/list/document-map-groups";
import type { ScenarioDocumentSummaryDto } from "@simforge-oss/studio-ui/lib/scenario/contracts";
import type { StudioMapEntry } from "@simforge-oss/studio-host";

const styles = stylex.create({
  page: { position: "fixed", inset: 0, display: "flex", flexDirection: "column" },
  map: { flex: 1, minHeight: 0 },
  bar: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    padding: "0.5rem 0.75rem",
    backgroundColor: "#0a0a0a",
    color: "#ffffff",
    fontSize: "0.75rem",
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: "rgba(255,255,255,0.14)",
  },
  button: {
    paddingInline: "0.5rem",
    paddingBlock: "0.25rem",
    backgroundColor: "rgba(255,255,255,0.1)",
    color: "#ffffff",
    cursor: "pointer",
  },
});

export default function CoveragePreviewPage() {
  const studioHost = useStudioHost();
  const [maps, setMaps] = useState<StudioMapEntry[]>([]);
  const [documents, setDocuments] = useState<ScenarioDocumentSummaryDto[]>([]);
  const [selectedMapVersionId, setSelectedMapVersionId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ mapVersionId: string } | null>(null);
  const [settled, setSettled] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      const [catalog, datasets] = await Promise.all([
        studioHost.artifacts.listMaps(),
        studioHost.projects.listDatasets(),
      ]);
      const pages = await Promise.all(datasets.map((dataset) =>
        studioHost.projects.listDocumentSummaries({ datasetId: dataset.id })
          .catch(() => ({ documents: [], nextCursor: null }))));
      if (abort.signal.aborted) return;
      setMaps(catalog);
      setDocuments(pages.flatMap((page) => page.documents));
    })().catch((reason: unknown) => {
      if (!abort.signal.aborted) console.error("coverage-preview load failed", reason);
    });
    return () => abort.abort();
  }, [studioHost]);

  const groups: ScenarioMapGroup[] = useMemo(
    () => groupDocumentsByMap(documents, maps),
    [documents, maps],
  );
  const selectedGroup = groups.find((group) => group.mapVersionId === selectedMapVersionId) ?? null;

  return (
    <div {...stylex.props(styles.page)}>
      <ScenarioCoverageMap
        xstyle={styles.map}
        maps={groups}
        selectedMapVersionId={selectedMapVersionId}
        onSelectMap={setSelectedMapVersionId}
        focus={focus}
        onFocusSettled={() => setSettled((count) => count + 1)}
      />
      <div {...stylex.props(styles.bar)}>
        <span data-testid="coverage-selection">
          selected: {selectedGroup ? `${selectedGroup.displayLabel} (${selectedGroup.documents.length})` : "none"}
        </span>
        <span data-testid="coverage-focus">focus: {focus?.mapVersionId ?? "none"}</span>
        <span data-testid="coverage-settled">settled: {settled}</span>
        <button
          type="button"
          data-testid="coverage-focus-selected"
          disabled={!selectedMapVersionId}
          onClick={() => setFocus(selectedMapVersionId ? { mapVersionId: selectedMapVersionId } : null)}
          {...stylex.props(styles.button)}
        >
          Focus selected
        </button>
        <button
          type="button"
          data-testid="coverage-focus-clear"
          onClick={() => setFocus(null)}
          {...stylex.props(styles.button)}
        >
          Clear focus
        </button>
        <span>groups: {groups.length} · maps: {maps.length} · documents: {documents.length}</span>
      </div>
    </div>
  );
}
