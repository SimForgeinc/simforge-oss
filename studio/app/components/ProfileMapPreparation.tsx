"use client";

import { Check, Cloud, Database, Download, ExternalLink, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import type { RenderingPreference } from "@simforge-oss/studio-ui/components/rendering-preference";
import { useStudioCloudStatus } from "@/app/lib/host/cloud";
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
    <div className="relative grid min-h-editor-shell place-items-center overflow-hidden px-5 py-10 sm:p-8">
      <div className="relative w-full max-w-xl p-6 text-white sm:p-9" data-testid="profile-map-preparation-content" data-visual-treatment="inline">
        <div className="flex items-start gap-4">
          <div className="grid size-12 shrink-0 place-items-center text-[#E8E044]">
            {complete ? <Check aria-hidden="true" /> : <Database aria-hidden="true" />}
          </div>
          <div>
            <p className="font-meta text-[10px] font-bold uppercase tracking-[0.18em] text-[#E8E044]">{PROFILE_LABELS[profile]} profile</p>
            <h1 className="mt-1 text-2xl font-semibold">{complete ? "Maps are ready" : "Prepare maps"}</h1>
            <p className="mt-2 text-sm leading-6 text-white/50">
              {planning ? "Checking available maps…"
                : downloading ? "Preparing the selected maps for local viewing and Bevy rendering."
                  : complete ? "Selected maps are installed for offline viewing and local native rendering. Account maps still require an active SimCloud connection."
                    : "Download complete maps to this computer. Verified files already in the shared map cache are reused."}
            </p>
          </div>
        </div>

        {maps.length > 0 && !busy && !complete ? (
          <fieldset className="mt-6 border-y border-white/10 py-4">
            <div className="flex items-center justify-between gap-3">
              <legend className="font-meta text-[9px] font-bold uppercase tracking-[0.16em] text-white/40">Maps to prepare · {selected.length} / {maps.length}</legend>
              <div className="flex gap-3 text-[11px]">
                <button type="button" className="text-[#E8E044]" onClick={() => setSelection(new Set(maps.filter((map) => !map.locked).map((map) => map.mapVersionId)))}>Select all</button>
                <button type="button" className="text-white/45" onClick={() => setSelection(new Set())}>Clear</button>
              </div>
            </div>
            <div className="mt-3 grid max-h-40 gap-1 overflow-y-auto sm:grid-cols-2">
              {maps.map((map) => (
                <label key={map.mapVersionId} className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-xs text-white/65">
                  <input type="checkbox" className="size-3.5 accent-[#E8E044]" disabled={map.locked} checked={selection.has(map.mapVersionId)} onChange={(event) => {
                    const next = new Set(selection);
                    if (event.currentTarget.checked) next.add(map.mapVersionId); else next.delete(map.mapVersionId);
                    setSelection(next);
                  }} />
                  <span className="truncate">{map.label}{map.locked ? " · needs account" : ""}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}

        {!busy && cloudState !== null && cloudState !== "connected" ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3" data-testid="profile-map-preparation-account-notice" data-cloud-state={cloudState}>
            <Cloud className="size-4 shrink-0 text-[#E8E044]" aria-hidden="true" />
            <p className="min-w-0 flex-1 text-xs leading-5 text-white/55">Richmond Field Station is available without an account. Connect to SimCloud for other published maps.</p>
            <Button variant="outline" disabled={cloud.loading || cloudState === "connecting"} onClick={() => void cloud.connect()}>
              <ExternalLink className="mr-1 size-3.5" aria-hidden="true" />{cloudState === "connecting" ? "Waiting for approval…" : "Connect to SimCloud"}
            </Button>
          </div>
        ) : null}
        {cloud.error ? <p className="mt-2 text-xs text-amber-300/90" role="alert">{cloud.error}</p> : null}

        {preparation.phase !== "idle" ? (
          <div className="mt-8">
            <MapPreparationProgress
              phase={preparation.phase}
              maps={preparation.maps}
              onRetry={preparation.retry}
              onSkip={preparation.skip}
            />
          </div>
        ) : null}
        {error ? <p role="alert" className="mt-5 border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p> : null}

        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          {complete ? <Button className="h-12 flex-1 rounded-full bg-[#E8E044] text-black" onClick={onContinue}>Open map gallery</Button>
            : busy ? <Button className="h-12 flex-1 rounded-full" disabled><LoaderCircle className="mr-2 size-4 animate-spin" />{planning ? "Checking maps" : "Preparing maps"}</Button>
              : <Button className="h-12 flex-1 rounded-full bg-[#E8E044] text-black" disabled={selected.length === 0} onClick={preparation.start}><Download className="mr-2 size-4" />Prepare selected maps</Button>}
          {!complete ? <Button className="h-12 rounded-full" variant="outline" onClick={onSkip}>Skip to map gallery</Button> : null}
        </div>
      </div>
    </div>
  );
}
