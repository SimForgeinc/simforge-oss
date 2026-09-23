"use client";

import { useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { History } from "lucide-react";
import type { EditorDocument } from "@simforge-oss/editor";
import type { ScenarioDocumentDto, ScenarioVersionDto, ScenarioVersionSimulationDto, ScenarioVersionsDto } from "@simforge-oss/studio-host";

import { MetaLabel } from "../../../components/stylex/MetaLabel";
import { Button } from "../../../components/ui/button";
import { Chip } from "../../../components/ui/chip";
import { Input } from "../../../components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../../../components/ui/sheet";
import { Spinner } from "../../../components/ui/spinner";
import { useStudioHost } from "../../../host";
import { hairline, surface, textLayout, typography } from "../../../stylex/recipes.stylex";
import { CompareDialog } from "./CompareDialog";
import { useDocumentVersions } from "./useDocumentVersions";
import { versionsChanged } from "./versions-events";
import {
  actorName,
  canResimulate,
  createdForLabel,
  dateTime,
  diffChip,
  engineLabel,
  mapLabel,
  panelSubtitle,
  reasonLabel,
  shortDate,
  shortDigest,
  versionTitle,
} from "./versions-model";
import { styles } from "./versions.stylex";

const RESIMULATE_WAIT_MS = 20_000;
const RESIMULATE_ATTEMPTS = 6;

type Compare = { baseSimKey: string; candidateSimKey: string; title: string };

/**
 * OWNS: the editor's Versions panel. A version is an immutable revision ("Version N"); each keeps
 * every simulation it ever had, one of which is active (what its renders replay). Rolling back is
 * "Use this simulation" on an older entry: the stored result replays as it was, nothing is
 * simulated with an old engine. Engine upgrades never move the active simulation by themselves.
 */
export function VersionsButton({
  record,
  document,
}: {
  record: Pick<ScenarioDocumentDto, "id" | "mapVersionId"> | null;
  document: EditorDocument | null;
}) {
  const [open, setOpen] = useState(false);
  if (!record) return null;
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button data-testid="scenario-versions-button" size="sm" type="button" variant="outline" title="Versions and simulation history">
          <History aria-hidden="true" />
          <span>Versions</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="right" xstyle={styles.sheet} data-testid="scenario-versions-panel">
        <VersionsPanel documentId={record.id} draftMapVersionId={record.mapVersionId} document={document} open={open} />
      </SheetContent>
    </Sheet>
  );
}

