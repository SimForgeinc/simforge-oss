"use client";

import type { CSSProperties, ReactNode } from "react";
import { Check, CircleAlert, Download, LoaderCircle, Lock, LogIn, RotateCcw, SkipForward } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { Button } from "../components/ui/button";
import { SCENARIO_AUTHORING_QUALITY_CHOICES, type ScenarioAuthoringQuality } from "../lib/scenario/contracts";
import { formatBytes } from "../scenario/scene/map-load-progress";
import { evaluateMapDownloadGuard } from "./disk-guard";
import { MapCard, MapGrid, type MapGridMap } from "./MapGrid";
import { installRows, onboarding, PROGRESS_VAR } from "./onboarding.stylex";

/**
 * The second onboarding step: which maps to download now, and at which
 * graphics level. Renders into the same column as Welcome, over the same
 * hero, so pressing "Continue locally" swaps the copy and the controls rather
 * than opening a different page. Props only — the host app owns the catalog,
 * the disk status, the install loop and the navigation that follows.
 */

export type OnboardingMapOption = MapGridMap & {
  /** An account map without a signed-in session: shown, not selectable. */
  locked: boolean;
  /**
   * Part of every installation: the public Richmond Field Station map. It is
   * listed as included rather than offered as a choice, so a first run always
   * ends with at least one map to open.
   */
  required: boolean;
  /**
   * The complete verified closure is already on this computer. Shown as
   * installed and left out of the download rather than offered again: the
   * bytes are here, and asking for them a second time is the whole complaint
   * this state answers.
   */
  installed: boolean;
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
  onSignIn,
  onCancelSignIn,
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
   * The host's sign-in flow, once the user has asked for it. Present, it
   * takes the place of the sign-in button beneath the actions, so unlocking
   * the account maps never leaves this page.
   */
  signIn?: ReactNode;
  /** Offered while signed out; reveals the inline flow in this column. */
  onSignIn: () => void;
  /**
   * Leaves the sign-in flow for the actions row again. Omitted while the
   * flow owns its own dismissal — the browser hop already offers Cancel, and
   * two of them beside each other would mean two different things.
   */
  onCancelSignIn?: () => void;
}) {
  // An installed map is not a download: its closure is on this computer
  // already, so it is left out of what "Download and continue" transfers.
  const selectedMaps = maps.filter(
    (map) => !map.locked && !map.installed && (map.required || selection.includes(map.mapVersionId)),
  );
  const selectedBytes = selectedMaps.reduce((total, map) => total + (map.bytes ?? 0), 0);
  // Nothing left to download is not a blocked selection: everything this
  // installation offers is already here, so the step continues instead of
  // asking for bytes it has.
  const nothingToDownload = selectedMaps.length === 0 && maps.some((map) => map.installed && !map.locked);
  const guard = nothingToDownload
    ? { blocked: false, reason: null }
    : evaluateMapDownloadGuard({
      selectedBytes,
      selectedCount: selectedMaps.length,
      freeBytes,
    });
  const lockedCount = maps.filter((map) => map.locked).length;
  const downloading = preparation.phase === "installing" || preparation.phase === "blocked";
  // A started download owns the list it began with, so the picker has
  // nothing left to offer: the progress rows take its place in the step's
  // one flexible region rather than being added below it.
  const started = preparation.phase !== "idle";
  const empty = !loading && maps.length === 0;
  const selectedChoice = SCENARIO_AUTHORING_QUALITY_CHOICES.find((choice) => choice.id === quality);

  return (
    <section
      {...stylex.props(onboarding.stepSection)}
      data-testid="onboarding-maps"
      data-phase={preparation.phase}
    >
      <header {...stylex.props(onboarding.stepHeader)}>
        <p {...stylex.props(onboarding.eyebrow)}>Step 2 of 3</p>
        <h1 {...stylex.props(onboarding.welcomeTitle)}>Set up your maps</h1>
        <p {...stylex.props(onboarding.welcomeLede)}>
          Richmond Field Station is free and comes with every installation. Maps are downloaded
          once and shared by the editor, the viewer and local rendering; more can be added later
          from the map gallery.
        </p>
      </header>

      {/* The step's one flexible region: the picker until a download starts,
          the progress of that download afterwards. It is sized by what the
          heading and the controls leave, so neither one can push the actions
          out of the viewport. */}
      <div {...stylex.props(onboarding.mapRegion)}>
        {started ? null : loading ? (
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
          <MapGrid testId="onboarding-map-list">
            {maps.map((map) => {
              const checked = !map.locked && !map.installed
                && (map.required || selection.includes(map.mapVersionId));
              return (
                <MapCard
                  as={map.locked || map.installed || map.required ? "div" : "label"}
                  control={
                    map.locked ? (
                      <Lock {...stylex.props(onboarding.iconSmall, onboarding.iconMuted)} aria-hidden="true" />
                    ) : map.installed || map.required ? (
                      <Check {...stylex.props(onboarding.iconSmall, onboarding.iconAccent)} aria-hidden="true" />
                    ) : (
                      <input
                        checked={checked}
                        {...stylex.props(onboarding.checkbox)}
                        disabled={downloading}
                        onChange={() => onToggle(map.mapVersionId)}
                        type="checkbox"
                      />
                    )
                  }
                  installed={map.installed}
                  key={map.mapVersionId}
                  locked={map.locked}
                  map={map}
                  required={map.required}
                  selected={checked}
                  tag={
                    map.installed ? (
                      <span {...stylex.props(onboarding.mapCardTag, onboarding.includedTag)}>
                        Installed
                      </span>
                    ) : map.locked ? (
                      <span {...stylex.props(onboarding.mapCardTag, onboarding.lockedTag)}>
                        Sign in to unlock
                      </span>
                    ) : map.required ? (
                      <span {...stylex.props(onboarding.mapCardTag, onboarding.includedTag)}>
                        Included
                      </span>
                    ) : null
                  }
                  testId="onboarding-map-card"
                />
              );
            })}
          </MapGrid>
        )}

        {started ? (
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
      </div>

      <div {...stylex.props(onboarding.stepFooter)}>
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
            {selectedChoice?.gpuMemoryGuidance} The installed release is the same at every level;
            the assets the viewer downloads and its GPU memory use can differ.
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
            ) : nothingToDownload ? (
              <>
                <Check {...stylex.props(onboarding.icon, onboarding.iconWithLabel)} aria-hidden="true" />
                Continue
              </>
            ) : (
              <>
                <Download {...stylex.props(onboarding.icon, onboarding.iconWithLabel)} aria-hidden="true" />
                Download and continue
              </>
            )}
          </Button>
          {signedIn || signIn ? null : (
            <Button
              xstyle={onboarding.secondaryAction}
              data-testid="onboarding-locked-notice"
              disabled={downloading}
              onClick={onSignIn}
              type="button"
              variant="outline"
            >
              <LogIn {...stylex.props(onboarding.icon, onboarding.iconWithLabel)} aria-hidden="true" />
              Sign in to SimCloud
            </Button>
          )}
        </div>
        {signIn ? (
          <div {...stylex.props(onboarding.signInSlot)} data-testid="onboarding-sign-in-flow">
            {signIn}
            {onCancelSignIn ? (
              <Button
                xstyle={onboarding.signInDismiss}
                data-testid="onboarding-sign-in-cancel"
                onClick={onCancelSignIn}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
            ) : null}
          </div>
        ) : null}
        <p {...stylex.props(onboarding.footnote)}>
          {signedIn
            ? "Every map your account can read is listed; untick the ones you do not need yet."
            : lockedCount > 0
              ? `Sign in to unlock ${lockedCount} more ${lockedCount === 1 ? "map" : "maps"} from your SimCloud account.`
              : "Sign in any time to add the maps in your SimCloud account."}
        </p>
      </div>
    </section>
  );
}
