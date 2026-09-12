"use client";

import { Check, Cloud, Database, Download, ExternalLink, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { z } from "zod";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import type { RenderingPreference } from "@simforge-oss/studio-ui/components/rendering-preference";
import { useStudioCloudStatus } from "@/app/lib/host/cloud";
import { setup } from "./setup-preparation.stylex";
import { MapPreparationProgress } from "./map-preparation/MapPreparationProgress";
import { useMapPreparation } from "./map-preparation/useMapPreparation";

const CatalogSchema = z.object({
  maps: z.array(z.object({
    mapVersionId: z.string().min(1),
    label: z.string().min(1),
    browserManifestUrl: z.string().nullable(),
    locked: z.boolean(),
  })),
});
type PreparationMap = z.infer<typeof CatalogSchema>["maps"][number];
const PROFILE_LABELS: Record<RenderingPreference, string> = {
  "roads-only": "Roads Only", "ultra-low-3d": "Low", minimal: "Balanced", high: "High",
};

/** Prepare complete local closures, not a Cloud browser bundle that is not registered here yet. */
export function ProfileMapPreparation({ profile, redownload = false, onContinue, onSkip }: {
  profile: RenderingPreference;
  redownload?: boolean;
  onContinue: () => void;
  onSkip: () => void;
}) {
  const [maps, setMaps] = useState<PreparationMap[]>([]);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [planning, setPlanning] = useState(true);
  const [error, setError] = useState("");
  const autoStarted = useRef(false);
  const cloud = useStudioCloudStatus();
  const cloudState = cloud.status?.state ?? null;
  const selected = maps.filter((map) => !map.locked && selection.has(map.mapVersionId));
  const preparation = useMapPreparation({ mapVersionIds: selected.map((map) => map.mapVersionId) });
  const downloading = preparation.phase === "installing" || preparation.phase === "blocked";
  const busy = planning || downloading;

  const started = preparation.phase !== "idle";
  const start = preparation.start;

  useEffect(() => {
    // Mid-flight connection changes and finished downloads must not reshuffle
    // the list under a running preparation.
    if (cloudState === "connecting" || started) return;
    const controller = new AbortController();
    setPlanning(true);
    setError("");
    void (async () => {
      const response = await fetch("/api/simforge/maps/catalog", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`Map catalog could not be loaded (${response.status}).`);
      const available = CatalogSchema.parse(await response.json()).maps.filter((map) => Boolean(map.browserManifestUrl));
      if (controller.signal.aborted) return;
      setMaps(available);
      setSelection(new Set(available.filter((map) => !map.locked).map((map) => map.mapVersionId)));
      setPlanning(false);
    })().catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : "Map catalog could not be loaded.");
      setPlanning(false);
    });
    return () => controller.abort();
    // A connection change adds or removes account maps; reload the catalog.
  }, [cloudState, started]);

  // "Delete cache and re-download" is already an explicit decision; it does
  // not ask a second time.
  useEffect(() => {
    if (!redownload || planning || autoStarted.current || selected.length === 0) return;
    autoStarted.current = true;
    start();
  }, [redownload, planning, selected.length, start]);

  const complete = preparation.phase === "complete";

  return (
    <div {...stylex.props(setup.shell)}>
      <div {...stylex.props(setup.content)} data-testid="profile-map-preparation-content" data-visual-treatment="inline">
        <div {...stylex.props(setup.header)}>
          <div {...stylex.props(setup.headerIcon)}>{complete ? <Check aria-hidden="true" /> : <Database aria-hidden="true" />}</div>
          <div>
            <p {...stylex.props(setup.eyebrow)}>{PROFILE_LABELS[profile]} profile</p>
            <h1 {...stylex.props(setup.title)}>{complete ? "Maps are ready" : "Prepare maps"}</h1>
            <p {...stylex.props(setup.description)}>{planning ? "Checking available maps…" : downloading ? "Preparing the selected maps for local viewing and Bevy rendering." : complete ? "Selected maps are installed for offline viewing and local native rendering. Account maps still require an active SimCloud connection." : "Download complete maps to this computer. Verified files already in the shared map cache are reused."}</p>
          </div>
        </div>
        {maps.length > 0 && !busy && !complete ? (
          <fieldset {...stylex.props(setup.selection)}>
            <div {...stylex.props(setup.selectionHead)}>
              <legend {...stylex.props(setup.selectionLegend)}>Maps to prepare · {selected.length} / {maps.length}</legend>
              <div {...stylex.props(setup.selectionActions)}>
                <button type="button" {...stylex.props(setup.actionButton, setup.actionPrimary)} onClick={() => setSelection(new Set(maps.filter((map) => !map.locked).map((map) => map.mapVersionId)))}>Select all</button>
                <button type="button" {...stylex.props(setup.actionButton)} onClick={() => setSelection(new Set())}>Clear</button>
              </div>
            </div>
            <div {...stylex.props(setup.mapGrid)}>
              {maps.map((map) => (
                <label key={map.mapVersionId} {...stylex.props(setup.mapOption)}>
                  <input type="checkbox" {...stylex.props(setup.checkbox)} disabled={map.locked} checked={selection.has(map.mapVersionId)} onChange={(event) => { const next = new Set(selection); if (event.currentTarget.checked) next.add(map.mapVersionId); else next.delete(map.mapVersionId); setSelection(next); }} />
                  <span {...stylex.props(setup.truncate)}>{map.label}{map.locked ? " · needs account" : ""}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        {!busy && cloudState !== null && cloudState !== "connected" ? (
          <div {...stylex.props(setup.notice)} data-testid="profile-map-preparation-account-notice" data-cloud-state={cloudState}>
            <Cloud {...stylex.props(setup.noticeIcon)} aria-hidden="true" />
            <p {...stylex.props(setup.noticeText)}>Richmond Field Station is available without an account. Connect to SimCloud for other published maps.</p>
            <Button xstyle={setup.compactButton} variant="outline" disabled={cloud.loading || cloudState === "connecting"} onClick={() => void cloud.connect()}><ExternalLink {...stylex.props(setup.iconSmall)} aria-hidden="true" />{cloudState === "connecting" ? "Waiting for approval…" : "Connect to SimCloud"}</Button>
          </div>
        ) : null}
        {cloud.error ? <p {...stylex.props(setup.error)} role="alert">{cloud.error}</p> : null}
        {preparation.phase !== "idle" ? <div {...stylex.props(setup.preparation)}><MapPreparationProgress phase={preparation.phase} maps={preparation.maps} onRetry={preparation.retry} onSkip={preparation.skip} /></div> : null}
        {error ? <p role="alert" {...stylex.props(setup.errorBox)}>{error}</p> : null}
        <div {...stylex.props(setup.footer)}>
          {complete ? <Button xstyle={setup.primaryButton} onClick={onContinue}>Open map gallery</Button>
            : busy ? <Button xstyle={setup.primaryButton} disabled><LoaderCircle {...stylex.props(setup.loader)} />{planning ? "Checking maps" : "Preparing maps"}</Button>
              : <Button xstyle={setup.primaryButton} disabled={selected.length === 0} onClick={preparation.start}><Download {...stylex.props(setup.iconWithMargin)} />Prepare selected maps</Button>}
          {!complete ? <Button xstyle={setup.secondaryButton} variant="outline" onClick={onSkip}>Skip to map gallery</Button> : null}
        </div>
      </div>
    </div>
  );
}
