"use client";

import * as stylex from "@stylexjs/stylex";
import { useCallback, useState } from "react";
import { Check, Copy, Download, PackageOpen, Terminal } from "lucide-react";
import type { ScenarioPackageExportDto, ScenarioPackageSummaryDto } from "@simforge-oss/studio-host";

import { styles } from "./useScenarioPackageExport.stylex";
import { useCopyToClipboard, CopyableErrorMessage } from "./CopyableErrorMessage";
import { useStudioHost } from "../../host";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { DropdownMenuItem } from "../../components/ui/dropdown-menu";
import { hairline, surface, typography } from "../../stylex/recipes.stylex";

/**
 * "Export for CLI" on a list row: the latest revision as a
 * `simforge.scenario-package/v1` container that the public `simforge` CLI
 * imports, renders and runs (docs/engineering/scenario-package.md).
 *
 * The pipeline is the OpenSCENARIO export's, then one more step: freeze a
 * revision from the host's authoritative simulation of the saved draft,
 * wait for its OpenSCENARIO export (a package carries it as
 * `export/scenario.xosc`), then ask the host for the package. The thin form
 * comes back stored and verified; the full form (every map member and actor
 * model, for offline use) is a background job this dialog polls.
 *
 * Shown only when the host advertises the `scenario-package-export` action,
 * which is its feature flag.
 */
