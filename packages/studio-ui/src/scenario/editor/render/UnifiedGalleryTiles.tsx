"use client";

import { useStudioHost } from "../../../host";
import type { ScenarioValidationRunDto } from "@simforge-oss/studio-host";
import { useEffect, useRef, useState } from "react";
import { Download, Film, FlaskConical } from "lucide-react";
import { cn } from "../../../lib/utils";
import { getBrowserRecordingClient as getBrowserRecording } from "../../../lib/scenario/recording-client";
import { useNearViewport } from "./useArtifactPreviewUrl";
import { formatTimestamp } from "./render-view-model";
import type { BrowserRecordingSummaryDto } from "../../../lib/scenario/recording-contracts";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./UnifiedGalleryTiles.stylex";
import { motionStyles } from "../../../stylex/motion.stylex";

/**
 * The non-managed cards of the unified render gallery. They share the managed tile's card anatomy —
 * aspect-video, tag chips top-left, gradient footer — so every render kind reads as one gallery
 * rather than three stacked sections.
 */

/**
 * A tile's state chip: its word and its tone. `className` exists for the one
 * tone whose plate is still the `render-chip` global rather than a token.
 */
type StateChip = { label: string; style: stylex.StyleXStyles; className?: string };

const RECORDING_STATE_CHIP: Record<BrowserRecordingSummaryDto["status"], StateChip> = {
  running: { label: "Running", style: styles.chipRunning },
  succeeded: { label: "Done", style: styles.chipSucceeded },
  failed: { label: "Failed", style: styles.chipFailed },
  cancelled: { label: "Cancelled", style: styles.chipCancelled, className: "render-chip" },
};

