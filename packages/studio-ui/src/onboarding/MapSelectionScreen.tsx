"use client";

import type { CSSProperties } from "react";
import { Check, CircleAlert, Download, LoaderCircle, Lock, RotateCcw, SkipForward } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { Button } from "../components/ui/button";
import { SCENARIO_AUTHORING_QUALITY_CHOICES, type ScenarioAuthoringQuality } from "../lib/scenario/contracts";
import { formatBytes } from "../scenario/scene/map-load-progress";
import { evaluateMapDownloadGuard } from "./disk-guard";
import { installRows, onboarding, PROGRESS_VAR } from "./onboarding.stylex";

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
      {...stylex.props(onboarding.mapScreen)}
      data-testid="onboarding-maps"
      data-phase={preparation.phase}
    >
      {/* No live scene here: this screen is dense with map cards and controls,
          and a moving WebGL field behind them fights the content. The welcome
          screen carries the animation; this one keeps its palette. */}
      <div {...stylex.props(onboarding.mapColumns)}>
        <section>
          <p {...stylex.props(onboarding.eyebrow)}>Step 2 of 2</p>
          <h1 {...stylex.props(onboarding.mapTitle)}>Choose your maps</h1>
          <p {...stylex.props(onboarding.mapLede)}>
            Maps are downloaded once and reused by the editor, the viewer and local rendering. You can
            download the rest later from the map gallery.
          </p>

          {signedIn ? null : (
            <div {...stylex.props(onboarding.lockedNotice)} data-testid="onboarding-locked-notice">
              <Lock {...stylex.props(onboarding.icon, onboarding.iconNoShrink, onboarding.iconWarning)} aria-hidden="true" />
              <p {...stylex.props(onboarding.lockedNoticeText)}>
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
            <p {...stylex.props(onboarding.catalogLoading)}>
              <LoaderCircle {...stylex.props(onboarding.icon, onboarding.spinner)} aria-hidden="true" />
              Loading the map catalog…
            </p>
          ) : (
            <ul {...stylex.props(onboarding.mapGrid)}>
              {maps.map((map) => {
                const checked = !map.locked && selected.has(map.mapVersionId);
                return (
                  <li key={map.mapVersionId}>
                    <label
                      {...stylex.props(
                        onboarding.mapCard,
                        map.locked
                          ? onboarding.mapCardLocked
                          : checked
                            ? onboarding.mapCardSelected
                            : onboarding.mapCardIdle,
                      )}
                      data-testid="onboarding-map-card"
                      data-map-version-id={map.mapVersionId}
                      data-locked={map.locked || undefined}
                      data-selected={checked || undefined}
                    >
                      <span {...stylex.props(onboarding.thumbnail)}>
                        {map.thumbnailUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element -- host-served thumbnail, no loader needed
                          <img
                            alt=""
                            {...stylex.props(onboarding.thumbnailImage)}
                            src={map.thumbnailUrl}
                          />
                        ) : null}
                        {map.locked ? (
                          <span {...stylex.props(onboarding.lockedVeil)}>
                            <span {...stylex.props(onboarding.lockedVeilLabel)}>
                              <Lock {...stylex.props(onboarding.iconSmall)} aria-hidden="true" />
                              Sign in to unlock
                            </span>
                          </span>
                        ) : null}
                      </span>
                      <span {...stylex.props(onboarding.mapCardBody)}>
                        <input
                          checked={checked}
                          {...stylex.props(onboarding.checkbox)}
                          disabled={map.locked || downloading}
                          onChange={() => onToggle(map.mapVersionId)}
                          type="checkbox"
                        />
                        <span {...stylex.props(onboarding.mapCardText)}>
                          <span {...stylex.props(onboarding.mapCardLabel)}>{map.label}</span>
                          <span {...stylex.props(onboarding.mapCardLocality)}>
                            {map.locality ?? "Unknown locality"}
                          </span>
                        </span>
                        <span {...stylex.props(onboarding.mapCardSize)}>
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
            <ul {...stylex.props(installRows.list)} data-testid="onboarding-preparation-rows">
              {preparation.maps.map((row) => {
                const percent = row.bytes > 0 ? Math.min(100, Math.round((100 * row.completedBytes) / row.bytes)) : 0;
                return (
                  <li
                    key={row.mapVersionId}
                    {...stylex.props(installRows.row)}
                    data-testid="onboarding-preparation-row"
                    data-map-version-id={row.mapVersionId}
                    data-state={row.state}
                  >
                    <div {...stylex.props(installRows.rowHead)}>
                      <span {...stylex.props(installRows.stateIcon)}>
                        {row.state === "ready" ? (
                          <Check {...stylex.props(onboarding.icon)} aria-hidden="true" />
                        ) : row.state === "installing" ? (
                          <LoaderCircle {...stylex.props(onboarding.icon, onboarding.spinner)} aria-hidden="true" />
                        ) : row.state === "error" ? (
                          <CircleAlert {...stylex.props(onboarding.icon, onboarding.iconDanger)} aria-hidden="true" />
                        ) : row.state === "skipped" ? (
                          <SkipForward {...stylex.props(onboarding.icon, onboarding.iconMuted)} aria-hidden="true" />
                        ) : null}
                      </span>
                      <span {...stylex.props(installRows.rowLabel)}>{row.label}</span>
                      <span {...stylex.props(installRows.rowBytes)}>
                        {row.state === "installing" || row.state === "ready"
                          ? `${formatBytes(row.completedBytes)}${row.bytes > 0 ? ` / ${formatBytes(row.bytes)}` : ""}`
                          : ROW_LABELS[row.state]}
                      </span>
                      {row.state === "error" ? (
                        <span {...stylex.props(onboarding.rowActions)}>
                          <Button onClick={() => onRetry(row.mapVersionId)} type="button" variant="outline">
                            <RotateCcw {...stylex.props(onboarding.iconSmall, onboarding.iconWithLabel)} aria-hidden="true" />
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
                        {...stylex.props(installRows.track)}
                        role="progressbar"
                      >
                        <div
                          {...stylex.props(installRows.fill)}
                          style={{ [PROGRESS_VAR]: `${percent}%` } as CSSProperties}
                        />
                      </div>
                    ) : null}
                    {row.message ? (
                      <p {...stylex.props(installRows.rowMessage)} role="alert">
                        {row.message}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>

        <aside {...stylex.props(onboarding.sidebar)}>
          <fieldset disabled={downloading}>
            <legend {...stylex.props(onboarding.legend)}>Graphics level</legend>
            <div {...stylex.props(onboarding.qualityList)}>
              {SCENARIO_AUTHORING_QUALITY_CHOICES.map((choice) => (
                <label
                  key={choice.id}
                  {...stylex.props(
                    onboarding.qualityOption,
                    quality === choice.id
                      ? onboarding.qualityOptionSelected
                      : onboarding.qualityOptionIdle,
                  )}
                  data-testid="onboarding-quality-option"
                  data-quality={choice.id}
                  data-selected={quality === choice.id || undefined}
                >
                  <input
                    checked={quality === choice.id}
                    {...stylex.props(onboarding.radio)}
                    name="onboarding-quality"
                    onChange={() => onQualityChange(choice.id)}
                    type="radio"
                  />
                  <span {...stylex.props(onboarding.mapCardText)}>
                    <span {...stylex.props(onboarding.qualityLabel)}>
                      {choice.label}
                      {choice.recommended ? (
                        <span {...stylex.props(onboarding.recommendedTag)}>Recommended</span>
                      ) : null}
                    </span>
                    <span {...stylex.props(onboarding.qualityGuidance)}>{choice.gpuMemoryGuidance}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <p {...stylex.props(onboarding.qualityFootnote)}>
            The graphics level changes what the viewer keeps in memory, not what is downloaded: a map is
            one content-addressed set of files. You can change it any time in Settings.
          </p>

          <dl {...stylex.props(onboarding.summary)}>
            <div {...stylex.props(onboarding.summaryRow)}>
              <dt {...stylex.props(onboarding.summaryTerm)}>Selected</dt>
              <dd {...stylex.props(onboarding.summaryValue)} data-testid="onboarding-selected-bytes">
                {selectedMaps.length} {selectedMaps.length === 1 ? "map" : "maps"} · {formatBytes(selectedBytes)}
              </dd>
            </div>
            <div {...stylex.props(onboarding.summaryRow)}>
              <dt {...stylex.props(onboarding.summaryTerm)}>Free disk</dt>
              <dd {...stylex.props(onboarding.summaryValue)} data-testid="onboarding-free-bytes">
                {freeBytes === null ? "Unknown" : formatBytes(freeBytes)}
              </dd>
            </div>
          </dl>

          {error ? (
            <p {...stylex.props(onboarding.errorNote)} role="alert">
              {error}
            </p>
          ) : null}
          {guard.reason && !downloading ? (
            <p {...stylex.props(onboarding.blockedNote)} data-testid="onboarding-download-blocked">
              {guard.reason}
            </p>
          ) : null}

          <Button
            xstyle={onboarding.downloadAction}
            data-testid="onboarding-download"
            disabled={loading || downloading || guard.blocked}
            onClick={onDownload}
            type="button"
          >
            {downloading ? (
              <>
                <LoaderCircle {...stylex.props(onboarding.icon, onboarding.iconWithLabel, onboarding.spinner)} aria-hidden="true" />
                Downloading…
              </>
            ) : (
              <>
                <Download {...stylex.props(onboarding.icon, onboarding.iconWithLabel)} aria-hidden="true" />
                Download and continue
              </>
            )}
          </Button>
        </aside>
      </div>
    </main>
  );
}
