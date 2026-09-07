"use client";

import { Check, Cloud, Database, Download, ExternalLink, LoaderCircle, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import type { RenderingPreference } from "@simforge-oss/studio-ui/components/rendering-preference";
import type { ProfileMapCacheProgress } from "@simforge-oss/studio-ui/lib/scenario/editor/profile-map-cache";
import { useStudioCloudStatus } from "@/app/lib/host/cloud";
import { followMapInstall, startMapInstall } from "@/app/lib/host/map-install";

const CatalogSchema = z.object({
  maps: z.array(z.object({
    mapVersionId: z.string().min(1),
    label: z.string().min(1),
    browserManifestUrl: z.string().nullable(),
    locked: z.boolean(),
  })),
});
type PreparationMap = z.infer<typeof CatalogSchema>["maps"][number];
type Phase = "planning" | "ready" | "downloading" | "complete" | "error";
type TransferMetrics = { bytesPerSecond: number; remainingSeconds: number | null };
const PROFILE_LABELS: Record<RenderingPreference, string> = {
  "roads-only": "Roads Only", "ultra-low-3d": "Low", minimal: "Balanced", high: "High",
};

function formatTransferBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function calculateTransferMetrics(progress: ProfileMapCacheProgress, elapsedMilliseconds: number): TransferMetrics {
  if (progress.completedBytes <= 0 || elapsedMilliseconds <= 0) return { bytesPerSecond: 0, remainingSeconds: null };
  const bytesPerSecond = progress.completedBytes / (elapsedMilliseconds / 1000);
  return { bytesPerSecond, remainingSeconds: Math.ceil(Math.max(0, progress.totalBytes - progress.completedBytes) / bytesPerSecond) };
}

export function formatRemainingTime(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))} sec`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.ceil(seconds % 60);
    return remainder > 0 ? `${minutes} min ${remainder} sec` : `${minutes} min`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  return minutes > 0 ? `${hours} hr ${minutes} min` : `${hours} hr`;
}

/** Prepare complete local closures, not a Cloud browser bundle that is not registered here yet. */
export function ProfileMapPreparation({ profile, redownload = false, onContinue, onSkip }: {
  profile: RenderingPreference;
  redownload?: boolean;
  onContinue: () => void;
  onSkip: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("planning");
  const [maps, setMaps] = useState<PreparationMap[]>([]);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<ProfileMapCacheProgress | null>(null);
  const [completedMaps, setCompletedMaps] = useState(0);
  const [currentMap, setCurrentMap] = useState("");
  const [metrics, setMetrics] = useState<TransferMetrics>({ bytesPerSecond: 0, remainingSeconds: null });
  const [error, setError] = useState("");
  const operation = useRef<AbortController | null>(null);
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const cloud = useStudioCloudStatus();
  const cloudState = cloud.status?.state ?? null;
  const seenCloudState = useRef(cloudState);

  const download = async (chosen: PreparationMap[], controller: AbortController) => {
    setPhase("downloading");
    setError("");
    setCompletedMaps(0);
    setProgress(null);
    try {
      for (const [index, map] of chosen.entries()) {
        controller.signal.throwIfAborted();
        setCurrentMap(map.label);
        setProgress(null);
        setMetrics({ bytesPerSecond: 0, remainingSeconds: null });
        const startedAt = Date.now();
        // The semantic install also installs the browser closure when missing.
        // The same host-owned CAS backs both; existing verified files are reused.
        const result = await followMapInstall(
          map.mapVersionId, "semantic",
          startMapInstall(map.mapVersionId, "semantic", controller.signal),
          controller.signal,
          (state) => {
            if (!state.progress) return;
            const next = {
              completedAssets: state.progress.completedMembers, totalAssets: state.progress.members,
              completedBytes: state.progress.completedBytes, totalBytes: state.progress.bytes,
              currentMapVersionId: map.mapVersionId,
            };
            setProgress(next);
            setMetrics(calculateTransferMetrics(next, Date.now() - startedAt));
          },
        );
        if (result.state !== "ready") throw new Error(result.message ?? `${map.label} could not be installed.`);
        setCompletedMaps(index + 1);
      }
      controller.signal.throwIfAborted();
      setPhase("complete");
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : "Map installation failed.");
      setPhase("error");
    }
  };

  const load = async (downloadAfterPlanning = false, requested?: ReadonlySet<string>) => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setPhase("planning");
    setError("");
    setProgress(null);
    setCompletedMaps(0);
    try {
      const response = await fetch("/api/simforge/maps/catalog", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`Map catalog could not be loaded (${response.status}).`);
      const available = CatalogSchema.parse(await response.json()).maps.filter((map) => Boolean(map.browserManifestUrl));
      controller.signal.throwIfAborted();
      const eligible = available.filter((map) => !map.locked);
      const selected = new Set(eligible.filter((map) => !requested || requested.has(map.mapVersionId)).map((map) => map.mapVersionId));
      setMaps(available);
      setSelection(selected);
      setPhase("ready");
      if (downloadAfterPlanning && selected.size > 0) {
        await download(eligible.filter((map) => selected.has(map.mapVersionId)), controller);
      }
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : "Map catalog could not be loaded.");
      setPhase("error");
    }
  };

  useEffect(() => {
    void load(redownload);
    return () => operation.current?.abort();
    // A profile change starts a new explicit preparation flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, redownload]);

  useEffect(() => {
    const previous = seenCloudState.current;
    seenCloudState.current = cloudState;
    if (previous === null || cloudState === null || previous === cloudState || cloudState === "connecting" || phaseRef.current === "downloading") return;
    void load(false, selectionRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudState]);

  const start = () => {
    const chosen = maps.filter((map) => !map.locked && selection.has(map.mapVersionId));
    if (chosen.length === 0) return;
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    void download(chosen, controller);
  };
  const currentFraction = progress?.totalAssets ? progress.completedAssets / progress.totalAssets : 0;
  const percent = phase === "complete" ? 100 : Math.min(100, Math.round(100 * (completedMaps + currentFraction) / Math.max(1, selection.size)));
  const busy = phase === "planning" || phase === "downloading";

  return (
    <div className="relative grid min-h-editor-shell place-items-center overflow-hidden px-5 py-10 sm:p-8">
      <div className="relative w-full max-w-xl p-6 text-white sm:p-9" data-testid="profile-map-preparation-content" data-visual-treatment="inline">
        <div className="flex items-start gap-4">
          <div className="grid size-12 shrink-0 place-items-center text-[#E8E044]">
            {phase === "complete" ? <Check aria-hidden="true" /> : <Database aria-hidden="true" />}
          </div>
          <div>
            <p className="font-meta text-[10px] font-bold uppercase tracking-[0.18em] text-[#E8E044]">{PROFILE_LABELS[profile]} profile</p>
            <h1 className="mt-1 text-2xl font-semibold">{phase === "complete" ? "Maps are ready" : "Prepare maps"}</h1>
            <p className="mt-2 text-sm leading-6 text-white/50">
              {phase === "planning" ? "Checking available maps…"
                : phase === "downloading" ? `Preparing ${currentMap} for local viewing and Bevy rendering.`
                  : phase === "complete" ? "Selected maps are installed for offline viewing and local native rendering. Account maps still require an active SimCloud connection."
                    : "Download complete maps to this computer. Verified files already in the shared map cache are reused."}
            </p>
          </div>
        </div>

        {maps.length > 0 && !busy ? (
          <fieldset className="mt-6 border-y border-white/10 py-4">
            <div className="flex items-center justify-between gap-3">
              <legend className="font-meta text-[9px] font-bold uppercase tracking-[0.16em] text-white/40">Maps to prepare · {selection.size} / {maps.length}</legend>
              <div className="flex gap-3 text-[11px]">
                <button type="button" className="text-[#E8E044]" onClick={() => { setSelection(new Set(maps.filter((map) => !map.locked).map((map) => map.mapVersionId))); setPhase("ready"); }}>Select all</button>
                <button type="button" className="text-white/45" onClick={() => { setSelection(new Set()); setPhase("ready"); }}>Clear</button>
              </div>
            </div>
            <div className="mt-3 grid max-h-40 gap-1 overflow-y-auto sm:grid-cols-2">
              {maps.map((map) => (
                <label key={map.mapVersionId} className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-xs text-white/65">
                  <input type="checkbox" className="size-3.5 accent-[#E8E044]" disabled={map.locked} checked={selection.has(map.mapVersionId)} onChange={(event) => {
                    const next = new Set(selection);
                    if (event.currentTarget.checked) next.add(map.mapVersionId); else next.delete(map.mapVersionId);
                    setSelection(next); setPhase("ready");
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

        <div className="mt-8 h-1 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-label="Map preparation" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div className="h-full rounded-full bg-[#E8E044] transition-[width] duration-500" style={{ width: `${percent}%` }} />
        </div>
        <div className="mt-2 flex justify-between font-mono text-micro uppercase text-white/35">
          <span>{phase === "downloading" ? `${completedMaps} / ${selection.size} maps · ${progress?.completedAssets ?? 0} / ${progress?.totalAssets ?? 0} files` : phase === "complete" ? "Local maps ready" : `${selection.size} selected maps`}</span>
          <span>{phase === "planning" ? "Checking" : `${percent}%`}</span>
        </div>
        {phase === "downloading" ? (
          <dl className="mt-5 grid grid-cols-3 gap-3 border-y border-white/10 py-4" aria-label="Preparation details">
            <div><dt className="text-[10px] text-white/40">Prepared</dt><dd className="mt-1 font-mono text-xs">{formatTransferBytes(progress?.completedBytes ?? 0)} / {formatTransferBytes(progress?.totalBytes ?? 0)}</dd></div>
            <div><dt className="text-[10px] text-white/40">Verification throughput</dt><dd className="mt-1 font-mono text-xs">{metrics.bytesPerSecond > 0 ? `${formatTransferBytes(metrics.bytesPerSecond)}/s` : "Calculating…"}</dd></div>
            <div><dt className="text-[10px] text-white/40">Current map estimate</dt><dd className="mt-1 font-mono text-xs">{metrics.remainingSeconds === null ? "Estimating…" : metrics.remainingSeconds === 0 ? "Finishing…" : formatRemainingTime(metrics.remainingSeconds)}</dd></div>
          </dl>
        ) : null}
        {error ? <p role="alert" className="mt-5 border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p> : null}

        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          {phase === "complete" ? <Button className="h-12 flex-1 rounded-full bg-[#E8E044] text-black" onClick={onContinue}>Open map gallery</Button>
            : busy ? <Button className="h-12 flex-1 rounded-full" disabled><LoaderCircle className="mr-2 size-4 animate-spin" />{phase === "planning" ? "Checking maps" : "Preparing maps"}</Button>
              : phase === "error" ? <Button className="h-12 flex-1 rounded-full" onClick={() => void load(true, selection)}><RotateCcw className="mr-2 size-4" />Retry</Button>
                : <Button className="h-12 flex-1 rounded-full bg-[#E8E044] text-black" disabled={selection.size === 0} onClick={start}><Download className="mr-2 size-4" />Prepare selected maps</Button>}
          {phase !== "complete" ? <Button className="h-12 rounded-full" variant="outline" onClick={onSkip}>Skip to map gallery</Button> : null}
        </div>
      </div>
    </div>
  );
}