export function RecordingGalleryTile({
  recording,
  onOpen,
}: {
  recording: BrowserRecordingSummaryDto;
  onOpen: () => void;
}) {
  const [cardRef, nearViewport] = useNearViewport<HTMLDivElement>();
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [artifactRoles, setArtifactRoles] = useState<readonly string[]>([]);
  const [detailLoaded, setDetailLoaded] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // The recording summary DTO deliberately carries no artifact URLs, so the hover-play preview is
  // resolved lazily — one detail read per finished tile, and only once it nears the viewport.
  useEffect(() => {
    if (!nearViewport || recording.status !== "succeeded" || detailLoaded) return;
    const abort = new AbortController();
    void getBrowserRecording(recording.id, abort.signal)
      .then((detail) => {
        const video = detail.artifacts.find((artifact) => artifact.role === "video" && artifact.downloadUrl);
        if (abort.signal.aborted) return;
        setArtifactRoles(detail.artifacts.map((artifact) => artifact.role));
        setDetailLoaded(true);
        if (video?.downloadUrl) setVideoUrl(video.downloadUrl);
      })
      .catch(() => {
        if (!abort.signal.aborted) setDetailLoaded(true);
      });
    return () => abort.abort();
  }, [detailLoaded, nearViewport, recording.id, recording.status]);

  function play() {
    if (!videoUrl) return;
    window.requestAnimationFrame(() => {
      const result = videoRef.current?.play();
      if (result && typeof result.catch === "function") void result.catch(() => undefined);
    });
  }

  function reset() {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.currentTime = 0;
  }

  const chip = RECORDING_STATE_CHIP[recording.status];
  const progressPercent = Math.round(recording.progress * 100);

  return (
    <div
      ref={cardRef}
      className={
        /*
         * No motion style here: `render-surface-motion` declares the same three
         * transition properties over geometry and compositing at 420ms, and being
         * unlayered it already overrode the editor's colour transition on this
         * element — which is the point, since what moves on a tile is the lift
         * and the blur, not a colour. Both carried the same reduced-motion guard.
         */
        cn(
          stylex.props(
            styles.relFlexCol4,
            recording.status === "failed" ? styles.borderDestructive60 : styles.hoverBorderPrimary60,
          ).className,
          // `render-surface-motion` and `render-lift` are global motion rules in
          // `styles.css`, applied by name and reduced-motion guarded there; a
          // failed tile does not lift. No `group` marker: nothing reads one here.
          "render-surface-motion",
          recording.status === "failed" ? null : "render-lift",
        )
      }
      data-testid="scenario-recording-tile"
      data-recording-id={recording.id}
      onMouseEnter={play}
      onMouseLeave={reset}
    >
      <button
        type="button"
        aria-label={`Open Three.js recording from ${formatTimestamp(recording.createdAt)}`}
        {...stylex.props(styles.absInset0Raised)}
        onClick={onOpen}
        onFocus={play}
        onBlur={reset}
      />

      <div {...stylex.props(styles.absInset0)}>
        {videoUrl ? (
          <video
            ref={videoRef}
            aria-hidden="true"
            {...stylex.props(styles.fullCover)}
            loop
            muted
            playsInline
            preload="metadata"
            src={videoUrl}
          >
            <track kind="captions" />
          </video>
        ) : (
          <div {...stylex.props(styles.gridCenteredFull)}>
            <Film aria-hidden="true" className={stylex.props(styles.size6TextMutedForeground50).className} strokeWidth={1.5} />
          </div>
        )}
      </div>

      <div {...stylex.props(styles.absFlexCenter)}>
        <span {...stylex.props(styles.capsMicro)}>
          Three.js clip
        </span>
        <span className={cn(stylex.props(styles.capsMicro2, chip.style).className, chip.className)}>
          {chip.label}
        </span>
        {artifactRoles.includes("frames") ? (
          <span {...stylex.props(styles.capsMicro)}>
            Frames
          </span>
        ) : null}
        {artifactRoles.includes("sensor_archive") ? (
          <span {...stylex.props(styles.capsMicro)}>
            {artifactRoles.filter((role) => role === "sensor_archive").length} sensor archives
          </span>
        ) : null}
        {artifactRoles.includes("sensor_video") ? (
          <span {...stylex.props(styles.capsMicro)}>
            {artifactRoles.filter((role) => role === "sensor_video").length} sensor videos
          </span>
        ) : null}
      </div>

      <div {...stylex.props(styles.absFlexCol)}>
        {recording.status === "running" ? (
          <div
            aria-label="Recording progress"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={progressPercent}
            {...stylex.props(styles.renderChipH1)}
            role="progressbar"
          >
            <div {...stylex.props(styles.tall)} style={{ width: `${Math.max(2, progressPercent)}%` }} />
          </div>
        ) : null}
        <div {...stylex.props(styles.flexBetweenBaseline)}>
          <span {...stylex.props(styles.metaInkTruncate)}>{formatTimestamp(recording.createdAt)}</span>
          {recording.status === "running" ? (
            <span {...stylex.props(styles.tightCapsMicro)}>
              {progressPercent}%
            </span>
          ) : null}
        </div>
        {recording.failureCode ? (
          <p {...stylex.props(styles.microDanger)}>
            {recording.failureCode.replaceAll("_", " ")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

const ESMINI_STATE_CHIP: Record<string, StateChip> = {
  passed: { label: "Done", style: styles.chipSucceeded },
  running: { label: "Running", style: styles.chipRunning },
  queued: { label: "Queued", style: styles.chipQueued },
  failed: { label: "Failed", style: styles.chipFailed },
  errored: { label: "Failed", style: styles.chipFailed },
};

export function EsminiGalleryTile({ run }: { run: ScenarioValidationRunDto }) {
  const studioHost = useStudioHost();
  const chip = ESMINI_STATE_CHIP[run.validation_state] ?? {
    label: run.validation_state,
    style: styles.chipQueued,
  };
  const summary = (run.summary ?? {}) as {
    esmini?: { entities?: string[]; durationS?: number };
  };
  const detail = summary.esmini
    ? `${summary.esmini.entities?.length ?? 0} entities · ${summary.esmini.durationS ?? 0}s`
    : null;

  const failed = run.validation_state === "failed" || run.validation_state === "errored";

  return (
    <div
      className={cn(
        stylex.props(styles.relFlexCol2, failed ? styles.borderDestructive60 : styles.hoverBorderPrimary60).className,
        // Same two global motion classes as the recording tile above, applied by
        // name from `styles.css` and reduced-motion guarded there.
        "render-surface-motion",
        failed ? null : "render-lift",
      )}
      data-testid="scenario-esmini-tile"
      data-esmini-run-state={run.validation_state}
    >
      <div {...stylex.props(styles.absGridCentered)}>
        <FlaskConical aria-hidden="true" className={stylex.props(styles.size6TextMutedForeground50).className} strokeWidth={1.5} />
      </div>

      <div {...stylex.props(styles.absFlexCenter)}>
        <span {...stylex.props(styles.capsMicro)}>
          esmini replay
        </span>
        <span {...stylex.props(styles.capsMicro2, chip.style)}>
          {chip.label}
        </span>
      </div>

      <div {...stylex.props(styles.absFlexCol2)}>
        <div {...stylex.props(styles.flexBetweenBaseline)}>
          <span {...stylex.props(styles.metaInkTruncate)}>{formatTimestamp(run.created_at)}</span>
          {detail ? (
            <span {...stylex.props(styles.tightCapsMicro)}>{detail}</span>
          ) : null}
        </div>
        {run.trace_artifact_id || run.report_artifact_id ? (
          <div {...stylex.props(styles.flexCenterGap15)}>
            {run.trace_artifact_id ? (
              <button
                className={stylex.props(styles.inlineFlexCenterCaps, motionStyles.editorMotion).className}
                onClick={() => void studioHost.artifacts.downloadArtifact(run.trace_artifact_id!)}
                type="button"
              >
                <Download aria-hidden="true" className={stylex.props(styles.size3).className} />
                Trace
              </button>
            ) : null}
            {run.report_artifact_id ? (
              <button
                className={stylex.props(styles.inlineFlexCenterCaps, motionStyles.editorMotion).className}
                onClick={() => void studioHost.artifacts.downloadArtifact(run.report_artifact_id!)}
                type="button"
              >
                <Download aria-hidden="true" className={stylex.props(styles.size3).className} />
                Report
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