function VersionsPanel({
  documentId,
  draftMapVersionId,
  document,
  open,
}: {
  documentId: string;
  draftMapVersionId: string | null;
  document: EditorDocument | null;
  open: boolean;
}) {
  const studioHost = useStudioHost();
  const { state, reload } = useDocumentVersions(documentId, open);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "positive" | "critical"; text: string } | null>(null);
  const [compare, setCompare] = useState<Compare | null>(null);
  const versions = state.status === "ready" ? state.versions : state.status === "loading" ? state.previous : null;

  const run = async (key: string, action: () => Promise<string | null>) => {
    setBusy(key);
    setNotice(null);
    try {
      const message = await action();
      if (message) setNotice({ tone: "positive", text: message });
      versionsChanged(documentId);
    } catch (reason) {
      setNotice({ tone: "critical", text: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setBusy(null);
    }
  };

  /** The draft exactly as last saved (autosave flushed first): what a version freezes. */
  const savedDraft = async () => {
    await document?.flush();
    return studioHost.projects.getDocument(documentId);
  };

  const saveVersion = () => run("save", async () => {
    const draft = await savedDraft();
    const result = await studioHost.projects.saveVersion(draft, { label: label.trim() || null });
    setLabel("");
    return `Saved as ${versionTitle(result.revision)}.`;
  });

  const restore = (version: ScenarioVersionDto) => run(`restore:${version.revisionId}`, async () => {
    const content = await studioHost.projects.getVersionContent(documentId, version.revisionId);
    if (content.mapVersionId === draftMapVersionId && document) {
      // Same map: one ordinary, undoable edit that autosaves like any other.
      document.restoreTemplate(content.content);
      return `${versionTitle(version)} restored to the draft. Undo brings your edits back.`;
    }
    // Another map version: the host restores content and pin together (an explicit re-pin).
    const confirmed = window.confirm(
      `${versionTitle(version)} was saved on ${mapLabel(version.map)}. Restoring it also moves the draft to that map version and reloads the editor. Continue?`,
    );
    if (!confirmed) return null;
    const draft = await savedDraft();
    await studioHost.projects.restoreVersion(draft, version.revisionId);
    window.location.reload();
    return null;
  });

  const resimulate = (version: ScenarioVersionDto) => run(`resimulate:${version.revisionId}`, async () => {
    for (let attempt = 0; attempt < RESIMULATE_ATTEMPTS; attempt += 1) {
      const result = await studioHost.projects.resimulateVersion(documentId, version.revisionId, { waitMs: RESIMULATE_WAIT_MS });
      if (result.status.state === "failed") {
        throw new Error(result.status.message ?? `Re-simulation failed (${result.status.failureCode}).`);
      }
      if (result.status.state === "succeeded") {
        const summary = result.motionDiff ? diffChip(result.motionDiff, true)?.text : null;
        return `${versionTitle(version)} re-simulated with ${engineLabel(result.status.result.engineSemVer)}${summary ? `: ${summary}` : ""}. It still renders its active simulation until you choose another.`;
      }
    }
    throw new Error("The re-simulation is still queued; try again in a moment.");
  });

  const use = (version: ScenarioVersionDto, simulation: ScenarioVersionSimulationDto) => run(`use:${simulation.simKey}`, async () => {
    await studioHost.projects.setVersionActiveSimulation(documentId, version.revisionId, simulation.simKey);
    return `${versionTitle(version)} now renders the ${engineLabel(simulation.engineSemVer)} simulation.`;
  });

  return (
    <>
      <SheetHeader xstyle={styles.header}>
        <SheetTitle>Versions</SheetTitle>
        <SheetDescription>
          {versions ? panelSubtitle(versions) : "Saved versions of this scenario and the simulations each one keeps."}
        </SheetDescription>
        <form
          {...stylex.props(styles.saveRow)}
          onSubmit={(event) => {
            event.preventDefault();
            void saveVersion();
          }}
        >
          <Input
            aria-label="Version name (optional)"
            data-testid="scenario-version-label"
            maxLength={120}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Name this version (optional)"
            size="sm"
            value={label}
          />
          <Button data-testid="scenario-save-version" disabled={busy !== null} size="sm" type="submit" variant="accent">
            {busy === "save" ? <Spinner size="sm" tone="onAccent" /> : null}
            Save version
          </Button>
        </form>
        {notice ? (
          <p
            {...stylex.props(typography.bodySm, styles.bannerBody)}
            data-testid="scenario-versions-notice"
            data-tone={notice.tone}
            role={notice.tone === "critical" ? "alert" : "status"}
          >
            {notice.text}
          </p>
        ) : null}
      </SheetHeader>
      <div {...stylex.props(hairline.top, styles.body)}>
        {state.status === "error" ? (
          <div {...stylex.props(styles.state)} role="alert">
            <p {...stylex.props(typography.bodySm, styles.bannerBody)}>Versions could not be loaded: {state.message}</p>
            <Button size="sm" variant="outline" onClick={reload}>Retry</Button>
          </div>
        ) : !versions ? (
          <div {...stylex.props(styles.state)}><Spinner label="Loading versions" /></div>
        ) : (
          <ul {...stylex.props(styles.list)} data-testid="scenario-versions-list">
            {versions.versions.map((version) => (
              <VersionRow
                key={version.revisionId}
                busy={busy}
                currentEngineSemVer={versions.currentEngineSemVer}
                onCompare={(simulation) => {
                  const active = version.simulations.find((entry) => entry.active);
                  if (!active || active.simKey === simulation.simKey) return;
                  setCompare({
                    baseSimKey: active.simKey,
                    candidateSimKey: simulation.simKey,
                    title: `${versionTitle(version)}: ${engineLabel(active.engineSemVer)} vs ${engineLabel(simulation.engineSemVer)}`,
                  });
                }}
                onResimulate={() => void resimulate(version)}
                onRestore={() => void restore(version)}
                onUse={(simulation) => void use(version, simulation)}
                version={version}
                versions={versions}
              />
            ))}
          </ul>
        )}
      </div>
      <CompareDialog
        baseSimKey={compare?.baseSimKey ?? null}
        candidateSimKey={compare?.candidateSimKey ?? null}
        onClose={() => setCompare(null)}
        title={compare?.title ?? ""}
      />
    </>
  );
}

function VersionRow({
  version,
  versions,
  currentEngineSemVer,
  busy,
  onRestore,
  onResimulate,
  onUse,
  onCompare,
}: {
  version: ScenarioVersionDto;
  versions: ScenarioVersionsDto;
  currentEngineSemVer: string;
  busy: string | null;
  onRestore: () => void;
  onResimulate: () => void;
  onUse: (simulation: ScenarioVersionSimulationDto) => void;
  onCompare: (simulation: ScenarioVersionSimulationDto) => void;
}) {
  const needsResimulation = canResimulate(version, currentEngineSemVer);
  return (
    <li
      {...stylex.props(hairline.bottom, hairline.subtle, styles.version)}
      data-testid="scenario-version"
      data-revision-number={version.revisionNumber}
    >
      <div {...stylex.props(styles.versionHead)}>
        <div {...stylex.props(styles.versionText)}>
          <span {...stylex.props(styles.versionTitleRow)}>
            <span {...stylex.props(typography.label, textLayout.truncate)}>
              {versionTitle(version)}
              {version.label ? ` · ${version.label}` : ""}
            </span>
            {version.matchesDraft ? <Chip tone="accent">Draft</Chip> : null}
          </span>
          <span {...stylex.props(typography.meta, textLayout.truncate)}>
            {[shortDate(version.createdAt), actorName(version.createdBy), createdForLabel(version.createdFor)].filter(Boolean).join(" · ")}
          </span>
          <span {...stylex.props(typography.meta, textLayout.truncate)} data-testid="scenario-version-map">{mapLabel(version.map)}</span>
        </div>
        <div {...stylex.props(styles.actions)}>
          <Button
            data-testid="scenario-version-restore"
            disabled={busy !== null || version.matchesDraft}
            onClick={onRestore}
            size="xs"
            title={version.matchesDraft ? "The draft already holds this version" : "Copy this version into the draft (undoable)"}
            variant="outline"
          >
            Restore to draft
          </Button>
          {needsResimulation ? (
            <Button
              data-testid="scenario-version-resimulate"
              disabled={busy !== null}
              onClick={onResimulate}
              size="xs"
              title="Simulate this version with the current engine; it keeps rendering its active simulation until you choose"
              variant="ghost"
            >
              {busy === `resimulate:${version.revisionId}` ? <Spinner size="sm" /> : null}
              Re-simulate with {engineLabel(currentEngineSemVer)}
            </Button>
          ) : null}
        </div>
      </div>
      <ul {...stylex.props(styles.simulations)} aria-label={`${versionTitle(version)} simulations`}>
        {version.simulations.map((simulation) => (
          <SimulationRow
            key={simulation.simKey}
            busy={busy}
            hasActive={version.active !== null}
            onCompare={() => onCompare(simulation)}
            onUse={() => onUse(simulation)}
            simulation={simulation}
            isDraftResult={versions.draft.lastSimKey === simulation.simKey}
          />
        ))}
        {version.simulations.length === 0 ? (
          <li {...stylex.props(typography.meta, styles.simulation)}>No stored simulation. Re-simulate it to render this version.</li>
        ) : null}
      </ul>
    </li>
  );
}

function SimulationRow({
  simulation,
  busy,
  hasActive,
  isDraftResult,
  onUse,
  onCompare,
}: {
  simulation: ScenarioVersionSimulationDto;
  busy: string | null;
  hasActive: boolean;
  isDraftResult: boolean;
  onUse: () => void;
  onCompare: () => void;
}) {
  const chip = diffChip(simulation.motionDiff, simulation.previousSimKey !== null);
  return (
    <li
      {...stylex.props(surface.chip, styles.simulation)}
      data-testid="scenario-version-simulation"
      data-active={String(simulation.active)}
      data-engine={simulation.engineSemVer}
    >
      <div {...stylex.props(styles.simulationHead)}>
        <span {...stylex.props(typography.label)}>{engineLabel(simulation.engineSemVer)}</span>
        {simulation.active ? <Chip tone="accent" data-testid="scenario-simulation-active">Active</Chip> : null}
        {chip ? <Chip tone={chip.tone} title={chip.title} data-testid="scenario-simulation-diff">{chip.text}</Chip> : null}
        {isDraftResult ? <Chip tone="muted">Draft shows this</Chip> : null}
      </div>
      <span {...stylex.props(typography.meta, textLayout.truncate)}>
        {[dateTime(simulation.createdAt), actorName(simulation.createdBy), reasonLabel(simulation.reason)].filter(Boolean).join(" · ")}
      </span>
      <div {...stylex.props(styles.actions)}>
        {!simulation.active ? (
          <Button data-testid="scenario-simulation-use" disabled={busy !== null} onClick={onUse} size="xs" variant="accentOutline">
            Use this simulation
          </Button>
        ) : null}
        {!simulation.active && hasActive ? (
          <Button data-testid="scenario-simulation-compare" disabled={busy !== null} onClick={onCompare} size="xs" variant="ghost">
            Compare
          </Button>
        ) : null}
      </div>
      <details {...stylex.props(styles.details)}>
        <summary {...stylex.props(typography.meta)}>Details</summary>
        <dl {...stylex.props(typography.meta, styles.detailsList)}>
          <MetaLabel as="dt">Simulation</MetaLabel>
          <dd {...stylex.props(typography.numeric, textLayout.truncate, styles.detailsValue)} title={simulation.simKey}>{shortDigest(simulation.simKey)}</dd>
          <MetaLabel as="dt">Trace</MetaLabel>
          <dd {...stylex.props(typography.numeric, textLayout.truncate, styles.detailsValue)} title={simulation.details.traceSha256}>{shortDigest(simulation.details.traceSha256)}</dd>
          <MetaLabel as="dt">Timeline</MetaLabel>
          <dd {...stylex.props(typography.numeric, textLayout.truncate, styles.detailsValue)} title={simulation.details.timelineSha256 ?? ""}>{shortDigest(simulation.details.timelineSha256)}</dd>
          <MetaLabel as="dt">Map closure</MetaLabel>
          <dd {...stylex.props(typography.numeric, textLayout.truncate, styles.detailsValue)} title={simulation.details.mapClosureDigest}>{shortDigest(simulation.details.mapClosureDigest)}</dd>
          <MetaLabel as="dt">Engine build</MetaLabel>
          <dd {...stylex.props(typography.numeric, textLayout.truncate, styles.detailsValue)} title={JSON.stringify(simulation.details.engineBuild)}>
            {String(simulation.details.engineBuild.addonSha256 ?? simulation.details.engineBuild.engineVersion ?? "unrecorded").slice(0, 16)}
          </dd>
          <MetaLabel as="dt">Producer</MetaLabel>
          <dd {...stylex.props(typography.meta, textLayout.truncate, styles.detailsValue)}>{simulation.details.producer}</dd>
        </dl>
      </details>
    </li>
  );
}
