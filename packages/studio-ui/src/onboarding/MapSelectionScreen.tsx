"use client";

import type { CSSProperties, ReactNode } from "react";
import { Check, CircleAlert, Download, LoaderCircle, Lock, RotateCcw, SkipForward } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { Button } from "../components/ui/button";
import { SCENARIO_AUTHORING_QUALITY_CHOICES, type ScenarioAuthoringQuality } from "../lib/scenario/contracts";
import { formatBytes } from "../scenario/scene/map-load-progress";
import { evaluateMapDownloadGuard } from "./disk-guard";
import { installRows, onboarding, PROGRESS_VAR } from "./onboarding.stylex";

/**
 * The second onboarding step: which maps to download now, and at which
 * graphics level. Renders into the same column as Welcome, over the same
 * hero, so pressing "Continue locally" swaps the copy and the controls rather
 * than opening a different page. Props only — the host app owns the catalog,
 * the disk status, the install loop and the navigation that follows.
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
  /**
   * Part of every installation: the public Richmond Field Station map. It is
   * listed as included rather than offered as a choice, so a first run always
   * ends with at least one map to open.
   */
  required: boolean;
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
  catalogError,
  preparation,
  onDownload,
  onRetry,
  onSkip,
  signedIn,
  signIn,
}: {
  maps: readonly OnboardingMapOption[];
  selection: readonly string[];
  onToggle: (mapVersionId: string) => void;
  quality: ScenarioAuthoringQuality;
  onQualityChange: (quality: ScenarioAuthoringQuality) => void;
  freeBytes: number | null;
  loading: boolean;
  error: string | null;
  /**
   * Why the list may be shorter than promised: the Cloud did not answer for
   * the catalog. Shown in place of the list when there is nothing to list.
   */
  catalogError: string | null;
  preparation: OnboardingPreparation;
  onDownload: () => void;
  onRetry: (mapVersionId: string) => void;
  onSkip: (mapVersionId: string) => void;
  /** A SimCloud session is active: every published map is selectable. */
  signedIn: boolean;
  /**
   * The host's sign-in flow, rendered inline beneath the actions while
   * signed out, so unlocking the account maps never leaves this page.
   */
  signIn?: ReactNode;
}) {
  const selectedMaps = maps.filter(
    (map) => !map.locked && (map.required || selection.includes(map.mapVersionId)),
  );
  const selectedBytes = selectedMaps.reduce((total, map) => total + (map.bytes ?? 0), 0);
  const guard = evaluateMapDownloadGuard({
    selectedBytes,
    selectedCount: selectedMaps.length,
    freeBytes,
  });
  const lockedCount = maps.filter((map) => map.locked).length;
  const downloading = preparation.phase === "installing" || preparation.phase === "blocked";
  const empty = !loading && maps.length === 0;
  const selectedChoice = SCENARIO_AUTHORING_QUALITY_CHOICES.find((choice) => choice.id === quality);

  return (
    <section data-testid="onboarding-maps" data-phase={preparation.phase}>
      <p {...stylex.props(onboarding.eyebrow)}>Step 2 of 3</p>
      <h1 {...stylex.props(onboarding.welcomeTitle)}>Set up your maps</h1>
      <p {...stylex.props(onboarding.welcomeLede)}>
        Richmond Field Station is free and comes with every installation. Maps are downloaded once
        and shared by the editor, the viewer and local rendering; more can be added later from the
        map gallery.
      </p>

      {loading ? (
        <p {...stylex.props(onboarding.catalogLoading)}>
          <LoaderCircle {...stylex.props(onboarding.icon, onboarding.spinner)} aria-hidden="true" />
          Loading the map catalog…
        </p>
      ) : empty ? (
        <p {...stylex.props(onboarding.cautionNote)} role="alert" data-testid="onboarding-catalog-empty">
          {catalogError
            ? `SimCloud did not publish the free Richmond Field Station map (${catalogError}). Check the connection and try again, or sign in.`
            : "SimCloud published no maps for this installation."}
        </p>
      ) : (
        <ul {...stylex.props(onboarding.mapList)} data-testid="onboarding-map-list">
          {maps.map((map) => {
            const checked = !map.locked && (map.required || selection.includes(map.mapVersionId));
            const Row = map.required ? "div" : "label";
            return (
              <li key={map.mapVersionId}>
                <Row
                  {...stylex.props(
                    onboarding.mapRow,
                    map.locked
                      ? onboarding.mapRowLocked
                      : map.required
                        ? onboarding.mapRowIncluded
                        : checked
                          ? onboarding.mapRowSelected
                          : onboarding.mapRowIdle,
                  )}
                  data-testid="onboarding-map-card"
                  data-map-version-id={map.mapVersionId}
                  data-locked={map.locked || undefined}
                  data-required={map.required || undefined}
                  data-selected={checked || undefined}
                >
                  <span {...stylex.props(onboarding.mapRowControl)}>
                    {map.required ? (
                      <Check {...stylex.props(onboarding.icon, onboarding.iconAccent)} aria-hidden="true" />
                    ) : map.locked ? (
                      <Lock {...stylex.props(onboarding.iconSmall, onboarding.iconMuted)} aria-hidden="true" />
                    ) : (
                      <input
                        checked={checked}
                        {...stylex.props(onboarding.checkbox)}
                        disabled={downloading}
                        onChange={() => onToggle(map.mapVersionId)}
                        type="checkbox"
                      />
                    )}
                  </span>
                  <span {...stylex.props(onboarding.mapRowThumbnail)}>
                    {map.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- host-served thumbnail, no loader needed
                      <img alt="" {...stylex.props(onboarding.thumbnailImage)} src={map.thumbnailUrl} />
                    ) : null}
                  </span>
                  <span {...stylex.props(onboarding.mapCardText)}>
                    <span {...stylex.props(onboarding.mapCardLabel)}>{map.label}</span>
                    <span {...stylex.props(onboarding.mapCardLocality)}>
                      {map.locality ?? "Unknown locality"}
                    </span>
                  </span>
                  <span {...stylex.props(onboarding.mapRowMeta)}>
                    {map.required ? (
                      <span {...stylex.props(onboarding.includedTag)}>Included</span>
                    ) : map.locked ? (
                      <span {...stylex.props(onboarding.lockedTag)}>Sign in to unlock</span>
                    ) : null}
                    <span {...stylex.props(onboarding.mapCardSize)}>
                      {map.bytes === null ? "—" : formatBytes(map.bytes)}
                    </span>
                  </span>
                </Row>
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

      <fieldset {...stylex.props(onboarding.qualityField)} disabled={downloading}>
        <legend {...stylex.props(onboarding.legend)}>Graphics level</legend>
        <div {...stylex.props(onboarding.qualitySegments)} role="radiogroup" aria-label="Graphics level">
          {SCENARIO_AUTHORING_QUALITY_CHOICES.map((choice) => (
            <label
              key={choice.id}
              {...stylex.props(
                onboarding.qualitySegment,
                quality === choice.id ? onboarding.qualitySegmentSelected : onboarding.qualitySegmentIdle,
              )}
              data-testid="onboarding-quality-option"
              data-quality={choice.id}
              data-selected={quality === choice.id || undefined}
            >
              <input
                checked={quality === choice.id}
                {...stylex.props(onboarding.srOnly)}
                name="onboarding-quality"
                onChange={() => onQualityChange(choice.id)}
                type="radio"
              />
              {choice.label}
              {choice.recommended ? (
                <span {...stylex.props(onboarding.recommendedTag)}>Recommended</span>
              ) : null}
            </label>
          ))}
        </div>
        <p {...stylex.props(onboarding.qualityGuidance)}>
          {selectedChoice?.gpuMemoryGuidance} The level changes what the viewer keeps in memory, not
          what is downloaded; change it any time in Settings.
        </p>
      </fieldset>

      <dl {...stylex.props(onboarding.summaryLine)}>
        <dt {...stylex.props(onboarding.summaryTerm)}>Download</dt>
        <dd {...stylex.props(onboarding.summaryValue)} data-testid="onboarding-selected-bytes">
          {selectedMaps.length} {selectedMaps.length === 1 ? "map" : "maps"} · {formatBytes(selectedBytes)}
        </dd>
        <dt {...stylex.props(onboarding.summaryTerm)}>Free disk</dt>
        <dd {...stylex.props(onboarding.summaryValue)} data-testid="onboarding-free-bytes">
          {freeBytes === null ? "Unknown" : formatBytes(freeBytes)}
        </dd>
      </dl>

      {error ? (
        <p {...stylex.props(onboarding.errorNote)} role="alert">
          {error}
        </p>
      ) : null}
      {guard.reason && !downloading && !empty ? (
        <p {...stylex.props(onboarding.blockedNote)} data-testid="onboarding-download-blocked">
          {guard.reason}
        </p>
      ) : null}

      <div {...stylex.props(onboarding.welcomeActions)}>
        <Button
          autoFocus
          xstyle={onboarding.primaryAction}
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
      </div>
      {signIn ? (
        <div {...stylex.props(onboarding.signInSlot)} data-testid="onboarding-locked-notice">
          {signIn}
        </div>
      ) : null}
      <p {...stylex.props(onboarding.footnote)}>
        {signedIn
          ? "Every map your account can read is listed; untick the ones you do not need yet."
          : lockedCount > 0
            ? `Sign in to unlock ${lockedCount} more ${lockedCount === 1 ? "map" : "maps"} from your SimCloud account.`
            : "Sign in any time to add the maps in your SimCloud account."}
      </p>
    </section>
  );
}
