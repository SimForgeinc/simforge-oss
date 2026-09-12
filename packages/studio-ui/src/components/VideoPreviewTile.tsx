"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { mergeStyleProps } from "./stylex/surface";
import { styles } from "./VideoPreviewTile.stylex";
import { useVideoGroupContext } from "./VideoGroupPlayer";

export function VideoPreviewTile({
  label,
  videoUrl,
  posterUrl,
  eyebrow,
  badge,
  className,
  emptyLabel = "No video",
  maxRetries = 3,
  preload,
  onError,
}: {
  label: string;
  videoUrl: string | null;
  posterUrl?: string | null;
  eyebrow?: string;
  badge?: ReactNode;
  className?: string;
  emptyLabel?: string;
  maxRetries?: number;
  preload?: "none" | "metadata" | "auto";
  onError?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const progressRef = useRef<HTMLDivElement | null>(null);
  const [hovering, setHovering] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [progress, setProgress] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const wasPlayingBeforeScrub = useRef(false);
  const retryCount = useRef(0);
  const lastUrl = useRef(videoUrl);
  const group = useVideoGroupContext();
  const synced = Boolean(group);

  const videoCallbackRef = useCallback(
    (el: HTMLVideoElement | null) => {
      if (videoRef.current) group?.unregister(videoRef.current);
      videoRef.current = el;
      if (el) group?.register(el);
    },
    [group],
  );

  useEffect(() => {
    if (videoUrl === lastUrl.current) return;
    lastUrl.current = videoUrl;
    retryCount.current = 0;
    setHasError(false);
    setProgress(0);
  }, [videoUrl]);

  useEffect(() => {
    if (!scrubbing) return;

    function handleMove(event: MouseEvent) {
      seekToPosition(event.clientX);
    }

    function handleEnd() {
      setScrubbing(false);
      if (
        videoRef.current &&
        wasPlayingBeforeScrub.current &&
        hovering &&
        !hasError
      ) {
        void videoRef.current.play().catch(() => undefined);
      }
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleEnd);
    }

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleEnd);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleEnd);
    };
  }, [hasError, hovering, scrubbing]);

  function handleEnter() {
    setHovering(true);
    if (synced) return;
    if (videoRef.current && videoUrl && !hasError && !scrubbing) {
      void videoRef.current.play().catch(() => undefined);
    }
  }

  function handleLeave() {
    if (scrubbing) return;
    setHovering(false);
    if (synced) return;
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
    setProgress(0);
  }

  function handleTimeUpdate() {
    if (synced) return;
    const video = videoRef.current;
    if (!video?.duration || scrubbing) return;
    setProgress(video.currentTime / video.duration);
  }

  function handleError() {
    if (retryCount.current < maxRetries && videoRef.current && videoUrl) {
      retryCount.current += 1;
      window.setTimeout(() => {
        if (!videoRef.current || !videoUrl) return;
        videoRef.current.src = videoUrl;
        videoRef.current.load();
      }, retryCount.current * 1000);
      return;
    }

    setHasError(true);
    onError?.();
  }

  function blockContextMenu(event: ReactMouseEvent) {
    event.preventDefault();
  }

  function seekToPosition(clientX: number) {
    const video = videoRef.current;
    const progressEl = progressRef.current;
    if (!video?.duration || !progressEl) return;

    const rect = progressEl.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    video.currentTime = ratio * video.duration;
    setProgress(ratio);
  }

  function handleScrubStart(event: ReactMouseEvent<HTMLDivElement>) {
    if (!videoRef.current) return;
    event.preventDefault();
    wasPlayingBeforeScrub.current = !videoRef.current.paused;
    videoRef.current.pause();
    setScrubbing(true);
    seekToPosition(event.clientX);
  }

  const showVideo = Boolean(videoUrl) && !hasError;

  return (
    <div
      {...mergeStyleProps(stylex.props(styles.root), className)}
      onMouseLeave={handleLeave}
      onContextMenu={blockContextMenu}
      role="figure"
    >
      {showVideo ? (
        <video
          ref={videoCallbackRef}
          {...stylex.props(styles.video)}
          src={videoUrl ?? undefined}
          poster={posterUrl ?? undefined}
          muted
          loop={!synced}
          playsInline
          preload={preload ?? (synced ? "auto" : posterUrl ? "none" : "metadata")}
          controlsList="nodownload"
          onContextMenu={blockContextMenu}
          onTimeUpdate={handleTimeUpdate}
          onError={handleError}
        >
          <track kind="captions" />
        </video>
      ) : null}

      <div {...stylex.props(styles.overlay)}>
        <div {...stylex.props(styles.labelWrap)}>
          {eyebrow ? <div {...stylex.props(styles.eyebrow)}>{eyebrow}</div> : null}
          <div {...stylex.props(styles.label)}>{label}</div>
        </div>
        {badge ? <div {...stylex.props(styles.badge)}>{badge}</div> : null}
      </div>

      {!synced && (
        <div
          ref={progressRef}
          {...stylex.props(
            styles.progressArea,
            scrubbing && styles.progressAreaScrubbing,
          )}
          onMouseDown={handleScrubStart}
        >
          <div
            {...stylex.props(
              styles.progressTrack,
              scrubbing && styles.progressTrackScrubbing,
            )}
          >
            <div
              {...stylex.props(styles.progress)}
              style={{ width: `${progress * 100}%` }}
            >
              <div {...stylex.props(styles.thumb, scrubbing && styles.thumbScrubbing)} />
            </div>
          </div>
        </div>
      )}

      {!showVideo ? (
        <div {...stylex.props(styles.empty)}>
          {hasError ? "Video unavailable" : emptyLabel}
        </div>
      ) : null}
    </div>
  );
}