export function useScenarioPackageExport({
  documentId,
  available,
  onError,
  onNotice,
}: {
  documentId: string;
  /** The host's `scenario-package-export` action; the item is hidden unless it is `true`. */
  available: boolean;
  onError: (error: unknown, fallback: string) => void;
  onNotice?: (message: string | null) => void;
}) {
  const studioHost = useStudioHost();
  const [busy, setBusy] = useState(false);
  const [thin, setThin] = useState<ScenarioPackageExportDto | null>(null);
  const [full, setFull] = useState<ScenarioPackageExportDto | null>(null);
  const [fullError, setFullError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const exportPackage = useCallback(async () => {
    setBusy(true);
    setFull(null);
    setFullError(null);
    onNotice?.("Preparing the scenario package…");
    try {
      const created = await studioHost.projects.ensureRevision({
        documentId,
        onSimulation: (status) => {
          if (status.state === "queued" || status.state === "running") onNotice?.("Simulating the scenario…");
        },
      });
      onNotice?.("Compiling OpenSCENARIO 1.4…");
      await studioHost.jobs.waitForExport(created.revisionId, created.exportId);
      onNotice?.("Writing the scenario package…");
      const exported = await studioHost.jobs.exportScenarioPackage(created.revisionId, { form: "thin" });
      setThin(exported);
      setOpen(true);
      onNotice?.(null);
    } catch (error) {
      onNotice?.(null);
      onError(error, "Export for CLI failed.");
    } finally {
      setBusy(false);
    }
  }, [documentId, onError, onNotice, studioHost]);

  const exportFull = useCallback(async () => {
    if (!thin) return;
    setFullError(null);
    try {
      const queued = await studioHost.jobs.exportScenarioPackage(thin.revisionId, { form: "full", textures: "include" });
      setFull(queued);
      const done = await studioHost.jobs.waitForScenarioPackageExport(thin.revisionId, queued.exportId, { onProgress: setFull });
      setFull(done);
    } catch (error) {
      setFullError(error instanceof Error ? error.message : String(error));
    }
  }, [studioHost, thin]);

  const menuItem = available ? (
    <DropdownMenuItem disabled={busy} onSelect={() => void exportPackage()} data-testid="scenario-export-for-cli">
      <Terminal {...stylex.props(styles.menuIcon)} aria-hidden="true" />
      Export for CLI
    </DropdownMenuItem>
  ) : null;

  const dialog = thin ? (
    <ScenarioPackageDialog
      open={open}
      onOpenChange={setOpen}
      thin={thin}
      full={full}
      fullError={fullError}
      onExportFull={() => void exportFull()}
    />
  ) : null;

  return { busy, menuItem, dialog, exportPackage };
}

function megabytes(bytes: number | null): string {
  if (bytes === null) return "unknown size";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isSummary(summary: ScenarioPackageExportDto["summary"]): summary is ScenarioPackageSummaryDto {
  return typeof (summary as Partial<ScenarioPackageSummaryDto>).engineSemVer === "string";
}

function ScenarioPackageDialog({
  open,
  onOpenChange,
  thin,
  full,
  fullError,
  onExportFull,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  thin: ScenarioPackageExportDto;
  full: ScenarioPackageExportDto | null;
  fullError: string | null;
  onExportFull: () => void;
}) {
  const { copied, copy } = useCopyToClipboard();
  const summary = isSummary(thin.summary) ? thin.summary : null;
  const fullRunning = full !== null && (full.state === "queued" || full.state === "building");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" data-testid="scenario-package-dialog">
        <DialogHeader>
          <DialogTitle>Export for CLI</DialogTitle>
          <DialogDescription>
            A verified scenario package ({thin.displayId}) the <code>simforge</code> CLI imports and renders on your own machine.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p {...stylex.props(typography.meta, surface.card, hairline.all, styles.code)} data-testid="scenario-package-file-name">
            {thin.fileName}
          </p>
          {summary ? (
            <dl {...stylex.props(typography.bodySm, styles.facts)}>
              <dt {...stylex.props(typography.meta)}>Revision</dt>
              <dd {...stylex.props(styles.factValue)}>{summary.title}, revision {summary.revisionNumber}</dd>
              <dt {...stylex.props(typography.meta)}>Motion</dt>
              <dd {...stylex.props(styles.factValue)}>
                Engine {summary.engineSemVer}, simulated {new Date(summary.simulatedAt).toLocaleString()} (trace format {summary.traceFormat},{" "}
                {summary.samplerVersion.replace("simforge.timeline-sampler/", "sampler ")})
                {summary.motionSource === "resimulated" ? "; a re-simulation: this revision has no original result" : ""}
              </dd>
              <dt {...stylex.props(typography.meta)}>Map</dt>
              <dd {...stylex.props(styles.factValue)}>
                {summary.map.label} @ {summary.map.browserClosureSha256.slice(0, 12)}
              </dd>
              <dt {...stylex.props(typography.meta)}>Actors</dt>
              <dd {...stylex.props(styles.factValue)}>{summary.actors.catalogIds.length} catalog models</dd>
              <dt {...stylex.props(typography.meta)}>Needs</dt>
              <dd {...stylex.props(styles.factValue)}>simforge {summary.minCli} or later</dd>
            </dl>
          ) : null}

          <div {...stylex.props(styles.section)}>
            <span {...stylex.props(typography.label)}>Run it</span>
            <div {...stylex.props(styles.commandRow)}>
              <pre
                {...stylex.props(typography.meta, surface.card, hairline.all, styles.code, styles.commandText)}
                data-testid="scenario-package-cli-command"
              >
                {thin.cliCommand}
              </pre>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => copy(thin.cliCommand)}
                aria-label={copied ? "Command copied" : "Copy command"}
                data-testid="scenario-package-copy-command"
              >
                {copied ? <Check {...stylex.props(styles.icon)} aria-hidden="true" /> : <Copy {...stylex.props(styles.icon)} aria-hidden="true" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p {...stylex.props(typography.meta)}>
              Thin package, {megabytes(thin.sizeBytes)}: it plays where map {summary?.map.label ?? thin.packageId.slice(0, 12)} and the actor models resolve by
              digest. <code>rig.json</code> is your sensor rig.
            </p>
          </div>

          <div {...stylex.props(styles.section)}>
            <span {...stylex.props(typography.label)}>Offline</span>
            <p {...stylex.props(typography.meta)}>
              The full package also carries every map member and actor model{summary ? ` (about ${megabytes(summary.map.bytes)} of map)` : ""}. It is built in the
              background; the link expires, the package id does not.
            </p>
            <div {...stylex.props(styles.actions)}>
              {full?.state === "succeeded" && full.downloadUrl ? (
                <Button asChild variant="outline" size="sm">
                  <a href={full.downloadUrl} download={full.fileName} data-testid="scenario-package-download-full">
                    <Download {...stylex.props(styles.icon)} aria-hidden="true" />
                    Download full ({megabytes(full.sizeBytes)})
                  </a>
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled={fullRunning} onClick={onExportFull} data-testid="scenario-package-build-full">
                  <PackageOpen {...stylex.props(styles.icon)} aria-hidden="true" />
                  {fullRunning ? `Building full package (about ${megabytes(full?.estimatedSizeBytes ?? null)})…` : "Build full package"}
                </Button>
              )}
            </div>
            {fullError ? <CopyableErrorMessage message={fullError} /> : null}
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm">Close</Button>
          </DialogClose>
          {thin.downloadUrl ? (
            <Button asChild variant="accent" size="sm">
              <a href={thin.downloadUrl} download={thin.fileName} data-testid="scenario-package-download">
                <Download {...stylex.props(styles.icon)} aria-hidden="true" />
                Download ({megabytes(thin.sizeBytes)})
              </a>
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
