"use client";

import { Check, CircleAlert, Download, LoaderCircle, Lock, RotateCcw, SkipForward } from "lucide-react";
import { Button } from "../components/ui/button";
import { SCENARIO_AUTHORING_QUALITY_CHOICES, type ScenarioAuthoringQuality } from "../lib/scenario/contracts";
import { formatBytes } from "../scenario/scene/map-load-progress";
import { evaluateMapDownloadGuard } from "./disk-guard";

/**
 * The second onboarding screen: which maps to download now, and at which
 * graphics level. Props only — the host app owns the catalog, the disk status,
 * the install loop and the navigation that follows.
 */

export type OnboardingMapOption = {
  mapVersionId: string;
  label: string;
  locality: string | null;
  thumbnailUrl: string | null;
  /** Download size of the closure, or null while the plan is unknown. */
  bytes: number | null;
  /** An account map without a signed-in session: shown, not selectable. */
  locked: boolean;
};

/** The rows {@link useMapPreparation} exposes while a download is running. */
export type OnboardingPreparation = {
  phase: "idle" | "installing" | "blocked" | "complete";
  maps: readonly {
    mapVersionId: string;
    label: string;
    state: "pending" | "installing" | "ready" | "error" | "skipped";
    completedBytes: number;
    bytes: number;
    message: string | null;
  }[];
};

const ROW_LABELS: Record<OnboardingPreparation["maps"][number]["state"], string> = {
  pending: "Waiting",
  installing: "Downloading",
  ready: "Ready",
  error: "Failed",
  skipped: "Skipped",
};

