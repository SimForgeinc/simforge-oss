"use client";

import { useRef } from "react";
import { Camera, EyeOff, Film, Sparkles, Undo2 } from "lucide-react";
import { cn } from "../../../lib/utils";
import { RenderProgressBar, RenderStateChip } from "./RenderStatePieces";
import {
  activeRetry,
  formatTimestamp,
  galleryItemAccessibleName,
  isPostprocessMode,
  jobFailureMessage,
  renderJobLabel,
} from "./render-view-model";
import { useArtifactPreviewUrl, useNearViewport } from "./useArtifactPreviewUrl";
import type { ScenarioGalleryItemDto } from "@simforge-oss/studio-host";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./RenderGalleryTile.stylex";
import { motionStyles } from "../../../stylex/motion.stylex";

/**
 * One render in the gallery — manifest #137, reshaped onto v2's control plane.
 *
 * v1's card carried a queue tier, an executor profile, a planned-camera count and a live log tail,
 * all of which came from `RuntimeJobRecord`. v2's gallery DTO deliberately carries none of that: it is
 * the narrow list DTO, and widening it to avoid a details fetch is exactly what a test forbids. So the
 * tile shows what the list *does* know — mode, state, progress, attempt count, artifact count,
 * lineage — and everything else lives one click away in the details panel.
 *
 * The hover-to-play preview is ported: poster until hover, then a muted looping `<video>`. It plays
 * on focus as well as hover so the affordance is not mouse-only.
 */
