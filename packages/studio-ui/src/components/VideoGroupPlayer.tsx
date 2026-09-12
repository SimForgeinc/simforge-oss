"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
} from "react";
import * as stylex from "@stylexjs/stylex";
import { Pause, Play, RotateCcw } from "lucide-react";

import { mergeStyleProps } from "./stylex/surface";
import { styles } from "./VideoGroupPlayer.stylex";

interface VideoGroupContextValue {
  register: (el: HTMLVideoElement) => void;
  unregister: (el: HTMLVideoElement) => void;
}

const VideoGroupCtx = createContext<VideoGroupContextValue | null>(null);

export function useVideoGroupContext() {
  return useContext(VideoGroupCtx);
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function playableDuration(video: HTMLVideoElement | undefined) {
  const duration = video?.duration;
  return typeof duration === "number" && Number.isFinite(duration) && duration > 0
    ? duration
    : null;
}

function findTimingLeader(videos: HTMLVideoElement[]) {
  return videos.find((video) => playableDuration(video) != null) ?? videos[0];
}

export function VideoGroupPlayer({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const videosRef = useRef(new Set<HTMLVideoElement>());
  const [videoCount, setVideoCount] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const wasPlayingRef = useRef(false);
  const rafId = useRef(0);

  const register = useCallback((el: HTMLVideoElement) => {
    videosRef.current.add(el);
    setVideoCount(videosRef.current.size);
  }, []);

  const unregister = useCallback((el: HTMLVideoElement) => {
    videosRef.current.delete(el);
    setVideoCount(videosRef.current.size);
  }, []);

  // RAF loop: sync progress from leader video and auto-loop
  useEffect(() => {
    if (!playing) {
      cancelAnimationFrame(rafId.current);
      return;
    }

    function tick() {
      const videos = [...videosRef.current];
      const leader = findTimingLeader(videos);
      const leaderDuration = playableDuration(leader);
      if (leader && leaderDuration != null) {
        setProgress(leader.currentTime / leaderDuration);
        setDuration(leaderDuration);

        if (leader.ended) {
          for (const v of videos) {
            v.currentTime = 0;
            void v.play().catch(() => {});
          }
        }
      }
      rafId.current = requestAnimationFrame(tick);
    }

    rafId.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId.current);
  }, [playing]);

  // Update duration when video count changes; reset when all removed
  useEffect(() => {
    if (videoCount === 0) {
      setPlaying(false);
      setProgress(0);
      setDuration(0);
      return;
    }
    const leader = findTimingLeader([...videosRef.current]);
    const leaderDuration = playableDuration(leader);
    if (leaderDuration != null) setDuration(leaderDuration);
  }, [videoCount]);

  function seekAllTo(ratio: number) {
    const clamped = Math.max(0, Math.min(1, ratio));
    for (const v of videosRef.current) {
      if (v.duration) v.currentTime = clamped * v.duration;
    }
    setProgress(clamped);
  }

  function handlePlayPause() {
    if (playing) {
      for (const v of videosRef.current) v.pause();
      setPlaying(false);
    } else {
      for (const v of videosRef.current) void v.play().catch(() => {});
      setPlaying(true);
    }
  }

  function handleRestart() {
    seekAllTo(0);
    for (const v of videosRef.current) void v.play().catch(() => {});
    setPlaying(true);
  }

  function handleScrubStart(e: ReactMouseEvent<HTMLDivElement>) {
    e.preventDefault();
    wasPlayingRef.current = playing;
    if (playing) {
      for (const v of videosRef.current) v.pause();
      setPlaying(false);
    }
    setScrubbing(true);
    const bar = progressBarRef.current;
    if (bar) {
      const rect = bar.getBoundingClientRect();
      seekAllTo((e.clientX - rect.left) / rect.width);
    }
  }

  // Scrub drag handling
  useEffect(() => {
    if (!scrubbing) return;

    function handleMove(e: MouseEvent) {
      const bar = progressBarRef.current;
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      const ratio = Math.max(
        0,
        Math.min(1, (e.clientX - rect.left) / rect.width),
      );
      for (const v of videosRef.current) {
        if (v.duration) v.currentTime = ratio * v.duration;
      }
      setProgress(ratio);
    }

    function handleUp() {
      setScrubbing(false);
      if (wasPlayingRef.current) {
        for (const v of videosRef.current) void v.play().catch(() => {});
        setPlaying(true);
      }
    }

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [scrubbing]);

  const currentTime = duration * progress;
  const hasVideos = videoCount > 0;

  return (
    <VideoGroupCtx.Provider value={{ register, unregister }}>
      <div {...mergeStyleProps(stylex.props(styles.root), className)}>
        {hasVideos && (
          <div {...stylex.props(styles.toolbar)}>
            <button
              type="button"
              onClick={handlePlayPause}
              {...stylex.props(styles.control, styles.playControl)}
              aria-label={playing ? "Pause all" : "Play all"}
            >
              {playing ? (
                <Pause {...stylex.props(styles.playIcon)} />
              ) : (
                <Play
                  {...stylex.props(styles.playIcon, styles.playIconOffset)}
                />
              )}
            </button>

            <button
              type="button"
              onClick={handleRestart}
              {...stylex.props(styles.control, styles.restartControl)}
              aria-label="Restart"
            >
              <RotateCcw {...stylex.props(styles.restartIcon)} />
            </button>

            <span {...stylex.props(styles.elapsedTime)}>
              {formatTime(currentTime)}
            </span>

            <div
              ref={progressBarRef}
              {...stylex.props(
                styles.scrubArea,
                scrubbing && styles.scrubbing,
              )}
              onMouseDown={handleScrubStart}
            >
              <div {...stylex.props(styles.scrubTrack)}>
                <div
                  {...stylex.props(styles.scrubProgress)}
                  style={{ width: `${progress * 100}%` }}
                >
                  <div {...stylex.props(styles.scrubThumb)} />
                </div>
              </div>
            </div>

            <span {...stylex.props(styles.durationTime)}>
              {formatTime(duration)}
            </span>
          </div>
        )}

        <div {...stylex.props(styles.body)}>{children}</div>
      </div>
    </VideoGroupCtx.Provider>
  );
}