export function MapSelectionScreen({
  maps,
  selection,
  onToggle,
  quality,
  onQualityChange,
  freeBytes,
  loading,
  error,
  preparation,
  onDownload,
  onRetry,
  onSkip,
  signedIn,
  onSignIn,
}: {
  maps: readonly OnboardingMapOption[];
  selection: readonly string[];
  onToggle: (mapVersionId: string) => void;
  quality: ScenarioAuthoringQuality;
  onQualityChange: (quality: ScenarioAuthoringQuality) => void;
  freeBytes: number | null;
  loading: boolean;
  error: string | null;
  preparation: OnboardingPreparation;
  onDownload: () => void;
  onRetry: (mapVersionId: string) => void;
  onSkip: (mapVersionId: string) => void;
  /** A SimCloud session is active: every published map is selectable. */
  signedIn: boolean;
  /** Offered while signed out; runs the same PKCE flow as Welcome. */
  onSignIn: () => void;
}) {
  const selected = new Set(selection);
  const selectedMaps = maps.filter((map) => !map.locked && selected.has(map.mapVersionId));
  const selectedBytes = selectedMaps.reduce((total, map) => total + (map.bytes ?? 0), 0);
  const guard = evaluateMapDownloadGuard({
    selectedBytes,
    selectedCount: selectedMaps.length,
    freeBytes,
  });
  const lockedCount = maps.filter((map) => map.locked).length;
  const downloading = preparation.phase === "installing" || preparation.phase === "blocked";

  return (
    <main
      className="relative min-h-svh overflow-hidden bg-[#050607] bg-[radial-gradient(120%_90%_at_78%_-10%,#153c4e_0%,#0b1a24_45%,#050607_100%)] px-6 py-10 text-white sm:px-10"
      data-testid="onboarding-maps"
      data-phase={preparation.phase}
    >
      {/* No live scene here: this screen is dense with map cards and controls,
          and a moving WebGL field behind them fights the content. The welcome
          screen carries the animation; this one keeps its palette. */}
      <div className="relative z-10 mx-auto grid w-full max-w-6xl gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section>
          <p className="font-meta text-[10px] font-bold uppercase tracking-[0.22em] text-[#E8E044]">Step 2 of 2</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Choose your maps</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-white/55">
            Maps are downloaded once and reused by the editor, the viewer and local rendering. You can
            download the rest later from the map gallery.
          </p>

          {signedIn ? null : (
            <div
              className="mt-5 flex flex-wrap items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3"
              data-testid="onboarding-locked-notice"
            >
              <Lock className="size-4 shrink-0 text-[#E8E044]" aria-hidden="true" />
              <p className="min-w-0 flex-1 text-xs leading-5 text-white/55">
                {lockedCount > 0
                  ? `Sign in to unlock ${lockedCount} more ${lockedCount === 1 ? "map" : "maps"} from your SimCloud account.`
                  : "Richmond Field Station needs no account. Sign in to unlock the maps in your SimCloud account."}
              </p>
              <Button onClick={onSignIn} type="button" variant="outline">
                Sign in to SimCloud
              </Button>
            </div>
          )}

          {loading ? (
            <p className="mt-8 flex items-center gap-2 text-sm text-white/45">
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              Loading the map catalog…
            </p>
          ) : (
            <ul className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {maps.map((map) => {
                const checked = !map.locked && selected.has(map.mapVersionId);
                return (
                  <li key={map.mapVersionId}>
                    <label
                      className={`flex h-full cursor-pointer flex-col overflow-hidden rounded-2xl border transition-colors ${
                        map.locked
                          ? "cursor-not-allowed border-white/5 bg-white/[0.02] opacity-45"
                          : checked
                            ? "border-[#E8E044]/70 bg-[#E8E044]/[0.06]"
                            : "border-white/10 bg-white/[0.03] hover:border-white/20"
                      }`}
                      data-testid="onboarding-map-card"
                      data-map-version-id={map.mapVersionId}
                      data-locked={map.locked || undefined}
                      data-selected={checked || undefined}
                    >
                      <span className="relative block aspect-[16/9] overflow-hidden bg-black/40">
                        {map.thumbnailUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element -- host-served thumbnail, no loader needed
                          <img
                            alt=""
                            className="size-full object-cover"
                            src={map.thumbnailUrl}
                          />
                        ) : null}
                        {map.locked ? (
                          <span className="absolute inset-0 grid place-items-center bg-black/55">
                            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/80">
                              <Lock className="size-3.5" aria-hidden="true" />
                              Sign in to unlock
                            </span>
                          </span>
                        ) : null}
                      </span>
                      <span className="flex flex-1 items-start gap-3 px-4 py-3">
                        <input
                          checked={checked}
                          className="mt-1 size-4 accent-[#E8E044]"
                          disabled={map.locked || downloading}
                          onChange={() => onToggle(map.mapVersionId)}
                          type="checkbox"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-white/85">{map.label}</span>
                          <span className="mt-0.5 block truncate text-xs text-white/40">
                            {map.locality ?? "Unknown locality"}
                          </span>
                        </span>
                        <span className="font-mono text-[11px] text-white/45">
                          {map.bytes === null ? "—" : formatBytes(map.bytes)}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          {preparation.phase !== "idle" ? (
            <ul className="mt-8 grid gap-2" data-testid="onboarding-preparation-rows">
              {preparation.maps.map((row) => {
                const percent = row.bytes > 0 ? Math.min(100, Math.round((100 * row.completedBytes) / row.bytes)) : 0;
                return (
                  <li
                    key={row.mapVersionId}
                    className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3"
                    data-testid="onboarding-preparation-row"
                    data-map-version-id={row.mapVersionId}
                    data-state={row.state}
                  >
                    <div className="flex items-center gap-3">
                      <span className="grid size-5 shrink-0 place-items-center text-[#E8E044]">
                        {row.state === "ready" ? (
                          <Check className="size-4" aria-hidden="true" />
                        ) : row.state === "installing" ? (
                          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                        ) : row.state === "error" ? (
                          <CircleAlert className="size-4 text-destructive" aria-hidden="true" />
                        ) : row.state === "skipped" ? (
                          <SkipForward className="size-4 text-white/35" aria-hidden="true" />
                        ) : null}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-white/80">{row.label}</span>
                      <span className="font-mono text-[11px] text-white/40">
                        {row.state === "installing" || row.state === "ready"
                          ? `${formatBytes(row.completedBytes)}${row.bytes > 0 ? ` / ${formatBytes(row.bytes)}` : ""}`
                          : ROW_LABELS[row.state]}
                      </span>
                      {row.state === "error" ? (
                        <span className="flex shrink-0 gap-2">
                          <Button onClick={() => onRetry(row.mapVersionId)} type="button" variant="outline">
                            <RotateCcw className="mr-1 size-3.5" aria-hidden="true" />
                            Retry
                          </Button>
                          <Button onClick={() => onSkip(row.mapVersionId)} type="button" variant="outline">
                            Skip
                          </Button>
                        </span>
                      ) : null}
                    </div>
                    {row.state === "installing" ? (
                      <div
                        aria-label={`${row.label} download`}
                        aria-valuemax={100}
                        aria-valuemin={0}
                        aria-valuenow={percent}
                        className="mt-2 h-1 overflow-hidden rounded-full bg-white/10"
                        role="progressbar"
                      >
                        <div
                          className="h-full rounded-full bg-[#E8E044] transition-[width] duration-500"
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                    ) : null}
                    {row.message ? (
                      <p className="mt-2 text-xs text-destructive" role="alert">
                        {row.message}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>

        <aside className="lg:sticky lg:top-10 lg:self-start">
          <fieldset disabled={downloading}>
            <legend className="font-meta text-[9px] font-bold uppercase tracking-[0.18em] text-white/40">
              Graphics level
            </legend>
            <div className="mt-3 grid gap-2">
              {SCENARIO_AUTHORING_QUALITY_CHOICES.map((choice) => (
                <label
                  key={choice.id}
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
                    quality === choice.id
                      ? "border-[#E8E044]/70 bg-[#E8E044]/[0.06]"
                      : "border-white/10 bg-white/[0.03] hover:border-white/20"
                  }`}
                  data-testid="onboarding-quality-option"
                  data-quality={choice.id}
                  data-selected={quality === choice.id || undefined}
                >
                  <input
                    checked={quality === choice.id}
                    className="mt-1 size-3.5 accent-[#E8E044]"
                    name="onboarding-quality"
                    onChange={() => onQualityChange(choice.id)}
                    type="radio"
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-sm font-medium text-white/85">
                      {choice.label}
                      {choice.recommended ? (
                        <span className="font-meta text-[9px] font-bold uppercase tracking-[0.14em] text-[#E8E044]">
                          Recommended
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-white/40">{choice.gpuMemoryGuidance}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <p className="mt-3 text-[11px] leading-4 text-white/35">
            The graphics level changes what the viewer keeps in memory, not what is downloaded: a map is
            one content-addressed set of files. You can change it any time in Settings.
          </p>

          <dl className="mt-6 grid gap-2 border-t border-white/10 pt-4 text-xs">
            <div className="flex justify-between gap-3">
              <dt className="text-white/40">Selected</dt>
              <dd className="font-mono text-white/80" data-testid="onboarding-selected-bytes">
                {selectedMaps.length} {selectedMaps.length === 1 ? "map" : "maps"} · {formatBytes(selectedBytes)}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-white/40">Free disk</dt>
              <dd className="font-mono text-white/80" data-testid="onboarding-free-bytes">
                {freeBytes === null ? "Unknown" : formatBytes(freeBytes)}
              </dd>
            </div>
          </dl>

          {error ? (
            <p className="mt-4 border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          {guard.reason && !downloading ? (
            <p className="mt-4 text-xs leading-5 text-amber-300/90" data-testid="onboarding-download-blocked">
              {guard.reason}
            </p>
          ) : null}

          <Button
            className="mt-4 h-12 w-full rounded-full bg-[#E8E044] text-black hover:bg-[#E8E044]/85"
            data-testid="onboarding-download"
            disabled={loading || downloading || guard.blocked}
            onClick={onDownload}
            type="button"
          >
            {downloading ? (
              <>
                <LoaderCircle className="mr-1 size-4 animate-spin" aria-hidden="true" />
                Downloading…
              </>
            ) : (
              <>
                <Download className="mr-1 size-4" aria-hidden="true" />
                Download and continue
              </>
            )}
          </Button>
        </aside>
      </div>
    </main>
  );
}
