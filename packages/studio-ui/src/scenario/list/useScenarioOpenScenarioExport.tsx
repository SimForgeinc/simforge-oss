"use client";

import * as stylex from "@stylexjs/stylex";
import { styles } from "./useScenarioOpenScenarioExport.stylex";
import { useStudioHost } from "../../host";
import { useCallback, useState } from "react";
import { Archive } from "lucide-react";
import { DropdownMenuItem } from "../../components/ui/dropdown-menu";

/**
 * "Export OpenSCENARIO 1.4" on a list row.
 *
 * Export is core in v2, not optional: the emitted `.xosc` is simultaneously the user-facing download
 * AND the sole execution contract the render worker replays, so this button hands back exactly the
 * artifact a render would run. Only *import* is dropped (§0.5 D1), and esmini replay with it (D4) —
 * so v1's replay menu item has no counterpart here.
 *
 * v1 POSTed to a one-shot `/export/openscenario` route that could return a 422 offering an
 * "approximated" export with per-actor fidelity diagnostics. v2 has no approximation tier: the writer
 * is XSD-validated against a digest-pinned schema, and an unrepresentable document fails the export
 * rather than silently degrading. The 422 dialog therefore has nothing to ask, and is gone.
 *
 * The three steps are the pipeline, not a wrapper: `studioHost.projects.ensureRevision` freezes an immutable
 * revision from the host's authoritative simulation of the saved draft (no browser session or upload is
 * involved), `studioHost.jobs.waitForExport` polls until the compiler has produced an execution package,
 * and `studioHost.artifacts.downloadArtifact` presigns the artifact per request.
 */
export function useScenarioOpenScenarioExport({
  documentId,
  onError,
  onNotice,
}: {
  documentId: string;
  onError: (error: unknown, fallback: string) => void;
  onNotice?: (message: string | null) => void;
}) {
  const studioHost = useStudioHost();
  const [busy, setBusy] = useState(false);

  const exportOpenScenario = useCallback(async () => {
    setBusy(true);
    onNotice?.("Compiling OpenSCENARIO 1.4…");
    try {
      // The revision is taken from the document as the server currently holds it: the summary row
      // carries no `draftVersion`, so `ensureRevision` reads it.
      const created = await studioHost.projects.ensureRevision({
        documentId,
        onSimulation: (status) => {
          if (status.state === "queued" || status.state === "running") onNotice?.("Simulating the scenario…");
        },
      });
      const exported = await studioHost.jobs.waitForExport(created.revisionId, created.exportId);
      if (!exported.artifactId) {
        throw new Error("The OpenSCENARIO export finished without an artifact.");
      }
      await studioHost.artifacts.downloadArtifact(exported.artifactId);
      onNotice?.(`OpenSCENARIO 1.4 export ${exported.artifactId} is ready.`);
    } catch (exportError) {
      onNotice?.(null);
      onError(exportError, "OpenSCENARIO export failed.");
    } finally {
      setBusy(false);
    }
  }, [documentId, onError, onNotice, studioHost]);

  const menuItem = (
    <DropdownMenuItem disabled={busy} onSelect={() => void exportOpenScenario()}>
      <Archive {...stylex.props(styles.exportOpenSCENARIOArchive)} aria-hidden="true" />
      Export OpenSCENARIO
    </DropdownMenuItem>
  );

  return { busy, menuItem, exportOpenScenario };
}