export function RenderGalleryTile({
  item,
  onOpen,
  onHide,
  hideBusy = false,
  outdated = false,
  onRestore,
  restoreBusy = false,
}: {
  item: ScenarioGalleryItemDto;
  /** Opens this render's own view. The gallery has no selected state: opening replaces it. */
  onOpen: () => void;
  onHide: () => void;
  hideBusy?: boolean;
  /** The scenario has changed since this render's snapshot was frozen. */
  outdated?: boolean;
  /** Restores this render's snapshot over the open draft. Omit to hide the affordance. */
  onRestore?: () => void;
  restoreBusy?: boolean;
}) {
  const [cardRef, nearViewport] = useNearViewport<HTMLDivElement>();
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const isVideoPreview = item.previewMediaType?.startsWith("video/") ?? false;
  const isImagePreview = item.previewMediaType?.startsWith("image/") ?? false;
  const previewUrl = useArtifactPreviewUrl(
    item.previewArtifactId,
    nearViewport && (isVideoPreview || isImagePreview),
  );

  const failure = jobFailureMessage(item);
  const retry = activeRetry(item);
  const postprocess = isPostprocessMode(item.jobMode);
  const label = renderJobLabel(item);

  function play() {
    if (!isVideoPreview || !previewUrl) return;
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

  return (
    <div
      ref={cardRef}
      className={cn(
        stylex.props(styles.relFlexCol, item.jobState === "failed" && styles.borderDestructive60).className,
        // Lift on hover. The gallery is a wall of near-identical stills, so the tile under the
        // pointer has to separate itself from its neighbours by more than a border colour.
        // Both classes are global motion rules in `styles.css`, applied by name and guarded
        // there by `prefers-reduced-motion` — the documented exception for shared motion.
        "render-surface-motion render-lift",
      )}
      data-testid="scenario-render-tile"
      data-render-job-id={item.id}
      onMouseEnter={play}
      onMouseLeave={reset}
    >
      {/* The whole tile is one button so the accessible name covers the picture and every chip; the
          hide control is a sibling, never nested, because a button inside a button is not focusable. */}
      <button
        type="button"
        aria-label={galleryItemAccessibleName(item)}
        {...stylex.props(styles.absInset0Raised)}
        onClick={onOpen}
        onFocus={play}
        onBlur={reset}
      />

      <div {...stylex.props(styles.absInset0)}>
        {previewUrl && isImagePreview ? (
          // A presigned S3 URL on a per-request signature: `next/image` would try to proxy and cache
          // it through the optimizer, which is the one thing a 1h signature must not go through.
          // eslint-disable-next-line @next/next/no-img-element
          <img alt="" aria-hidden="true" {...stylex.props(styles.fullCover)} src={previewUrl} />
        ) : previewUrl && isVideoPreview ? (
          <video
            ref={videoRef}
            aria-hidden="true"
            {...stylex.props(styles.fullCover)}
            loop
            muted
            playsInline
            poster={undefined}
            // metadata + a decoded first frame double as the poster; hover/focus starts playback.
            preload="metadata"
            src={previewUrl}
          >
            <track kind="captions" />
          </video>
        ) : (
          <div {...stylex.props(styles.gridCenteredFull)}>
            {postprocess ? (
              <Sparkles aria-hidden="true" className={stylex.props(styles.size6TextMutedForeground50).className} strokeWidth={1.5} />
            ) : item.previewArtifactId ? (
              <Film aria-hidden="true" className={stylex.props(styles.size6TextMutedForeground50).className} strokeWidth={1.5} />
            ) : (
              <Camera aria-hidden="true" className={stylex.props(styles.size6TextMutedForeground50).className} strokeWidth={1.5} />
            )}
          </div>
        )}
      </div>

      <div {...stylex.props(styles.absFlexCenter)}>
        <span {...stylex.props(styles.capsMicro)}>
          {label}
        </span>
        <RenderStateChip state={item.jobState} />
        {item.attemptCount > 1 ? (
          <span
            {...stylex.props(styles.capsMicroMuted)}
            title={`Attempt ${item.attemptCount}`}
          >
            ×{item.attemptCount}
          </span>
        ) : null}
        {postprocess && item.modelFamily ? (
          <span {...stylex.props(styles.capsMicroAccent)}>
            {item.modelFamily}
          </span>
        ) : null}
        {outdated ? (
          // The scenario moved on after this render. Stated on the tile rather than as a global
          // banner because it is a property of one render, and two renders of the same scenario can
          // disagree about it.
          <span
            {...stylex.props(styles.capsMicro2)}
            data-testid="scenario-render-outdated-pill"
            title="The scenario changed after this render. Its saved configuration can be restored."
          >
            Outdated
          </span>
        ) : null}
      </div>

      <button
        type="button"
        aria-label={`Hide this ${label.toLowerCase()} from the gallery`}
        className={stylex.props(styles.absInlineFlexCenter, motionStyles.editorMotion).className}
        disabled={hideBusy}
        onClick={onHide}
      >
        <EyeOff aria-hidden="true" className={stylex.props(styles.size35).className} />
      </button>

      {onRestore ? (
        <button
          type="button"
          aria-label={`Restore the scenario this ${label.toLowerCase()} was rendered from`}
          className={stylex.props(styles.absInlineFlexCenter2, motionStyles.editorMotion).className}
          data-testid="scenario-render-restore"
          disabled={restoreBusy}
          onClick={onRestore}
          title="Restore this render's saved scenario"
        >
          <Undo2 aria-hidden="true" className={stylex.props(styles.size35).className} />
        </button>
      ) : null}

      <div {...stylex.props(styles.absFlexCol)}>
        <RenderProgressBar
          label={`${label} progress`}
          progressPercent={item.progressPercent}
          state={item.jobState}
        />
        <div {...stylex.props(styles.flexBetweenBaseline)}>
          <span {...stylex.props(styles.metaInkTruncate)}>
            {formatTimestamp(item.createdAt)}
          </span>
          <span {...stylex.props(styles.tightCapsMicro)}>
            {item.artifactCount} {item.artifactCount === 1 ? "file" : "files"}
          </span>
        </div>
        {retry ? (
          <p {...stylex.props(styles.microInkSemibold)} data-testid="scenario-render-retry">
            Retrying · attempt {retry.attempt} {retry.phase}
          </p>
        ) : failure ? (
          <p {...stylex.props(styles.microDanger)}>{failure}</p>
        ) : null}
      </div>
    </div>
  );
}
